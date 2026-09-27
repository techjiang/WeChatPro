import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/runtime/bootstrap.js';
import { extractCommand, HELP_TEXT } from '../src/plugins/command.js';
import { severityOf } from '../src/plugins/guard.js';
import { renderSparkline } from '../src/plugins/analytics.js';
import { GroupManager, classifyStage } from '../src/manage/index.js';
import { createTestEngine, testConfig, message } from './helpers.js';
import { HOUR_MS } from '../src/analytics/index.js';

describe('extractCommand', () => {
  it('识别 / 前缀', () => {
    const decision = extractCommand('/统计');
    expect(decision.isCommand).toBe(true);
    expect(decision.text).toBe('统计');
    expect(decision.reason).toBe('prefix');
  });

  it('识别 @ 机器人并剥离 @ 片段', () => {
    const decision = extractCommand('@机器人 帮我总结今天');
    expect(decision.isCommand).toBe(true);
    expect(decision.text).toContain('总结');
    expect(decision.text).not.toContain('@');
  });

  it('识别别名呼叫', () => {
    expect(extractCommand('小助手 本月排行').isCommand).toBe(true);
  });

  it('普通聊天不算指令', () => {
    expect(extractCommand('大家好啊').isCommand).toBe(false);
  });

  it('纯 @ 无正文时保留原文以便路由', () => {
    const decision = extractCommand('@机器人');
    expect(decision.isCommand).toBe(true);
  });

  it('自定义前缀生效', () => {
    expect(extractCommand('!统计', { prefix: '!' }).text).toBe('统计');
  });
});

describe('severityOf', () => {
  const base = {
    ruleId: 'r',
    ruleDescription: '',
    action: 'alert' as const,
    weight: 10,
    reason: '',
    conversationId: 'g',
    memberId: 'm',
    messageId: 'x',
    breached: true,
    evidence: {},
    at: 0,
  };

  it('按风险分分档', () => {
    expect(severityOf({ ...base, riskScore: 20 })).toBe('low');
    expect(severityOf({ ...base, riskScore: 55 })).toBe('medium');
    expect(severityOf({ ...base, riskScore: 90 })).toBe('high');
  });
});

describe('renderSparkline', () => {
  it('空值用点表示，峰值用满块', () => {
    const line = renderSparkline([0, 5, 10]);
    expect(line[0]).toBe('·');
    expect(line[2]).toBe('█');
  });

  it('全零不抛错', () => {
    expect(renderSparkline([0, 0])).toBe('··');
  });
});

describe('classifyStage', () => {
  it('长期沉默判为 churned', () => {
    expect(classifyStage({ tenureDays: 100, silentDays: 40, lastWeekMessages: 0, total: 500 })).toBe('churned');
  });

  it('两周沉默判为 dormant', () => {
    expect(classifyStage({ tenureDays: 100, silentDays: 20, lastWeekMessages: 0, total: 500 })).toBe('dormant');
  });

  it('新人阶段独立判断', () => {
    expect(classifyStage({ tenureDays: 3, silentDays: 0, lastWeekMessages: 2, total: 5 })).toBe('newcomer');
  });

  it('高频发言判为核心成员', () => {
    expect(classifyStage({ tenureDays: 200, silentDays: 0, lastWeekMessages: 50, total: 900 })).toBe('core');
  });
});

