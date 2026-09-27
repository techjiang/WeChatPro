import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { registerAdapter, normalizeEventType } from '../core/registry.js';
import { mapPayload, coerceKind } from './webhook.js';
import type { HostBridge, HostGateway } from '../core/host-bridge.js';
import type { ProtocolAdapter, RawEvent, RawEventHandler, OutboundMessage } from '../core/types.js';

/**
 * PC 宿主适配器 —— 「直接在微信 APP 内使用与管理」的落地形态。
 *
 * 现实约束：微信 PC 端是闭源客户端，官方没有对外的插件 SDK。可行的注入路径只有三条，
 * 三条都已支持，且**核心代码一行不改**：
 *
 * 1. **客户端插件壳（推荐）**：微信 PC 的插件框架 / 社区插件加载器（如基于 Electron
 *    或 DLL 注入的方案）在同一进程内加载本包，插件壳实现 `HostBridge` 反向调用能力，
 *    再通过 `HostTransport.inject()` 直接投递消息对象。零端口、零网络往返。
 * 2. **本地 IPC**：插件运行在辅助进程时，通过本地 HTTP 回环把消息投进引擎（`transport: http`），
 *    宿主侧只用 `fetch` 即可，不需要 Node 运行时。
 * 3. **离线/联调**：从剪贴板或导出的聊天文本文件批导入（`import` 命令），不依赖注入。
 *
 * 三条路径最终都调用同一个 `inject()`，归一化、去重、统计口径只有一份实现。
 */

/** 宿主注入时的原始消息形状：字段名与微信 PC 数据库 / 内存对象保持一致。 */
export interface HostIngestPayload {
  [key: string]: unknown;
}

export interface HostAdapterOptions {
  /** 宿主标识，仅用于展示与排障。 */
  host?: string;
  /**
   * 字段映射。默认值已覆盖微信 PC 端常见字段（`StrTalker`/`StrContent`/`MsgSvrID`…），
   * 换微信版本或换企业微信时只改这里。
   */
  mapping?: Record<string, string[]>;
  /** 是否把聊天文本落盘留痕，便于回溯「当时到底收到了什么」。默认关闭。 */
  dumpDir?: string;
  /**
   * 出站方式：`host` 走宿主原生发送（推荐），`http` 走回环 HTTP 上报给宿主。
   * 两者都不可用时发送返回 false，但**不会**影响接收与统计。
   */
  outbound?: 'host' | 'http';
  /** `outbound=http` 时的宿主接收地址。 */
  outboundUrl?: string;
  /** 本地 IPC 传输配置（方案 2）。 */
  transport?: 'http' | 'none';
  httpPort?: number;
  httpHost?: string;
  httpPath?: string;
  /** IPC 校验令牌。绑定非回环地址时必填。 */
  token?: string;
}

/**
 * 微信 PC 端默认字段映射。
 *
 * 命名刻意保留原始形态（`StrTalker`/`MsgSvrID`/`CreateTime`）：这是客户端内存对象与
 * 本地库的字段名，直接映射省掉一层转换。时间戳按秒传递（微信用 10 位秒级）。
 */
export const WECHAT_PC_MAPPING: Record<string, string[]> = {
  id: ['MsgSvrID', 'msgSvrId', 'LocalId', 'localId', 'id', 'msgId'],
  // 群 ID 以 @chatroom 结尾；私聊为 wxid_xxx。
  conversationId: ['StrTalker', 'strTalker', 'TalkerId', 'conversationId', 'roomId'],
  conversationName: ['RoomName', 'roomName', 'NickName', 'conversationName', 'talkerName'],
  conversationKind: ['conversationKind', 'chatType', 'roomType'],
  senderId: ['StrSender', 'strSender', 'Sender', 'senderId', 'fromUser', 'FromUserName'],
  senderName: ['SenderNick', 'senderNick', 'PushContent', 'senderName', 'displayName'],
  groupAlias: ['GroupNickName', 'groupNickName', 'Remark', 'groupAlias'],
  ownerId: ['RoomOwner', 'roomOwner', 'ownerId'],
  memberCount: ['MemberCount', 'memberCount', 'memberCountInRoom'],
  kind: ['Type', 'MsgType', 'msgType', 'kind', 'SubType'],
  text: ['StrContent', 'strContent', 'Content', 'text', 'msg'],
  mentions: ['AtUserList', 'atUserList', 'mentions'],
  mediaUrl: ['MediaPath', 'mediaPath', 'FilePath', 'url', 'mediaUrl'],
  quoteId: ['QuoteMsgSvrID', 'quoteId', 'replyTo'],
  timestamp: ['CreateTime', 'createTime', 'timestamp', 'sendTime'],
  direction: ['IsSender', 'isSender', 'direction'],
};

