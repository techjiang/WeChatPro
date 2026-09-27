import type { ProtocolAdapter, RawEvent } from './types.js';

/**
 * 适配器注册表。
 *
 * 用「工厂 + 注册」而非继承：不同协议适配器的构造参数差异很大，
 * 但引擎只关心统一的 `ProtocolAdapter` 接口。工厂签名统一为
 * `(options, deps) => Promise<ProtocolAdapter>`，便于异步初始化（取 token、建连接）。
 */

export interface AdapterDeps {
  logger: import('pino').Logger;
  /** 让适配器能主动发消息时的兜底：由引擎注入的统一发送入口。 */
  sendMessage?: (conversationId: string, text: string) => Promise<boolean>;
}

export type AdapterFactory = (
  options: Record<string, unknown>,
  deps: AdapterDeps,
) => Promise<ProtocolAdapter>;

const factories = new Map<string, AdapterFactory>();

export function registerAdapter(protocol: string, factory: AdapterFactory): void {
  if (factories.has(protocol)) throw new Error(`适配器 ${protocol} 已注册`);
  factories.set(protocol, factory);
}

export function getAdapterFactory(protocol: string): AdapterFactory | undefined {
  return factories.get(protocol);
}

export function listAdapterProtocols(): string[] {
  return [...factories.keys()].sort();
}

/**
 * 把适配器投递的原始事件转成归一化消息的统一入口。
 *
 * 各协议字段命名天差地别（`msgId`/`MsgId`/`id`，`fromUser`/`sender`…），
 * 但「取字段」这件事必须只写一遍，否则每加一个协议就要重写一遍归一化逻辑。
 * 用 `pick` 依次尝试候选路径，都取不到时返回 `undefined` 由调用方决定默认值。
 */
export function pick<T = unknown>(source: unknown, ...paths: string[]): T | undefined {
  for (const path of paths) {
    let cursor: unknown = source;
    let ok = true;
    for (const segment of path.split('.')) {
      if (cursor && typeof cursor === 'object' && segment in (cursor as Record<string, unknown>)) {
        cursor = (cursor as Record<string, unknown>)[segment];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && cursor !== undefined && cursor !== null) return cursor as T;
  }
  return undefined;
}

/** 时间戳归一化：兼容秒 / 毫秒 / 字符串数字。 */
export function toMillis(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 10 位是秒级，13 位是毫秒级；用 1e12 作分界足够安全（公元 2001 年后毫秒级都 >1e12）。
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toMillis(numeric, fallback);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * 引擎认识的原始事件类型。
 *
 * 白名单式而非自由字符串：引擎对这几种有自己的处理（落库、转发、透传），
 * 其余一律走 `raw` 透传，不猜语义。
 */
export type RawEventType = 'message' | 'message.revoked' | 'member.join' | 'member.leave' | 'selftest' | 'raw';

/**
 * 事件类型白名单 → 归一化类型。未知类型归为 `message` 以免丢数据。
 *
 * `selftest` 单独留一个类型：健康自检要探「宿主 → 引擎」这条链路，
 * 但**不能**在探的时候写一条假消息进库（每次自检都让「昨天消息数 +1」）。
 * 引擎对它的处理是：计入 `received`、发到总线，不落库。
 */
export function normalizeEventType(raw: string): RawEventType {
  const value = raw.toLowerCase();
  if (value === 'selftest' || /^self[-_]?test$/.test(value)) return 'selftest';
  if (/revoke|recall|withdraw/.test(value)) return 'message.revoked';
  if (/join|invite|add.?member/.test(value)) return 'member.join';
  if (/leave|quit|kick|remove.?member/.test(value)) return 'member.leave';
  return 'message';
}