describe('GroupManager', () => {
  it('知识库去重、检索并累加命中次数', () => {
    const engine = createTestEngine();
    const manager = new GroupManager(engine.store);
    const first = manager.addKnowledge({ conversationId: 'g1', category: '规则', content: '每周五三点例会' });
    const second = manager.addKnowledge({ conversationId: 'g1', category: '规则', content: '每周五三点例会' });
    expect(first.id).toBe(second.id);
    expect(manager.listKnowledge('g1')).toHaveLength(1);

    const found = manager.searchKnowledge('g1', '例会');
    expect(found).toHaveLength(1);
    expect(manager.listKnowledge('g1')[0]?.hits).toBe(1);

    expect(manager.searchKnowledge('g1', '毫无相关的词')).toHaveLength(0);
    engine.store.close();
  });

  it('知识检索不跨会话', () => {
    const engine = createTestEngine();
    const manager = new GroupManager(engine.store);
    manager.addKnowledge({ conversationId: 'g1', category: '规则', content: '甲的规则' });
    expect(manager.searchKnowledge('g2', '规则')).toHaveLength(0);
    engine.store.close();
  });

  it('删除知识', () => {
    const engine = createTestEngine();
    const manager = new GroupManager(engine.store);
    const entry = manager.addKnowledge({ conversationId: 'g1', category: '资源', content: '文档链接' });
    expect(manager.removeKnowledge('g1', entry.id)).toBe(true);
    expect(manager.removeKnowledge('g1', entry.id)).toBe(false);
    engine.store.close();
  });

  it('digest 给出沉默成员与新增成员', () => {
    const engine = createTestEngine();
    const now = Date.now();
    for (let i = 0; i < 6; i += 1) {
      engine.store.insertMessage(
        message({
          id: `old${i}`,
          sender: { id: 'veteran', displayName: '老成员' },
          timestamp: now - 30 * 86_400_000,
        }),
        [],
        HOUR_MS,
      );
    }
    engine.store.insertMessage(
      message({ id: 'new1', sender: { id: 'fresh', displayName: '新成员' }, timestamp: now }),
      [],
      HOUR_MS,
    );

    const digest = new GroupManager(engine.store).digest('g1', now);
    expect(digest?.silentMembers.map((item) => item.member.id)).toContain('veteran');
    expect(digest?.newMembers.map((item) => item.id)).toContain('fresh');
    engine.store.close();
  });

  it('导出群档案包含成员与知识', () => {
    const engine = createTestEngine();
    const manager = new GroupManager(engine.store);
    engine.store.insertMessage(message({ id: 'e1' }), [], HOUR_MS);
    manager.addKnowledge({ conversationId: 'g1', category: '决定', content: '选定方案 A' });

    const payload = manager.exportConversation('g1');
    expect(payload.conversation?.id).toBe('g1');
    expect(payload.members.length).toBeGreaterThan(0);
    expect(payload.knowledge).toHaveLength(1);
    engine.store.close();
  });

  it('留存策略只清理超出保留量的消息', () => {
    const engine = createTestEngine();
    const base = Date.now();
    for (let i = 0; i < 10; i += 1) {
      engine.store.insertMessage(message({ id: `r${i}`, timestamp: base + i * 1000 }), [], HOUR_MS);
    }
    const removed = new GroupManager(engine.store).applyRetention(4);
    expect(removed.g1).toBe(6);
    expect(engine.store.recentMessages('g1', 100)).toHaveLength(4);
    engine.store.close();
  });
});

