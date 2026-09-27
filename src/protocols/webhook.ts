import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { normalizeEventType, pick, toMillis } from '../core/registry.js';
import type { ProtocolAdapter, RawEventHandler, OutboundMessage } from '../core/types.js';

/**
 * 内置协议适配器。
 *
 * 只内置两个「通用底座」而不是绑死某家微信协议：
 *
 * - `mock`：测试与演示用，能按脚本投递消息，让统计/检测/AI 全链路可离线验证。
 * - `http-webhook`：接收任意微信中间件（本地 hook、协议网关、企业微信）推来的
 *   HTTP 事件。字段名通过 `mapping` 配置映射，因此接新协议不需要改代码。
 *
 * 真正对接私有协议时，按 `ProtocolAdapter` 实现并 `registerAdapter` 即可，
 * 不修改本文件——这是插件化的意义所在。
 */

const messageKinds = new Set([
  'text',
  'image',
  'voice',
  'video',
  'file',
  'link',
  'location',
  'card',
  'sticker',
  'system',
  'revoke',
  'redpacket',
  'transfer',
]);

function coerceKind(raw: unknown): string {
  // 协议普遍用数字表示消息类型（如微信 `MsgType: 1`），先转成字符串再查表，
  // 否则最常见的文本消息会全部落到 unknown，统计维度直接失真。
  if (typeof raw === 'number') return coerceKind(String(raw));
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.toLowerCase();
  if (messageKinds.has(value)) return value;
  // 协议常给数字/别名，做一层常见映射，避免全部落到 unknown 而丢统计维度。
  const aliases: Record<string, string> = {
    '1': 'text',
    '3': 'image',
    '34': 'voice',
    '43': 'video',
    '49': 'link',
    '42': 'card',
    '47': 'sticker',
    '10000': 'system',
    '10002': 'revoke',
    'textmessage': 'text',
    'pic': 'image',
    'picture': 'image',
    'emoji': 'sticker',
    'attachment': 'file',
  };
  return aliases[value] ?? 'unknown';
}

export interface MockAdapterOptions {
  /** 回放脚本：按 `intervalMs` 逐条投递。 */
  script?: Array<Partial<Record<string, unknown>>>;
  intervalMs?: number;
  /** 是否循环回放，演示面板时用。 */
  loop?: boolean;
}

