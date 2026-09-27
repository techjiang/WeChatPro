import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/runtime/engine.js';
import { EventBus } from '../src/core/events.js';
import { resolvePluginOrder, PluginGraphError, type Plugin } from '../src/core/plugin.js';
import { registerAdapter, normalizeEventType, pick, toMillis, listAdapterProtocols } from '../src/core/registry.js';
import { resolveConversationKind } from '../src/runtime/engine.js';
import { registerBuiltinAdapters, coerceKind } from '../src/protocols.js';
import { createTestEngine, testConfig } from './helpers.js';
import type { RawEvent } from '../src/core/types.js';

registerBuiltinAdapters();

describe('EventBus', () => {
  it('派发给多个订阅者', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('message', 'a', () => seen.push('a'));
    bus.on('message', 'b', () => seen.push('b'));
    bus.emit('message', {});
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('同一 id 重复订阅会替换，不重复触发', () => {
    const bus = new EventBus();
    let count = 0;
    bus.on('message', 'x', () => { count += 1; });
    bus.on('message', 'x', () => { count += 10; });
    bus.emit('message', {});
    expect(count).toBe(10);
    expect(bus.listenerCount('message')).toBe(1);
  });

  it('单个订阅者抛错不影响其他订阅者，并回报错误', () => {
    const errors: string[] = [];
    const bus = new EventBus((e) => errors.push(e.subscriber));
    let reached = false;
    bus.on('message', 'bad', () => { throw new Error('boom'); });
    bus.on('message', 'good', () => { reached = true; });
    bus.emit('message', {});
    expect(reached).toBe(true);
    expect(errors).toEqual(['bad']);
  });

  it('offAll 摘掉某个订阅者的全部监听', () => {
    const bus = new EventBus();
    bus.on('message', 'p', () => {});
    bus.on('alert', 'p', () => {});
    bus.offAll('p');
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('resolvePluginOrder', () => {
  const plugin = (name: string, dependsOn?: string[]): Plugin => ({
    manifest: { name, dependsOn },
  });

  it('依赖项排在前面', () => {
    const ordered = resolvePluginOrder([plugin('b', ['a']), plugin('a')]);
    expect(ordered.map((p) => p.manifest.name)).toEqual(['a', 'b']);
  });

  it('缺失依赖抛错', () => {
    expect(() => resolvePluginOrder([plugin('b', ['missing'])])).toThrow(PluginGraphError);
  });

  it('检测循环依赖', () => {
    expect(() => resolvePluginOrder([plugin('a', ['b']), plugin('b', ['a'])])).toThrow(/环/);
  });

  it('重复插件名抛错', () => {
    expect(() => resolvePluginOrder([plugin('a'), plugin('a')])).toThrow(/重复/);
  });
});

describe('registry helpers', () => {
  it('normalizeEventType 归类事件', () => {
    expect(normalizeEventType('message')).toBe('message');
    expect(normalizeEventType('msg')).toBe('message');
    expect(normalizeEventType('revoke')).toBe('message.revoked');
    expect(normalizeEventType('recall_msg')).toBe('message.revoked');
    expect(normalizeEventType('member.join')).toBe('member.join');
    expect(normalizeEventType('room_leave')).toBe('member.leave');
  });

  it('pick 按候选路径取值', () => {
    expect(pick({ a: { b: 1 } }, 'a.b', 'c')).toBe(1);
    expect(pick({ c: 2 }, 'a.b', 'c')).toBe(2);
    expect(pick({}, 'x')).toBeUndefined();
  });

  it('toMillis 兼容秒与毫秒', () => {
    expect(toMillis(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMillis(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toMillis('1700000000')).toBe(1_700_000_000_000);
    expect(toMillis('2026-01-01T00:00:00Z')).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('coerceKind 兼容数字类型与常见别名', () => {
    // 数字型 MsgType 是最常见的协议表示，必须能映射，否则统计维度全丢。
    expect(coerceKind(1)).toBe('text');
    expect(coerceKind('1')).toBe('text');
    expect(coerceKind(3)).toBe('image');
    expect(coerceKind('34')).toBe('voice');
    expect(coerceKind('49')).toBe('link');
    expect(coerceKind('image')).toBe('image');
    expect(coerceKind('未知类型')).toBe('unknown');
    expect(coerceKind(undefined)).toBe('unknown');
  });

  it('内置适配器已注册', () => {
    expect(listAdapterProtocols()).toContain('mock');
    expect(listAdapterProtocols()).toContain('http-webhook');
  });
});

describe('Engine', () => {
  it('归一化字段并落库', async () => {
    const engine = createTestEngine();
    const event: RawEvent = {
      protocol: 'test',
      type: 'message',
      receivedAt: Date.now(),
      payload: {
        conversationId: 'g1',
        conversationName: '产品群',
        senderId: 'u1',
        senderName: '张三',
        text: '项目进度同步',
        timestamp: Math.floor(Date.now() / 1000),
      },
    };
    const message = engine.normalize(event);
    expect(message).not.toBeNull();
    expect(message?.conversation.name).toBe('产品群');
    expect(message?.sender.displayName).toBe('张三');
    // 秒级时间戳被换算为毫秒
    expect(message?.timestamp).toBeGreaterThan(1e12);
    // 群 ID 以 @chatroom 结尾时应识别为群聊
    expect(message?.conversation.kind).toBe('group');
    engine.store.close();
  });

  it('缺少会话或发送者的消息被丢弃', () => {
    const engine = createTestEngine();
    expect(engine.normalize({ protocol: 't', type: 'message', receivedAt: 0, payload: { text: 'x' } })).toBeNull();
    expect(
      engine.normalize({ protocol: 't', type: 'message', receivedAt: 0, payload: { conversationId: 'g1' } }),
    ).toBeNull();
    engine.store.close();
  });

  it('无消息 ID 时基于内容生成稳定 ID 以便去重', () => {
    const engine = createTestEngine();
    const payload = { conversationId: 'g1', senderId: 'u1', text: '重复的消息', timestamp: 1_700_000_000_000 };
    const first = engine.normalize({ protocol: 't', type: 'message', receivedAt: 0, payload });
    const second = engine.normalize({ protocol: 't', type: 'message', receivedAt: 0, payload });
    expect(first?.id).toBe(second?.id);
    engine.store.close();
  });

  it('通过 mock 适配器接收消息并触发插件订阅', async () => {
    const config = testConfig({
      adapters: [
        {
          protocol: 'mock',
          options: {
            intervalMs: 5,
            script: [
              { conversationId: 'g1', senderId: 'u1', senderName: '甲', text: '第一条' },
              { conversationId: 'g1', senderId: 'u2', senderName: '乙', text: '第二条' },
            ],
          },
        },
      ],
    });
    const engine = createTestEngine(config);
    const received: string[] = [];
    engine.bus.on('message', 'test', (event) => {
      received.push((event.payload as { text: string }).text);
    });

    await engine.start();
    await vi.waitFor(() => expect(received.length).toBe(2), { timeout: 2000 });
    await engine.stop();

    expect(engine.stats.accepted).toBe(2);
    expect(engine.store.listConversations()[0]?.message_count).toBe(2);
    engine.store.close();
  });

  it('重复投递只计一次', async () => {
    const config = testConfig({
      adapters: [{ protocol: 'mock', options: { intervalMs: 10, loop: true, script: [{ conversationId: 'g1', senderId: 'u1', text: '同一条', id: 'same-id' }] } }],
    });
    const engine = createTestEngine(config);
    await engine.start();
    // 循环回放同一 ID，去重层应只接受一次
    await vi.waitFor(() => expect(engine.stats.duplicates).toBeGreaterThanOrEqual(1), { timeout: 2000 });
    await engine.stop();
    expect(engine.stats.accepted).toBe(1);
    expect(engine.store.listConversations()[0]?.message_count).toBe(1);
    engine.store.close();
  });

  it('配置未知协议时启动失败', async () => {
    const engine = createTestEngine(testConfig({ adapters: [{ protocol: 'nope' }] }));
    await expect(engine.createAdapters()).rejects.toThrow(/未知适配器协议/);
    engine.store.close();
  });

  it('自定义适配器可注册并投递事件', async () => {
    registerAdapter('test-manual', async () => ({
      name: 'test-manual',
      capabilities: new Set(['receive']),
      async start(handler) {
        await handler({
          protocol: 'test-manual',
          type: 'message',
          receivedAt: Date.now(),
          payload: { conversationId: 'g9', senderId: 'ux', text: '来自自定义适配器' },
        });
      },
      async stop() {},
    }));

    const engine = createTestEngine(testConfig({ adapters: [{ protocol: 'test-manual' }] }));
    await engine.start();
    await engine.stop();
    expect(engine.store.getConversation('g9')?.message_count).toBe(1);
    engine.store.close();
  });

  it('订阅者抛错不会中断消息处理', async () => {
    const config = testConfig({
      adapters: [
        { protocol: 'mock', options: { intervalMs: 5, script: [{ conversationId: 'g1', senderId: 'u1', text: 'x' }] } },
      ],
    });
    const engine = createTestEngine(config);
    engine.bus.on('message', 'broken', () => { throw new Error('bad subscriber'); });
    await engine.start();
    await vi.waitFor(() => expect(engine.stats.accepted).toBe(1), { timeout: 2000 });
    await engine.stop();
    expect(engine.stats.failed).toBeGreaterThanOrEqual(1);
    engine.store.close();
  });
});


describe('resolveConversationKind', () => {
  it('协议显式声明优先', () => {
    expect(resolveConversationKind({ conversationKind: 'private' }, 'g1')).toBe('private');
    expect(resolveConversationKind({ chatType: 'group' }, 'u1')).toBe('group');
    expect(resolveConversationKind({ roomType: 'official' }, 'g1')).toBe('official');
  });

  it('按群 ID 特征识别微信群', () => {
    expect(resolveConversationKind({}, '12345@chatroom')).toBe('group');
    expect(resolveConversationKind({}, 'R:12345')).toBe('group');
  });

  it('无法判断时默认群聊（本引擎面向群运营）', () => {
    expect(resolveConversationKind({}, 'wxid_abc')).toBe('group');
  });
});
