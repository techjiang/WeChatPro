import { describe, expect, it, vi } from 'vitest';
import { HostTransport, describeUnmapped, selfTestPayload, createHostAdapter } from '../src/protocols/host.js';
import { mapPayload, toStringList, isOutbound } from '../src/protocols/webhook.js';
import { matchesOptions, registerBuiltinAdapters } from '../src/protocols/index.js';
import { HostGateway } from '../src/core/host-bridge.js';
import { getAdapterFactory } from '../src/core/registry.js';
import { pino } from 'pino';
import { createClientHost } from '../src/client/host.js';
import { Engine } from '../src/runtime/engine.js';
import { Store } from '../src/core/store.js';
import { parseConfig } from '../src/core/config.js';
import type { RawEvent } from '../src/core/types.js';

/**
 * 宿主注入链路的边界行为。
 *
 * 这一层的问题全部是「静默型」的：方向反了、@ 列表没解析、探针污染统计、
 * 注入被拒但没人知道——都不会抛错，只会让报表数字慢慢变得不可信。
 * 所以逐个钉住。
 */

describe('载荷映射的字段收敛', () => {
  it('微信数字型 IsSender 识别为出站（含字符串数字）', () => {
    // 真实微信 PC 内存对象给的是 0/1；早期实现只认 true/'send'，
    // 「自己发的消息」会被当成别人发的。
    expect(isOutbound(1)).toBe(true);
    expect(isOutbound('1')).toBe(true);
    expect(isOutbound(true)).toBe(true);
    expect(isOutbound('send')).toBe(true);
    expect(isOutbound(0)).toBe(false);
    expect(isOutbound('0')).toBe(false);
    expect(isOutbound(undefined)).toBe(false);
  });

  it('映射时把 IsSender=1 落成 outbound', () => {
    const mapped = mapPayload({ id: 'm1', IsSender: 1 }, { id: ['id'], direction: ['IsSender'] });
    expect(mapped.direction).toBe('outbound');
  });

  it('@ 列表兼容逗号串、中英文逗号与数组', () => {
    expect(toStringList('wxid_a,wxid_b')).toEqual(['wxid_a', 'wxid_b']);
    expect(toStringList('wxid_a，wxid_b')).toEqual(['wxid_a', 'wxid_b']);
    expect(toStringList(['wxid_a', 42])).toEqual(['wxid_a', '42']);
    expect(toStringList('')).toEqual([]);
    expect(toStringList(undefined)).toEqual([]);
  });

  it('数字型 @ 成员不被丢弃（企业微信 userid 可能是数字）', () => {
    const mapped = mapPayload({ mentions: [101, 102] }, { mentions: ['mentions'] });
    expect(mapped.mentions).toEqual(['101', '102']);
  });
});

describe('注入计数与丢弃原因', () => {
  function transportWithSink(): { transport: HostTransport; events: RawEvent[] } {
    const transport = new HostTransport({ conversationId: ['StrTalker'], senderId: ['StrSender'], text: ['StrContent'] });
    const events: RawEvent[] = [];
    transport.attachSink((event) => {
      events.push(event);
    });
    return { transport, events };
  }

  it('未绑定时注入返回 transport-off 并计数', async () => {
    const transport = new HostTransport({});
    const result = await transport.inject({ StrTalker: 'g', StrSender: 'u' });
    expect(result).toMatchObject({ accepted: false, reason: 'transport-off' });
    expect(transport.dropped).toBe(1);
    expect(transport.received).toBe(0);
  });

  it('无法映射的载荷单独计数，并记录一句可照做的结论', async () => {
    const { transport } = transportWithSink();
    const result = await transport.inject({ Foo: 'bar' });
    expect(result.reason).toBe('unmapped');
    expect(transport.rejected).toBe(1);
    expect(transport.lastRejected).toContain('找不到会话字段');
  });

  it('缺会话但有发送者时给出更精确的结论', () => {
    const text = describeUnmapped({ StrSender: 'wxid_a', StrContent: 'hi' });
    expect(text).toContain('缺会话字段');
  });

  it('缺发送者但有会话时给出更精确的结论', () => {
    const text = describeUnmapped({ StrTalker: 'g@chatroom', StrContent: 'hi' });
    expect(text).toContain('缺发送者字段');
  });

  it('丢弃回调把原因交给宿主侧（用于提示用户）', async () => {
    const { transport } = transportWithSink();
    const seen: string[] = [];
    transport.onDrop((reason) => seen.push(reason));
    await transport.inject({ nope: 1 });
    await transport.inject({ StrTalker: 'g', StrSender: 'u', StrContent: 'ok' });
    expect(seen).toEqual(['unmapped']);
  });

  it('自检探针用 selftest 事件类型，不会写进消息表', async () => {
    const { transport, events } = transportWithSink();
    const probe = await transport.probe();
    expect(probe.accepted).toBe(true);
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(events).toHaveLength(1);
    // 关键：事件类型不是 `message`，引擎因此不会落库，探针不会污染统计。
    expect(events[0]?.type).toBe('selftest');
    expect(transport.received).toBe(1);
    expect(transport.dropped).toBe(0);
  });

  it('自检载荷带固定标识，便于在日志里识别', () => {
    const payload = selfTestPayload();
    expect(payload.MsgSvrID).toBe('wechatpro-selftest');
    expect(payload.StrTalker).toBe('wechatpro-selftest@chatroom');
  });
});