describe('端到端：消息 → 统计 → 风控 → 指令', () => {
  it('完整链路把消息落库、命中规则并生成报表', async () => {
    const config = testConfig({
      adapters: [
        {
          protocol: 'mock',
          options: {
            intervalMs: 5,
            script: [
              { conversationId: 'g1', conversationName: '产品群', senderId: 'u1', senderName: '张三', text: '本周项目进度同步' },
              { conversationId: 'g1', senderId: 'u2', senderName: '李四', text: '团建定在周五' },
              { conversationId: 'g1', senderId: 'u3', senderName: '广告号', text: '需要代购的加我微信私聊' },
            ],
          },
        },
      ],
      guard: {
        enabled: true,
        alertThreshold: 30,
        windowMs: 600_000,
        rules: [{ id: 'contact-solicitation', enabled: true, weight: 35, action: 'alert' }],
      },
    });

    const { engine, stop } = await bootstrap({
      config,
      withBuiltinPlugins: true,
    });

    const alerts: unknown[] = [];
    engine.bus.on('alert', 'test-collector', (event) => alerts.push(event.payload));

    await engine.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(engine.stats.accepted).toBe(3);
    expect(alerts.length).toBeGreaterThanOrEqual(1);

    const guardEvent = engine.store.recentEvents('g1', 10, 'guard');
    expect(guardEvent.length).toBeGreaterThanOrEqual(1);
    expect(guardEvent[0]?.member_id).toBe('u3');

    const conversations = engine.store.listConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.message_count).toBe(3);

    const members = engine.store.listMembers('g1');
    expect(members).toHaveLength(3);

    await stop();
  });

  it('指令消息被路由为 command 事件并得到回复', async () => {
    const config = testConfig({
      adapters: [
        {
          protocol: 'mock',
          options: {
            intervalMs: 5,
            script: [
              { conversationId: 'g1', senderId: 'u1', senderName: '甲', text: '项目进度同步一下' },
              { conversationId: 'g1', senderId: 'u1', senderName: '甲', text: '/统计' },
            ],
          },
        },
      ],
    });

    const { engine, stop } = await bootstrap({ config });
    const commands: Array<{ intent?: string }> = [];
    engine.bus.on('command', 'test', (event) => commands.push(event.payload as { intent?: string }));

    await engine.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stop();

    expect(commands.length).toBe(1);
    expect(commands[0]?.intent).toBe('stats');
  });

  it('help 指令得到帮助文本回复', async () => {
    const config = testConfig({
      adapters: [
        { protocol: 'mock', options: { intervalMs: 5, script: [{ conversationId: 'g1', senderId: 'u1', text: 'help' }] } },
      ],
    });
    const { engine, stop } = await bootstrap({ config });
    // reply 内部走 engine.sendMessage；mock 适配器不支持 send，这里换成可捕获的桩。
    const sent: string[] = [];
    const sendMessage = engine.sendMessage.bind(engine);
    engine.sendMessage = async (_conversationId: string, text: string) => {
      sent.push(text);
      return true;
    };

    await engine.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await stop();
    engine.sendMessage = sendMessage;
    expect(sent).toContain(HELP_TEXT);
  });

  /**
   * 回归：同一个进程里第二次 `bootstrap()` 也必须能收到宿主注入的消息。
   *
   * 曾经的实现把第一次的 `hostFactory` 永久留在全局注册表里（`registerBuiltinAdapters`
   * 的 `if (!existing.has('host'))`），于是第二次起的 `ClientHost` 拿到的是
   * 只认第一个宿主的适配器，`inject()` 恒返回 `transport-off`。
   * 现象极其隐蔽：**日志一切正常，消息全丢**。宿主热重载、同进程多次启停、
   * 并行测试都会踩到。之前的测试用「所有用例共用一个 ClientHost」绕开了它，
   * 所以这条用例刻意建**两个**宿主来钉死。
   */
  it('同进程第二次 bootstrap 仍能收到宿主注入的消息', async () => {
    const clientConfig = () =>
      testConfig({
        api: { enabled: false },
        client: { enabled: true },
        plugins: [{ name: 'command', enabled: true, options: {} }],
      });

    const payload = {
      MsgSvrID: 'regress-1',
      StrTalker: 'g@chatroom',
      RoomName: '回归群',
      StrSender: 'wxid_a',
      SenderNick: '甲',
      StrContent: '本周进度同步',
      Type: 1,
      CreateTime: 1_790_000_000,
    };

    for (const round of [1, 2, 3]) {
      const first = await bootstrap({ clientMode: true, config: clientConfig() });
      await first.start();
      const result = await first.client!.ingest(payload);
      await first.stop();

      expect(result.accepted, `第 ${round} 次 bootstrap 的消息被丢弃`).toBe(true);
      expect(result.reason).toBeUndefined();
    }
  });

  it('旧 hostFactory 入口同样每次 bootstrap 生效', async () => {
    const { createClientHost } = await import('../src/client/host.js');
    const { registerBuiltinAdapters } = await import('../src/protocols/index.js');

    for (const round of [1, 2]) {
      const host = createClientHost({ host: 'wechat-pc' });
      registerBuiltinAdapters({ hostGateway: host.gateway, hostFactory: async () => host.adapter });

      const config = testConfig({
        api: { enabled: false },
        client: { enabled: true },
        plugins: [{ name: 'command', enabled: true, options: {} }],
      });
      const built = await bootstrap({ clientMode: true, config });
      await built.start();
      const result = await built.client!.ingest({
        MsgSvrID: `legacy-${round}`,
        StrTalker: 'g@chatroom',
        RoomName: '回归群',
        StrSender: 'wxid_a',
        SenderNick: '甲',
        StrContent: 'hello',
        Type: 1,
        CreateTime: 1_790_000_000,
      });
      await built.stop();
      expect(result.accepted, `旧入口第 ${round} 次失败`).toBe(true);
    }
  });
});