export function buildMockAdapter(options: MockAdapterOptions): ProtocolAdapter {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  return {
    name: 'mock',
    capabilities: new Set(['receive']),
    async start(handler: RawEventHandler): Promise<void> {
      const script = options.script ?? [];
      const interval = options.intervalMs ?? 300;
      if (script.length === 0) return;
      let index = 0;

      const tick = (): void => {
        if (stopped) return;
        const item = script[index % script.length] as Record<string, unknown>;
        void handler({
          protocol: 'mock',
          type: normalizeEventType(String(item.type ?? 'message')),
          receivedAt: Date.now(),
          payload: item,
        });
        index += 1;
        if (!options.loop && index >= script.length) {
          // 非循环模式回放结束即停，避免测试里定时器泄漏。
          if (timer) clearInterval(timer);
          timer = null;
          return;
        }
      };

      timer = setInterval(tick, interval);
      tick();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export interface WebhookAdapterOptions {
  /** 监听端口。 */
  port?: number;
  host?: string;
  /** 校验令牌：请求头 `x-wechatpro-token` 必须匹配。 */
  token?: string;
  /** URL 路径，默认 `/webhook`。 */
  path?: string;
  /**
   * 字段映射：左侧是归一化字段名，右侧是原始载荷里的候选路径数组。
   * 例如 `{ conversationId: ['roomId', 'chat.id'] }`。
   */
  mapping?: Record<string, string[]>;
  /** 出站回调地址（适配器支持 send 时使用）。 */
  outboundUrl?: string;
}

const DEFAULT_MAPPING: Record<string, string[]> = {
  id: ['id', 'msgId', 'MsgId', 'messageId', 'msg_id', 'newMsgId'],
  conversationId: ['conversationId', 'roomId', 'chatId', 'groupId', 'FromUserName'],
  conversationName: ['conversationName', 'roomName', 'chatName', 'groupName'],
  conversationKind: ['conversationKind', 'chatType', 'roomType'],
  senderId: ['senderId', 'sender', 'fromUser', 'from', 'sender_id', 'FromUserName'],
  senderName: ['senderName', 'sender_nick', 'nickname', 'displayName', 'pushContent'],
  groupAlias: ['groupAlias', 'groupNickName', 'memberNickName'],
  ownerId: ['ownerId', 'roomOwner', 'owner'],
  memberCount: ['memberCount', 'memberCountInRoom'],
  kind: ['kind', 'type', 'msgType', 'MsgType', 'messageType'],
  text: ['text', 'content', 'msg', 'Content', 'message'],
  mentions: ['mentions', 'atList', 'atUsers', 'atuserlist'],
  quoteId: ['quoteId', 'replyTo', 'quoteMsgId'],
  mediaUrl: ['mediaUrl', 'url', 'fileUrl', 'cdnUrl'],
  timestamp: ['timestamp', 'createTime', 'CreateTime', 'ts', 'sendTime'],
  direction: ['direction', 'isSend', 'fromSelf'],
};

export function buildWebhookAdapter(options: WebhookAdapterOptions): ProtocolAdapter {
  let server: Server | null = null;
  const mapping = { ...DEFAULT_MAPPING, ...(options.mapping ?? {}) };
  const path = options.path ?? '/webhook';

  return {
    name: 'http-webhook',
    capabilities: new Set(['receive', 'send']),
    async start(handler: RawEventHandler): Promise<void> {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== path) {
            res.writeHead(404).end('not found');
            return;
          }
          if (options.token && req.headers['x-wechatpro-token'] !== options.token) {
            // 回 401 而不是静默丢弃：对接调试时最容易踩的坑就是 token 配错却看不出。
            res.writeHead(401).end('unauthorized');
            return;
          }

          try {
            const body = await readBody(req, 5 * 1024 * 1024);
            const payload: unknown = JSON.parse(body);
            const batch = Array.isArray(payload) ? payload : [payload];
            for (const item of batch) {
              const type = normalizeEventType(
                String(pick<string>(item, 'event', 'eventType', 'type') ?? 'message'),
              );
              const mapped = mapPayload(item, mapping);
              await handler({
                protocol: 'http-webhook',
                type,
                receivedAt: Date.now(),
                payload: mapped,
              });
            }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
          } catch (error) {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        })();
      });

      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
      });
    },
    async stop(): Promise<void> {
      if (!server) return;
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    },
    async send(conversationId: string, message: OutboundMessage): Promise<boolean> {
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
        // 发送失败只影响这一条回复，不该让调用方（如风控告警）整体失败。
        return false;
      }
    },
  };
}


function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}


/**
 * 按 mapping 把原始载荷映射成归一化字段。
 *
 * 时间戳与消息类型在这里就转换完毕，让下游拿到的一定是毫秒时间戳与合法 kind——
 * 归一化只做一次，避免每个模块各自兜底导致口径不一。
 *
 * `kind` 的收敛交给调用方传入的 `coerce`：协议层各有一套消息类型表
 * （微信 `Type` 数字、企业微信字符串…），用同一套 `coerceKind` 会把对方的
 * 取值全部落到 `unknown`，统计维度静默丢光。默认值仍是通用表，兼容既有调用。
 */
export function mapPayload(
  payload: unknown,
  mapping: Record<string, string[]>,
  coerce: (raw: unknown) => string = coerceKind,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [field, paths] of Object.entries(mapping)) {
    const value = pick(payload, ...paths);
    if (value !== undefined) result[field] = value;
  }
  result.timestamp = toMillis(result.timestamp);
  result.kind = coerce(result.kind);
  result.mentions = toStringList(result.mentions);
  // `IsSender` 在各协议里可能是布尔、0/1、`'1'`/`'0'` 字符串或 `'send'`。
  // 微信 PC 端内存对象给的是数字，早期实现只认 `true`/`1`/`'send'`，
  // 导致**自己发的消息被当成别人发的**（方向反了，出站不统计、@ 自己也会触发）。
  result.direction = isOutbound(result.direction) ? 'outbound' : 'inbound';
  result.raw = payload;
  return result;
}

/**
 * 把协议给的 @ 列表收敛成字符串数组。
 *
 * 兼容 `'a,b'` 逗号串、真正的数组，以及微信 `AtUserList` 里形如
 * `wxid_a,wxid_b` 的写法；非字符串项转成字符串而不是丢弃——
 * 数字 ID（企业微信 userid 可能是数字）丢掉后 @ 轰炸规则就永远数不出来。
 */
export function toStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item)).filter((item) => item.length > 0);
  if (typeof raw === 'string') {
    return raw
      .split(/[,，;；\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

/** 出站方向判定：覆盖布尔、数字、数字字符串与常见枚举写法。 */
export function isOutbound(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'send' || value === 'out' || value === 'outbound' || value === 'self';
  }
  return false;
}

export { coerceKind };
