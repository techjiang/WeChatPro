import { describe, expect, it, vi } from 'vitest';
import { createClientHost, bridgeFromShell, type ClientShellApi } from '../src/client/host.js';
import { renderPanel } from '../src/client/panel.js';
import { HostGateway } from '../src/core/host-bridge.js';
import { BRAND, brandIcon, asciiBanner } from '../src/client/brand.js';
import {
  HostTransport,
  WECHAT_PC_MAPPING,
  coerceHostKind,
  parseChatExport,
} from '../src/protocols/host.js';
import { registerBuiltinAdapters } from '../src/protocols/index.js';
import { Engine } from '../src/runtime/engine.js';
import { Store } from '../src/core/store.js';
import { parseConfig } from '../src/core/config.js';
import { builtinPlugins } from '../src/runtime/bootstrap.js';
import type { AppConfig } from '../src/core/config.js';

/**
 * PC 客户端形态的集成测试。
 *
 * 覆盖三件最可能在真实客户端里出事的事：
 * 1. 消息入口的归一化（微信字段名 → 引擎模型，含时间戳单位与消息类型）
 * 2. 宿主桥 → 引擎的**单实例**绑定（双实例会导致消息全丢且没有任何报错）
 * 3. 面板渲染的健壮性（品牌资源缺失、数据为空都不能白屏）
 *
 * 注意：`registerBuiltinAdapters` 是幂等的——同一个 `host` 协议只会注册一次工厂。
 * 因此本文件所有用例**必须**共用同一个 `ClientHost`，否则后建的实例拿不到
 * 引擎实际使用的适配器，`inject()` 会一直返回 `transport-off`。
 * 这既是测试的组织方式，也正好把这条契约钉死在回归里。
 */

/** 全局唯一的宿主与引擎：模拟真实的「一个客户端进程一份插件」。 */
const SHARED = (() => {
  const client = createClientHost({ host: 'wechat-pc' });
  registerBuiltinAdapters({
    hostGateway: client.gateway,
    hostFactory: async () => client.adapter,
  });
  return client;
})();

function freshEngine(config: AppConfig): Engine {
  // 带上内置插件：`client` 插件（原生通知、角标、群内指令）就是在这里参与装配的，
  // 少了它「宿主联动」整组用例会退化成只验证「消息能入库」。
  const engine = new Engine({
    config,
    store: new Store({ path: ':memory:' }),
    client: SHARED,
    plugins: [...builtinPlugins],
  });
  SHARED.attachHost({ host: 'wechat-pc' });
  // 每个用例都是一次新的客户端生命周期，去重窗口要跟着清空，
  // 否则「上一条用例弹过的告警」会把这一条静默吃掉。
  SHARED.resetHostState();
  return engine;
}

function clientConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return parseConfig({
    logLevel: 'silent',
    storage: { sqlitePath: ':memory:' },
    client: { enabled: true },
    adapters: [{ protocol: 'host', options: { transport: 'none' } }],
    ...overrides,
  });
}

/** 造一个「引擎 + 宿主」的完整客户端形态，返回各部分句柄。 */
function bootClient(config = clientConfig()) {
  return { client: SHARED, engine: freshEngine(config) };
}

/** 微信 PC 端真实字段名的一条群消息。 */
function wechatMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    MsgSvrID: '9001',
    StrTalker: '12345678@chatroom',
    RoomName: '产品交流群',
    StrSender: 'wxid_zhang',
    SenderNick: '张工',
    StrContent: '这周的进度同步一下',
    Type: 1,
    CreateTime: 1_790_000_000,
    ...overrides,
  };
}

