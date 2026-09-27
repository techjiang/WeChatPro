import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, assertSafeBinding } from '../src/api/server.js';
import { AiService } from '../src/ai/index.js';
import { createTestEngine, message, testConfig } from './helpers.js';
import { HOUR_MS } from '../src/analytics/index.js';
import type { FastifyInstance } from 'fastify';
import type { Engine } from '../src/runtime/engine.js';

describe('API server', () => {
  let engine: Engine;
  let app: FastifyInstance;

  beforeEach(async () => {
    engine = createTestEngine(testConfig({ api: { enabled: true, port: 0 } }));
    const now = Date.now();
    for (let i = 0; i < 12; i += 1) {
      engine.store.insertMessage(
        message({
          id: `a${i}`,
          sender: { id: `u${i % 3}`, displayName: `成员${i % 3}` },
          text: i % 2 === 0 ? '项目进度同步' : '团建安排讨论',
          timestamp: now - i * HOUR_MS,
        }),
        ['项目', '团建'],
        HOUR_MS,
      );
    }
    engine.store.insertEvent({
      conversation_id: 'g1',
      member_id: 'u0',
      type: 'guard',
      severity: 'high',
      score: 40,
      detail: JSON.stringify({ reason: '命中敏感词: 刷单' }),
      ts: now,
    });
    app = buildServer({ engine, config: engine.config, logger: engine.logger });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    engine.store.close();
  });

  it('健康检查返回统计', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.conversations).toBe(1);
    expect(body.aiEnabled).toBe(false);
  });

  it('列出会话', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/conversations' })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].messageCount).toBe(12);
  });

  it('活跃度报表', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/conversations/g1/activity?days=7' })).json();
    expect(body.totalMessages).toBe(12);
    expect(body.activeMembers).toBe(3);
  });

  it('热力图返回 24×7 维度', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/conversations/g1/heatmap?days=7' })).json();
    expect(body.hourly).toHaveLength(24);
    expect(body.weekday).toHaveLength(7);
  });

  it('趋势与话题', async () => {
    const trend = (await app.inject({ method: 'GET', url: '/api/conversations/g1/trend?days=7' })).json();
    expect(trend.total).toBe(12);
    const topics = (await app.inject({ method: 'GET', url: '/api/conversations/g1/topics?limit=5' })).json();
    expect(topics.words.length).toBeGreaterThan(0);
  });

  it('文本报表可直接读', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/conversations/g1/report?days=7&intent=top' })).json();
    expect(body.text).toContain('排行');
  });

  it('成员列表带生命周期阶段', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/conversations/g1/members' })).json();
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toHaveProperty('stage');
  });

  it('成员画像', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/conversations/g1/members/u0/profile' })).json();
    expect(body.member.id).toBe('u0');
    expect(body.messageCount).toBe(4);
  });

  it('风控事件可查询', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/conversations/g1/events' })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].severity).toBe('high');
  });

  it('知识库增删查', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations/g1/knowledge',
      payload: { category: '规则', content: '每周五下午三点例会' },
    });
    expect(created.statusCode).toBe(201);
    const entry = created.json();
    expect(entry.category).toBe('规则');

    const list = (await app.inject({ method: 'GET', url: '/api/conversations/g1/knowledge' })).json();
    expect(list.items).toHaveLength(1);

    const removed = await app.inject({ method: 'DELETE', url: `/api/conversations/g1/knowledge/${entry.id}` });
    expect(removed.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/conversations/g1/knowledge' })).json();
    expect(after.items).toHaveLength(0);
  });

  it('重复知识不产生重复条目', async () => {
    const payload = { category: '规则', content: '同一条规定' };
    const first = (await app.inject({ method: 'POST', url: '/api/conversations/g1/knowledge', payload })).json();
    const second = (await app.inject({ method: 'POST', url: '/api/conversations/g1/knowledge', payload })).json();
    expect(first.id).toBe(second.id);
  });

  it('未知会话返回 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/conversations/nope/activity' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/conversations/nope/members' })).statusCode).toBe(404);
  });

  it('AI 未配置时摘要降级为统计口径', async () => {
    // api 未启用 ai 时 bootstrap 不会构造 AiService；这里传一个「AI 关闭」的实例，
    // 验证摘要仍有可用输出（问答无降级路径，属未实现能力）。
    const offAi = new AiService({ config: engine.config, store: engine.store, logger: engine.logger });
    const withOffAi = buildServer({ engine, config: engine.config, logger: engine.logger, ai: offAi });
    await withOffAi.ready();

    const summary = await withOffAi.inject({ method: 'POST', url: '/api/conversations/g1/summary', payload: {} });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().degraded).toBe(true);
    expect(summary.json().summary).toContain('统计口径');

    const ask = await withOffAi.inject({
      method: 'POST',
      url: '/api/conversations/g1/ask',
      payload: { question: '团建什么时候' },
    });
    expect(ask.statusCode).toBe(503);
    await withOffAi.close();
  });

  it('未接入 AI 服务时摘要接口返回 503', async () => {
    const noAi = buildServer({ engine, config: engine.config, logger: engine.logger });
    await noAi.ready();
    const response = await noAi.inject({ method: 'POST', url: '/api/conversations/g1/summary', payload: {} });
    expect(response.statusCode).toBe(503);
    await noAi.close();
  });

  it('参数校验失败返回 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/conversations/g1/knowledge',
      payload: { content: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('规则接口返回阈值与规则', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/rules' })).json();
    expect(body).toHaveProperty('alertThreshold');
    expect(Array.isArray(body.rules)).toBe(true);
  });

  it('控制台页面自包含（无外部资源）', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).not.toMatch(/https?:\/\/cdn/);
    expect(response.body).toContain('WeChatPro');
  });

  it('配置 token 后未授权请求被拒', async () => {
    const secured = buildServer({
      engine,
      config: testConfig({ api: { enabled: true, token: 'secret-token' } }),
      logger: engine.logger,
    });
    await secured.ready();
    expect((await secured.inject({ method: 'GET', url: '/health' })).statusCode).toBe(401);
    const ok = await secured.inject({ method: 'GET', url: '/health', headers: { authorization: 'Bearer secret-token' } });
    expect(ok.statusCode).toBe(200);
    await secured.close();
  });

  it('AI 可用时摘要走模型', async () => {
    const config = testConfig({ ai: { enabled: true } });
    const ai = new AiService({
      config,
      store: engine.store,
      logger: engine.logger,
    });
    // 用桩替换网关，避免真实网络调用
    (ai as unknown as { gateway: unknown }).gateway = {
      defaultModel: 'stub',
      chat: async () => ({ content: 'AI 生成的摘要', model: 'stub' }),
    };
    (ai as unknown as { summarizer: unknown }).summarizer = {
      summarize: async () => ({ summary: 'AI 生成的摘要', coveredMessages: 12, segments: 1 }),
      answer: async () => ({ answer: 'AI 生成的回答' }),
    };

    const withAi = buildServer({ engine, config, logger: engine.logger, ai });
    await withAi.ready();
    const summary = await withAi.inject({ method: 'POST', url: '/api/conversations/g1/summary', payload: {} });
    expect(summary.json().summary).toContain('AI 生成');
    expect(summary.json().degraded).toBe(false);

    const ask = await withAi.inject({
      method: 'POST',
      url: '/api/conversations/g1/ask',
      payload: { question: '团建安排' },
    });
    expect(ask.json().answer).toContain('AI 生成');
    await withAi.close();
  });
});

describe('assertSafeBinding', () => {
  it('非回环地址无 token 时拒绝启动', () => {
    expect(() => assertSafeBinding(testConfig({ api: { host: '0.0.0.0', token: '' } }))).toThrow(/拒绝启动/);
  });

  it('非回环地址配 token 时允许', () => {
    expect(() => assertSafeBinding(testConfig({ api: { host: '0.0.0.0', token: 'x' } }))).not.toThrow();
  });

  it('回环地址无 token 时允许', () => {
    expect(() => assertSafeBinding(testConfig({ api: { host: '127.0.0.1' } }))).not.toThrow();
  });
});