describe('探针在真实引擎上不污染统计', () => {
  it('注入探针后消息数仍为 0，但 received 增加', async () => {
    registerBuiltinAdapters();
    const host = createClientHost({ host: 'wechat-pc' });
    const engine = new Engine({
      config: parseConfig({ logLevel: 'silent', storage: { sqlitePath: ':memory:' }, client: { enabled: true } }),
      store: new Store({ path: ':memory:' }),
      client: host,
      plugins: [],
    });
    await engine.start();
    host.transport.attachSink((event) => engine.ingestRaw(event));

    const probe = await host.adapter.transport.probe();
    expect(probe.accepted).toBe(true);
    expect(engine.stats.received).toBe(1);
    // 探针不落库：既没有会话，也没有消息。
    expect(engine.store.listConversations()).toHaveLength(0);

    await engine.stop();
    engine.store.close();
  });

  it('探针之后真实消息照常入库', async () => {
    registerBuiltinAdapters();
    const host = createClientHost({ host: 'wechat-pc' });
    const engine = new Engine({
      config: parseConfig({ logLevel: 'silent', storage: { sqlitePath: ':memory:' }, client: { enabled: true } }),
      store: new Store({ path: ':memory:' }),
      client: host,
      plugins: [],
    });
    await engine.start();
    host.transport.attachSink((event) => engine.ingestRaw(event));

    await host.adapter.transport.probe();
    await host.ingest({
      MsgSvrID: 'real1',
      StrTalker: 'g@chatroom',
      RoomName: '真实群',
      StrSender: 'u1',
      SenderNick: '甲',
      StrContent: '真实消息',
      Type: 1,
      CreateTime: 1_790_000_000,
    });

    expect(engine.store.getConversation('g@chatroom')?.message_count).toBe(1);
    await engine.stop();
    engine.store.close();
  });
});

describe('宿主适配器的选项指纹', () => {
  /** 让注册表造一个带指纹的适配器——指纹是「造的时候记下来」的，所以必须走工厂。 */
  async function throughFactory(options: Record<string, unknown>) {
    registerBuiltinAdapters();
    registerBuiltinAdapters({ hostGateway: new HostGateway() });
    const factory = getAdapterFactory('host');
    return factory!(options, { logger: pino({ level: 'silent' }) });
  }

  it('同一套选项判定为可复用', async () => {
    const adapter = await throughFactory({ host: 'wechat-pc', transport: 'none' });
    expect(matchesOptions(adapter as never, { host: 'wechat-pc', transport: 'none' })).toBe(true);
  });

  it('transport 或 mapping 或宿主不同则不可复用，避免导入数据串用实时映射', async () => {
    const adapter = await throughFactory({ host: 'wechat-pc', transport: 'none' });
    expect(matchesOptions(adapter as never, { host: 'wechat-pc', transport: 'none', httpPort: 1 })).toBe(false);
    expect(matchesOptions(adapter as never, { host: 'other', transport: 'none' })).toBe(false);
    expect(
      matchesOptions(adapter as never, { host: 'wechat-pc', transport: 'none', mapping: { text: ['Content'] } }),
    ).toBe(false);
  });

  it('无关字段（如自定义宿主参数）不改变判定', async () => {
    const adapter = await throughFactory({ host: 'wechat-pc', transport: 'none' });
    expect(matchesOptions(adapter as never, { host: 'wechat-pc', transport: 'none', verbose: 1 })).toBe(true);
  });
});

describe('适配器在注册表里被正确绑定', () => {
  it('引擎拿到的 host 适配器与宿主注入用的是同一个 transport', async () => {
    registerBuiltinAdapters();
    const host = createClientHost({ host: 'wechat-pc' });
    registerBuiltinAdapters({
      hostGateway: host.gateway,
      hostProvider: () => host.adapter,
      hostProviderOptions: host.adapterOptions,
    });

    const config = parseConfig({
      logLevel: 'silent',
      storage: { sqlitePath: ':memory:' },
      client: { enabled: true },
      adapters: [{ protocol: 'host', options: { host: 'wechat-pc', transport: 'none', outbound: 'host' } }],
    });
    const engine = new Engine({ config, store: new Store({ path: ':memory:' }), client: host, plugins: [] });
    await engine.start();

    const used = engine.context.adapters.get('host') as { transport: unknown } | undefined;
    expect(used?.transport).toBe(host.transport);

    const result = await host.ingest({
      MsgSvrID: 'x1',
      StrTalker: 'g@chatroom',
      RoomName: '群',
      StrSender: 'u1',
      SenderNick: '甲',
      StrContent: '你好',
      Type: 1,
      CreateTime: 1_790_000_000,
    });
    expect(result.accepted).toBe(true);
    await engine.stop();
    engine.store.close();
  });
});

describe('direct 构造的宿主适配器', () => {
  it('未提供宿主桥时能力为空，但适配器仍完整工作', async () => {
    registerBuiltinAdapters();
    const adapter = createHostAdapter({ host: 'wechat-pc', transport: 'none' });
    expect(adapter.capabilities.has('receive')).toBe(true);
    const results: RawEvent[] = [];
    await adapter.start((event) => {
      results.push(event);
    });
    await adapter.transport.inject({ StrTalker: 'g@chatroom', StrSender: 'u', StrContent: 'hi' });
    await adapter.stop();
    expect(results).toHaveLength(1);
  });

  it('宿主桥的 toast 在缺能力时返回 false 而不是抛错', async () => {
    const gateway = new HostGateway();
    gateway.attach({ host: 'wechat-pc' });
    await expect(gateway.toast('hi')).resolves.toBe(false);
  });

  it('宿主能力抛错被隔离并计入失败统计', async () => {
    const gateway = new HostGateway();
    gateway.attach({
      host: 'wechat-pc',
      notify: vi.fn(() => {
        throw new Error('客户端 API 炸了');
      }),
    });
    await expect(gateway.notify({ title: 't', body: 'b' })).resolves.toBe(false);
    expect(gateway.callStats()).toEqual([{ capability: 'notify', ok: 0, failed: 1 }]);
  });
});