describe('宿主消息归一化', () => {
  it('把微信 PC 字段映射成引擎模型：秒级时间戳转毫秒、数字类型转枚举', async () => {
    const { client, engine } = bootClient();
    await engine.start();
    try {
      const result = await client.ingest(wechatMessage());
      expect(result.accepted).toBe(true);
      expect(result.message?.conversationId).toBe('12345678@chatroom');
      expect(result.message?.senderId).toBe('wxid_zhang');
      // 秒级 → 毫秒级：微信用 10 位秒级时间戳，直接入库会让所有报表落在 1970 年。
      expect(result.message?.timestamp).toBe(1_790_000_000_000);
      expect(result.message?.kind).toBe('text');

      const conversation = engine.store.getConversation('12345678@chatroom');
      expect(conversation?.name).toBe('产品交流群');
      expect(conversation?.message_count).toBe(1);
      expect(engine.store.getMember('12345678@chatroom', 'wxid_zhang')?.display_name).toBe('张工');
    } finally {
      await engine.stop();
    }
  });

  it('兼容字符串形式的微信类型与毫秒时间戳', async () => {
    const { client, engine } = bootClient();
    await engine.start();
    try {
      const result = await client.ingest(
        wechatMessage({ Type: '49', CreateTime: 1_790_000_000_000 }),
      );
      expect(result.message?.kind).toBe('link');
      expect(result.message?.timestamp).toBe(1_790_000_000_000);
    } finally {
      await engine.stop();
    }
  });

  it('消息类型映射覆盖微信常用取值，未知值落到 unknown 而不是抛错', () => {
    expect(coerceHostKind(1)).toBe('text');
    expect(coerceHostKind(3)).toBe('image');
    expect(coerceHostKind(34)).toBe('voice');
    expect(coerceHostKind(43)).toBe('video');
    expect(coerceHostKind(47)).toBe('sticker');
    expect(coerceHostKind(48)).toBe('location');
    expect(coerceHostKind(10000)).toBe('system');
    expect(coerceHostKind(10002)).toBe('revoke');
    expect(coerceHostKind('appmsg')).toBe('link');
    expect(coerceHostKind('未知类型')).toBe('unknown');
    expect(coerceHostKind(undefined)).toBe('unknown');
  });

  it('缺会话或发送者的载荷被拒绝，且说明原因', async () => {
    const { client, engine } = bootClient();
    await engine.start();
    try {
      await expect(client.ingest({ StrContent: '没有会话' })).resolves.toEqual({
        accepted: false,
        reason: 'unmapped',
      });
      await expect(client.ingest({ StrTalker: 'x@chatroom' })).resolves.toEqual({
        accepted: false,
        reason: 'unmapped',
      });
      expect(engine.store.listConversations()).toHaveLength(0);
    } finally {
      await engine.stop();
    }
  });

  it('协议重投同一消息只入库一次', async () => {
    const { client, engine } = bootClient();
    await engine.start();
    try {
      const payload = wechatMessage();
      const first = await client.ingest(payload);
      const second = await client.ingest(payload);
      expect(first.accepted).toBe(true);
      // 第二次仍返回 accepted（注入成功），但引擎侧去重不计入统计分母。
      expect(await second.accepted).toBe(true);
      expect(engine.store.getConversation('12345678@chatroom')?.message_count).toBe(1);
      expect(engine.stats.duplicates).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
  });

  it('宿主在引擎启动前注入时返回 transport-off，不抛错', async () => {
    const { client } = bootClient();
    await expect(client.ingest(wechatMessage())).resolves.toEqual({
      accepted: false,
      reason: 'transport-off',
    });
  });

  it('批量注入分别统计入库与丢弃', async () => {
    const { client, engine } = bootClient();
    await engine.start();
    try {
      const result = await client.ingestBatch([
        wechatMessage({ MsgSvrID: 'a' }),
        wechatMessage({ MsgSvrID: 'b' }),
        { StrContent: '畸形数据' },
      ]);
      expect(result).toEqual({ accepted: 2, dropped: 1 });
    } finally {
      await engine.stop();
    }
  });

  it('系统消息里的入群文案被识别为成员事件', async () => {
    const { client, engine } = bootClient();
    await engine.start();
    const joins: unknown[] = [];
    engine.bus.on('member.join', 'test', (event) => joins.push(event.payload));
    try {
      await client.ingest(
        wechatMessage({ Type: 10000, StrContent: '你邀请"新同学"加入了群聊', MsgSvrID: 'sys1' }),
      );
      expect(joins).toHaveLength(1);
    } finally {
      await engine.stop();
    }
  });

  it('自建 ClientHost 在引擎启动后仍然指向同一个 transport（防双实例丢消息）', async () => {
    const { client, engine } = bootClient();
    await engine.start();
    try {
      const bound = engine.context.adapters.get('host');
      expect(bound).toBe(client.adapter);
      expect(client.transport.bound).toBe(true);
    } finally {
      await engine.stop();
    }
  });
});

describe('宿主桥联动', () => {
  it('风控告警触发原生通知与入口角标', async () => {
    const notify = vi.fn();
    const setBadge = vi.fn();
    const setTitleBadge = vi.fn();
    const config = clientConfig({
      guard: {
        alertThreshold: 30,
        rules: [
          {
            id: 'keyword-blocklist',
            enabled: true,
            weight: 40,
            options: { words: ['刷单'] },
          },
        ],
      },
      plugins: [{ name: 'client', enabled: true, options: {} }],
    });
    const { client, engine } = bootClient(config);
    client.attachHost({ host: 'wechat-pc', notify, setBadge, setTitleBadge });
    await engine.start();
    try {
      await client.ingest(wechatMessage({ StrContent: '招人刷单', MsgSvrID: 'spam1' }));
      // 至少弹一次；具体次数取决于命中了哪几条规则，不该在断言里写死。
      expect(notify).toHaveBeenCalled();
      const call = notify.mock.calls[0]?.[0] as { title: string; body: string; route: string };
      expect(call.title).toContain(BRAND.name);
      expect(call.body).toContain('刷单');
      // 通知点击后要能跳到风控页，否则用户还得自己找。
      expect(call.route).toBe('#/guard');
      expect(setBadge).toHaveBeenCalledWith(1);
      expect(setTitleBadge).toHaveBeenCalledWith('1');
    } finally {
      await engine.stop();
    }
  });

  it('同一规则同一成员的连续命中只提醒一次', async () => {
    const notify = vi.fn();
    const config = clientConfig({
      guard: {
        alertThreshold: 30,
        rules: [{ id: 'keyword-blocklist', enabled: true, weight: 40, options: { words: ['刷单'] } }],
      },
      plugins: [{ name: 'client', enabled: true, options: {} }],
    });
    const { client, engine } = bootClient(config);
    client.attachHost({ host: 'wechat-pc', notify });
    await engine.start();
    try {
      for (let i = 0; i < 4; i += 1) {
        await client.ingest(wechatMessage({ StrContent: `刷单第 ${i} 条`, MsgSvrID: `s${i}` }));
      }
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      await engine.stop();
    }
  });

  it('关闭 notifyOnAlert 时只记事件，不弹通知', async () => {
    const notify = vi.fn();
    const config = clientConfig({
      client: { enabled: true, notifyOnAlert: false },
      guard: {
        rules: [{ id: 'keyword-blocklist', enabled: true, weight: 40, options: { words: ['刷单'] } }],
      },
      plugins: [{ name: 'client', enabled: true, options: {} }],
    });
    const { client, engine } = bootClient(config);
    client.attachHost({ host: 'wechat-pc', notify });
    await engine.start();
    try {
      await client.ingest(wechatMessage({ StrContent: '刷单日结', MsgSvrID: 'n1' }));
      expect(notify).not.toHaveBeenCalled();
      expect(engine.store.recentEvents('12345678@chatroom', 10).length).toBeGreaterThan(0);
    } finally {
      await engine.stop();
    }
  });

  it('群内 /面板 指令让宿主拉起面板并清角标', async () => {
    const openPanel = vi.fn();
    const setBadge = vi.fn();
    const sent: string[] = [];
    const config = clientConfig({
      plugins: [{ name: 'client', enabled: true, options: { allowRemotePanel: true } }],
    });
    const { client, engine } = bootClient(config);
    client.attachHost({ host: 'wechat-pc', openPanel, setBadge });
    await engine.start();
    try {
      // 直接派发 `command` 事件：真实路径是「群消息 → command 插件 → command 事件」，
      // 这里跳过前半段，专注验证 client 插件对指令的响应。
      engine.bus.emit('command', {
        intent: 'unknown',
        question: '面板',
        conversationId: '12345678@chatroom',
        reply: (text: string) => sent.push(text),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(openPanel).toHaveBeenCalledWith('#/dashboard');
      expect(setBadge).toHaveBeenCalledWith(0);
      expect(sent.join()).toContain('面板');
    } finally {
      await engine.stop();
    }
  });

  it('群内 /导出 指令让宿主弹保存对话框，内容含群档案', async () => {
    const exportFile = vi.fn(async () => '/Users/me/Desktop/wechatpro.json');
    const sent: string[] = [];
    const config = clientConfig({
      plugins: [{ name: 'client', enabled: true, options: {} }],
    });
    const { client, engine } = bootClient(config);
    client.attachHost({ host: 'wechat-pc', exportFile });
    await engine.start();
    try {
      await client.ingest(wechatMessage());
      engine.bus.emit('command', {
        intent: 'unknown',
        question: '导出',
        conversationId: '12345678@chatroom',
        reply: (text: string) => sent.push(text),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(exportFile).toHaveBeenCalledTimes(1);
      const calls = exportFile.mock.calls as unknown as Array<Array<{ filename: string; content: string }>>;
      const arg = calls[0]?.[0] as { filename: string; content: string };
      expect(arg.filename).toContain('wechatpro-');
      expect(JSON.parse(arg.content).members).toHaveLength(1);
      expect(sent.join()).toContain('已导出');
    } finally {
      await engine.stop();
    }
  });

  it('focus() 打开面板并清角标', async () => {
    const openPanel = vi.fn();
    const setBadge = vi.fn();
    const client = createClientHost({ host: 'wechat-pc' });
    client.attachHost({ host: 'wechat-pc', openPanel, setBadge });
    await expect(client.focus('#/members')).resolves.toEqual({ opened: true, badge: true });
    expect(openPanel).toHaveBeenCalledWith('#/members');
    expect(setBadge).toHaveBeenCalledWith(0);
  });
});

describe('IPC 传输', () => {
  it('通过本地 HTTP 注入消息，路径与令牌都校验', async () => {
    const transport = new HostTransport(WECHAT_PC_MAPPING);
    const received: unknown[] = [];
    transport.bind(async (event) => {
      received.push(event.payload);
    });
    const url = await transport.listen({ port: 0, host: '127.0.0.1', path: '/host/inject', token: 'tk' });
    try {
      const denied = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wechatMessage()),
      });
      expect(denied.status).toBe(401);

      const ok = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wechatpro-token': 'tk' },
        body: JSON.stringify(wechatMessage()),
      });
      expect(ok.status).toBe(200);
      expect(received).toHaveLength(1);

      const wrongPath = await fetch(url.replace('/host/inject', '/nope'), { method: 'POST', body: '{}' });
      expect(wrongPath.status).toBe(404);

      const bad = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wechatpro-token': 'tk' },
        body: JSON.stringify({ StrContent: '畸形' }),
      });
      // 无法归属的消息回 422：调用方要能区分「没收到」与「收到了但不可用」。
      expect(bad.status).toBe(422);
    } finally {
      await transport.close();
    }
  });

  it('批量注入走数组分支', async () => {
    const transport = new HostTransport(WECHAT_PC_MAPPING);
    transport.bind(async () => {});
    const url = await transport.listen({ port: 0, host: '127.0.0.1', path: '/i' });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([wechatMessage({ MsgSvrID: 'x' }), wechatMessage({ MsgSvrID: 'y' })]),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, accepted: 2, dropped: 0 });
    } finally {
      await transport.close();
    }
  });
});

