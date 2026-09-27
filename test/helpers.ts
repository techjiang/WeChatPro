import { parseConfig, type AppConfig } from '../src/core/config.js';
import { Engine } from '../src/runtime/engine.js';
import { Store } from '../src/core/store.js';
import { registerBuiltinAdapters } from '../src/protocols.js';
import type { NormalizedMessage } from '../src/core/types.js';

/**
 * 测试夹具。
 *
 * 统一走内存 SQLite + 静默 logger，让测试之间零共享状态、无磁盘残留；
 * 引擎本身难测的部分（适配器）在单元测试里绕过，只在集成测试里用 mock 适配器。
 */

registerBuiltinAdapters();

export function testConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return parseConfig({
    logLevel: 'silent',
    storage: { sqlitePath: ':memory:' },
    ...overrides,
  });
}

export function createTestEngine(config?: AppConfig): Engine {
  const resolved = config ?? testConfig();
  const store = new Store({ path: ':memory:' });
  return new Engine({ config: resolved, store });
}

let counter = 0;

/** 构造归一化消息。默认值覆盖最常见场景，测试只写关心的字段。 */
export function message(partial: Partial<NormalizedMessage> & { text?: string } = {}): NormalizedMessage {
  counter += 1;
  const senderId = partial.sender?.id ?? `u${counter % 3}`;
  const text = partial.text ?? `消息 ${counter}`;
  return {
    id: partial.id ?? `m${counter}`,
    conversation: partial.conversation ?? { id: 'g1', kind: 'group', name: '测试群' },
    sender: partial.sender ?? { id: senderId, displayName: `成员${senderId}` },
    kind: partial.kind ?? 'text',
    direction: partial.direction ?? 'inbound',
    timestamp: partial.timestamp ?? Date.now(),
    text,
    summary: partial.summary ?? text.slice(0, 80),
    mentions: partial.mentions ?? [],
    quoteId: partial.quoteId,
    mediaUrl: partial.mediaUrl,
    raw: partial.raw,
  };
}

/** 批量构造「同一发送者在时间窗口内」的消息序列，用于刷屏/重复类规则。 */
export function burst(
  count: number,
  options: { senderId?: string; text?: string; startAt?: number; stepMs?: number } = {},
): NormalizedMessage[] {
  const start = options.startAt ?? Date.now();
  const step = options.stepMs ?? 1000;
  return Array.from({ length: count }, (_, index) =>
    message({
      sender: { id: options.senderId ?? 'spammer', displayName: '刷屏者' },
      text: options.text ?? `第 ${index} 条`,
      timestamp: start + index * step,
    }),
  );
}

export function resetCounter(): void {
  counter = 0;
}