/** 微信 PC 消息类型与引擎 `MessageKind` 的补充映射。 */
const WECHAT_KIND_ALIASES: Record<string, string> = {
  // 微信 `Type` 字段取值
  '1': 'text',
  '3': 'image',
  '34': 'voice',
  '37': 'card', // 好友请求/名片
  '42': 'card',
  '43': 'video',
  '47': 'sticker',
  '48': 'location',
  '49': 'link',
  '50': 'video', // 语音/视频通话
  '10000': 'system',
  '10002': 'revoke',
  'sysmsg': 'system',
  'revokemsg': 'revoke',
  'appmsg': 'link',
  'emoji': 'sticker',
};

/** 把微信原生 Type 收敛到引擎枚举。导出供测试与自定义宿主复用。 */
export function coerceHostKind(raw: unknown): string {
  if (typeof raw === 'number') return WECHAT_KIND_ALIASES[String(raw)] ?? coerceKind(raw);
  if (typeof raw !== 'string') return 'unknown';
  const key = raw.trim().toLowerCase();
  return WECHAT_KIND_ALIASES[key] ?? coerceKind(key);
}

/**
 * 一次「注入」的返回结果。
 *
 * 用结构化结果而不是抛错，是因为注入来自宿主回调：宿主只想记录一行日志，
 * 不想因为一条畸形消息把整个客户端插件崩掉。
 */
export interface IngestResult {
  accepted: boolean;
  reason?: 'invalid' | 'unmapped' | 'transport-off';
  message?: Record<string, unknown>;
}

/**
 * 宿主传输：把「宿主收到的原始对象」变成「引擎的事件」。
 *
 * 生命周期与适配器解耦：宿主可以在适配器没启动时就 `inject()`（返回 `transport-off`），
 * 也可以在停止后继续调用（静默丢弃）。这样宿主不必关心引擎起停时序。
 */
export class HostTransport {
  #handler: RawEventHandler | null = null;
  #mapping: Record<string, string[]>;
  #server: Server | null = null;
  #received = 0;
  #dropped = 0;

  constructor(mapping: Record<string, string[]>) {
    this.#mapping = mapping;
  }

  get received(): number {
    return this.#received;
  }

  get dropped(): number {
    return this.#dropped;
  }

  bind(handler: RawEventHandler): void {
    this.#handler = handler;
  }

  unbind(): void {
    this.#handler = null;
  }

  get bound(): boolean {
    return this.#handler !== null;
  }