describe('聊天记录导入解析', () => {
  it('解析多种导出格式并生成稳定 ID', () => {
    const text = [
      '2026-09-27 09:12:30 张工: 本周进度同步',
      '[2026/09/27 09:13] 李设计：设计稿已交付',
      '这一行是无效的头部信息，应该被跳过',
      '2026-09-27 09:20:11 广告号: 招人刷单日结',
    ].join('\n');
    const parsed = parseChatExport(text, { conversationId: 'g@chatroom', conversationName: '产品群' });
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      StrTalker: 'g@chatroom',
      RoomName: '产品群',
      StrSender: '张工',
      StrContent: '本周进度同步',
      Type: 1,
    });
    expect(parsed[1]?.StrSender).toBe('李设计');
    // 同内容重复导入必须得到同一个 ID，否则去重失效会双倍计数。
    const again = parseChatExport(text, { conversationId: 'g@chatroom' });
    expect(again[0]?.MsgSvrID).toBe(parsed[0]?.MsgSvrID);
  });

  it('全部为无效行时返回空数组而不是抛错', () => {
    expect(parseChatExport('随便一段没有时间戳的文字\n第二行')).toEqual([]);
    expect(parseChatExport('')).toEqual([]);
  });
});

describe('宿主桥适配', () => {
  it('bridgeFromShell 只为真实实现挂能力，缺的不挂', () => {
    const shell: ClientShellApi = {
      notifyNative: vi.fn(),
      setBadgeNative: vi.fn(),
      // 故意不提供 nativeSend / contacts
    };
    const bridge = bridgeFromShell(shell, { host: 'wechat-pc', hostVersion: '3.9.x' });
    expect(bridge.host).toBe('wechat-pc');
    expect(bridge.hostVersion).toBe('3.9.x');
    expect(typeof bridge.notify).toBe('function');
    expect(typeof bridge.setBadge).toBe('function');
    expect(bridge.nativeSend).toBeUndefined();
    expect(bridge.contacts).toBeUndefined();
  });

  it('bridgeFromShell 缺全部能力时得到空能力桥，调用不炸', async () => {
    const bridge = bridgeFromShell({});
    expect(bridge.host).toBe('wechat-pc');
    const gateway = new HostGateway();
    gateway.attach(bridge);
    expect(gateway.capabilities()).toEqual([]);
    await expect(gateway.notify({ title: 'a', body: 'b' })).resolves.toBe(false);
  });

  it('notify 回调把 route 接到 showPanel 上', () => {
    const notifyNative = vi.fn();
    const showPanelNative = vi.fn();
    const bridge = bridgeFromShell({ notifyNative, showPanelNative });
    void bridge.notify?.({ title: 't', body: 'b', route: '#/guard' });
    const arg = notifyNative.mock.calls[0]?.[0] as { onClick?: () => void };
    expect(typeof arg.onClick).toBe('function');
    arg.onClick?.();
    expect(showPanelNative).toHaveBeenCalledWith('#/guard');
  });
});