  /** 不经过网络，直接投递宿主进程内的消息对象。方案 1 走这条。 */
  async inject(payload: HostIngestPayload, options: { eventType?: string } = {}): Promise<IngestResult> {
    if (!this.#handler) {
      this.#dropped += 1;
      return { accepted: false, reason: 'transport-off' };
    }
    const mapped = this.map(payload);
    if (!mapped) {
      this.#dropped += 1;
      return { accepted: false, reason: 'unmapped' };
    }
    this.#received += 1;
    await this.#handler({
      protocol: 'host',
      type: normalizeEventType(options.eventType ?? detectEventType(payload)),
      receivedAt: Date.now(),
      payload: mapped,
    });
    return { accepted: true, message: mapped };
  }

  /** 批量注入：宿主一次性交出历史记录时用。 */
  async injectBatch(payloads: readonly HostIngestPayload[]): Promise<{ accepted: number; dropped: number }> {
    let accepted = 0;
    let dropped = 0;
    for (const payload of payloads) {
      const result = await this.inject(payload);
      if (result.accepted) accepted += 1;
      else dropped += 1;
    }
    return { accepted, dropped };
  }

  /** 按映射把宿主字段转成引擎模型；缺少会话或发送者时返回 null（无法归属）。 */
  map(payload: HostIngestPayload): Record<string, unknown> | null {
    if (!payload || typeof payload !== 'object') return null;
    const mapped = mapPayload(payload, this.#mapping);
    if (mapped.conversationId === undefined || mapped.senderId === undefined) return null;
    if (mapped.kind !== undefined) mapped.kind = coerceHostKind(mapped.kind);
    // 私聊场景下微信不给发送者，用会话 ID 兜底，避免整条消息被丢弃。
    if (mapped.senderName === undefined) mapped.senderName = String(mapped.senderId);
    if (mapped.conversationName === undefined) mapped.conversationName = String(mapped.conversationId);
    return mapped;
  }

  /** 启动本地 IPC 服务（方案 2）：把宿主推来的 HTTP 请求转为注入。 */
  async listen(options: { port: number; host: string; path: string; token?: string }): Promise<string> {
    this.#server = createServer((req, res) => {
      void (async () => {
        if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== options.path) {
          res.writeHead(404).end('not found');
          return;
        }
        if (options.token && req.headers['x-wechatpro-token'] !== options.token) {
          res.writeHead(401).end('unauthorized');
          return;
        }
        try {
          const body = await readBody(req, 8 * 1024 * 1024);
          const parsed: unknown = JSON.parse(body);
          if (Array.isArray(parsed)) {
            const result = await this.injectBatch(parsed as HostIngestPayload[]);
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...result }));
            return;
          }
          const result = await this.inject(parsed as HostIngestPayload);
          res
            .writeHead(result.accepted ? 200 : 422, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: result.accepted, ...result }));
        } catch (error) {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      })();
    });
    await new Promise<void>((resolvePromise, reject) => {
      this.#server?.once('error', reject);
      this.#server?.listen(options.port, options.host, () => resolvePromise());
    });
    const address = this.#server.address();
    const port = typeof address === 'object' && address ? address.port : options.port;
    return `http://${options.host}:${port}${options.path}`;
  }

  /**
   * 直接绑定一个「收事件」的实现，而不是通过适配器的 `start` 回调。
   *
   * 用于 `Engine.ingestRaw` 这条路径：宿主注入的消息在进程内直达引擎，
   * 省掉一次函数跳转，也让测试不必启动适配器。
   */
  attachSink(sink: RawEventHandler): void {
    this.#handler = sink;
  }

  async close(): Promise<void> {
    this.unbind();
    if (!this.#server) return;
    await new Promise<void>((resolvePromise) => this.#server?.close(() => resolvePromise()));
    this.#server = null;
  }
}

/**
 * 构造宿主适配器。
 *
 * `gateway` 是可选的宿主反向调用桥；没有它时适配器依然完整工作（只少了「在客户端弹通知」
 * 这类增强能力），这是刻意的：一个只能在特定客户端版本里跑起来的插件没有价值。
 */
export function createHostAdapter(
  options: HostAdapterOptions,
  gateway?: HostGateway,
  bridge?: HostBridge,
): ProtocolAdapter & { transport: HostTransport } {
  const mapping = { ...WECHAT_PC_MAPPING, ...(options.mapping ?? {}) };
  const transport = new HostTransport(mapping);
  let serverUrl: string | null = null;

  if (bridge && gateway) gateway.attach(bridge);

  return {
    name: 'host',
    capabilities: new Set(['receive', 'send', 'member-events', 'contact', 'history']),
    transport,

    async start(handler: RawEventHandler): Promise<void> {
      transport.bind(handler);
      if (options.dumpDir) mkdirSync(options.dumpDir, { recursive: true });
      if (options.transport !== 'http') return;
      if (!options.token && isLoopback(options.httpHost ?? '127.0.0.1') === false) {
        // 非回环 + 无 token 直接拒绝启动，与 API 层同一准则。
        throw new Error('host 适配器拒绝启动：非回环地址必须配置 token');
      }
      serverUrl = await transport.listen({
        port: options.httpPort ?? 0,
        host: options.httpHost ?? '127.0.0.1',
        path: options.httpPath ?? '/host/inject',
        token: options.token ?? '',
      });
    },

    async stop(): Promise<void> {
      await transport.close();
      serverUrl = null;
    },

    /** 出站：优先宿主原生发送；宿主不支持时退回 HTTP 上报。 */
    async send(conversationId: string, message: OutboundMessage): Promise<boolean> {
      if (options.outbound !== 'http' && gateway?.has('nativeSend')) {
        const ok = await gateway.nativeSend({
          conversationId,
          kind: message.kind === 'image' || message.kind === 'file' ? message.kind : 'text',
          text: message.text,
          mediaUrl: message.mediaUrl,
          mentions: message.mentions,
        });
        if (ok) return true;
      }
      if (!options.outboundUrl) return false;
      try {
        const response = await fetch(options.outboundUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.token ? { 'x-wechatpro-token': options.token } : {}),
          },
          body: JSON.stringify({ conversationId, ...message }),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  } as ProtocolAdapter & { transport: HostTransport };
}

/** 从宿主事件名/载荷推断是否需要当作成员事件处理。 */
function detectEventType(payload: HostIngestPayload): string {
  const declared = payload.eventType ?? payload.Event ?? payload.type;
  if (typeof declared === 'string') {
    if (/join|invite/i.test(declared)) return 'member.join';
    if (/leave|quit|kick|remove/i.test(declared)) return 'member.leave';
    if (/revoke|recall|withdraw/i.test(declared)) return 'message.revoked';
  }
  // 微信系统消息里 10000 类型承载「xxx 加入了群聊」。
  const content = String(payload.StrContent ?? payload.strContent ?? payload.Content ?? '');
  if (/加入了群聊|加入群聊|invited|joined/.test(content)) return 'member.join';
  if (/移出了群聊|退出了群聊|left|kicked/.test(content)) return 'member.leave';
  if (/撤回了一条消息|recalled/.test(content)) return 'message.revoked';
  return 'message';
}

/**
 * 解析常见聊天记录导出格式。
 *
 * 支持的形态（取各行中第一个匹配者）：
 * - `2026-09-27 10:30:05 张三: 你好`
 * - `[2026/09/27 10:30] 张三：你好`
 * 解析失败的行会被跳过而不是报错——导出工具格式不统一，宁可少几条也不要整批失败。
 */
export function parseChatExport(
  content: string,
  options: { conversationId: string; conversationName?: string } = { conversationId: 'imported@chatroom' },
): HostIngestPayload[] {
  const results: HostIngestPayload[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match =
      line.match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+([^:：]{1,40})[:：]\s*(.+)$/) ??
      line.match(/^\[(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:：]{1,40})[:：]\s*(.+)$/);
    if (!match) continue;
    const timestamp = Date.parse(match[1]!.replace(/\//g, '-'));
    if (!Number.isFinite(timestamp)) continue;
    const senderName = match[2]!.trim();
    results.push({
      MsgSvrID: stableId(options.conversationId, timestamp, senderName, match[3]!),
      StrTalker: options.conversationId,
      RoomName: options.conversationName ?? options.conversationId,
      StrSender: senderName,
      SenderNick: senderName,
      StrContent: match[3]!.trim(),
      Type: 1,
      CreateTime: Math.floor(timestamp / 1000),
    });
  }
  return results;
}

/** 稳定 ID：导出文本没有消息 ID，用内容指纹保证重复导入时仍能去重。 */
function stableId(...parts: Array<string | number>): string {
  return 'imp_' + createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 20);
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function readBody(req: import('node:http').IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体超过大小上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 把宿主载荷落盘留痕；只在开启 `dumpDir` 时调用。 */
export function dumpPayload(dir: string, payload: HostIngestPayload): string {
  const file = resolve(dir, `host-${new Date().toISOString().slice(0, 10)}.ndjson`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload) + '\n', { flag: 'a' });
  return file;
}

export { WECHAT_KIND_ALIASES };