describe('内置面板', () => {
  it('渲染出完整单文件面板：内联样式、内联脚本、零外部资源', () => {
    const html = renderPanel();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
    // 零外部依赖：客户端 WebView 常常没有外网，任何 CDN 引用都会让面板半死不活。
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet[^>]*href=["']https?:/i);
    expect(html).not.toMatch(/https?:\/\/[^"')\s]+\.(js|css)/i);
  });

  it('内联品牌 Logo，并把作者信息写进关于页', () => {
    const html = renderPanel();
    if (brandIcon()) {
      expect(html).toContain('data:image/png;base64,');
    }
    expect(html).toContain(BRAND.author);
    expect(html).toContain(BRAND.website);
    expect(html).toContain(BRAND.qqGroups[0] as string);
  });

  it('九个视图全部在面板里注册', () => {
    const html = renderPanel();
    for (const view of ['dashboard', 'activity', 'heatmap', 'members', 'guard', 'knowledge', 'ai', 'rules', 'about']) {
      expect(html).toContain(`'${view}'`);
    }
  });

  it('脚本可控：不出现未转义的模板拼接（XSS 面收敛在 esc 上）', () => {
    const html = renderPanel({ title: '<img onerror=alert(1)>' });
    expect(html).not.toContain('<img onerror=alert(1)>');
    expect(html).toContain('&lt;img onerror=alert(1)&gt;');
  });

  it('品牌横幅与配色可用', () => {
    expect(asciiBanner()).toContain(BRAND.name);
    expect(asciiBanner()).toContain(BRAND.author);
  });
});
