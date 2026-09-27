import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AnalyticsEngine, DAY_MS, lastDays } from '../analytics/index.js';
import { GroupManager } from '../manage/index.js';
import { renderReport } from '../plugins/analytics.js';
import { renderPanel } from '../client/panel.js';
import { BRAND } from '../client/brand.js';
import type { AppConfig } from '../core/config.js';
import type { Engine } from '../runtime/engine.js';
import type { AiService } from '../ai/index.js';
import type { Logger } from 'pino';

/**
 * HTTP 面板 / API。
 *
 * 为什么自带面板而不是只出数据：群运营的实际使用场景是「群主在手机上瞄一眼」，
 * 要求对方自己接 BI 等于不做。这里返回自包含的单页 HTML（零构建、零 CDN 依赖），
 * 离线环境也能打开。
 *
 * 安全默认值：只监听 127.0.0.1。要让外网访问必须同时配 token，
 * 因为看板数据包含群成员与聊天内容，属敏感信息。
 */

export interface ApiServerOptions {
  engine: Engine;
  config: AppConfig;
  logger: Logger;
  ai?: AiService;
  /** 客户端宿主句柄：存在时面板走客户端版渲染，并暴露宿主状态接口。 */
  client?: import('../client/host.js').ClientHost;
}

export function buildServer(options: ApiServerOptions): FastifyInstance {
  const { engine, config, logger } = options;
  const analytics = new AnalyticsEngine(engine.store, config.analytics.hourlyBuckets);
  const manager = new GroupManager(engine.store);

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  app.addHook('onRequest', async (request, reply) => {
    if (config.api.corsOrigins.length > 0) {
      const origin = request.headers.origin;
      if (origin && config.api.corsOrigins.includes(origin)) {
        void reply.header('access-control-allow-origin', origin);
        void reply.header('access-control-allow-headers', 'content-type, authorization');
      }
    }
    if (request.method === 'OPTIONS') {
      void reply.code(204).send();
      return;
    }
    // 无 token 时不鉴权——这仅在监听回环地址时安全，所以在启动时校验（见 assertSafeBinding）。
    if (!config.api.token) return;
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : String(request.headers['x-wechatpro-token'] ?? '');
    if (token !== config.api.token) {
      void reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({
    ok: true,
    stats: engine.stats,
    conversations: engine.store.listConversations().length,
    aiEnabled: Boolean(options.ai?.enabled),
    now: Date.now(),
  }));

  app.get('/api/conversations', async () => ({
    items: manager.listConversations().map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      messageCount: row.message_count,
      memberCount: row.member_count,
      lastSeenAt: row.last_seen_at,
    })),
  }));

  const rangeQuery = z.object({
    from: z.coerce.number().optional(),
    to: z.coerce.number().optional(),
    days: z.coerce.number().optional(),
  });

  function resolveRange(query: { from?: number; to?: number; days?: number }): { from: number; to: number } {
    if (query.from !== undefined) return { from: query.from, to: query.to ?? 0 };
    return lastDays(query.days ?? 7);
  }

  app.get('/api/conversations/:id/activity', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = rangeQuery.parse(request.query ?? {});
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    return analytics.activity(id, resolveRange(query));
  });

  app.get('/api/conversations/:id/heatmap', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = rangeQuery.parse(request.query ?? {});
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    return analytics.heatmap(id, resolveRange(query));
  });

  app.get('/api/conversations/:id/trend', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = rangeQuery.parse(request.query ?? {});
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    return analytics.trend(id, resolveRange(query));
  });

  app.get('/api/conversations/:id/topics', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({ limit: z.coerce.number().optional() }).parse(request.query ?? {});
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    return analytics.topics(id, query.limit ?? 50);
  });

  app.get('/api/conversations/:id/report', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({
      days: z.coerce.number().optional(),
      intent: z.enum(['stats', 'heatmap', 'top']).optional(),
    }).parse(request.query ?? {});
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    const range = resolveRange(query);
    return {
      text: renderReport(analytics, query.intent ?? 'stats', id, range),
      range,
    };
  });

  app.get('/api/conversations/:id/members', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    const now = Date.now();
    return {
      items: manager.listMembers(id).map((member) => {
        const lifecycle = manager.memberLifecycle(id, member.id, now);
        return {
          id: member.id,
          displayName: member.display_name,
          messageCount: member.message_count,
          firstSeenAt: member.first_seen_at,
          lastSeenAt: member.last_seen_at,
          stage: lifecycle?.stage ?? 'active',
          silentDays: lifecycle?.silentDays ?? 0,
          lastWeekMessages: lifecycle?.lastWeekMessages ?? 0,
        };
      }),
    };
  });

  app.get('/api/conversations/:id/members/:memberId/profile', async (request, reply) => {
    const { id, memberId } = request.params as { id: string; memberId: string };
    const profile = analytics.memberProfile(id, memberId);
    if (!profile) return reply.code(404).send({ error: 'member not found' });
    const lifecycle = manager.memberLifecycle(id, memberId);
    return { ...profile, lifecycle };
  });

  app.get('/api/conversations/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({ limit: z.coerce.number().optional() }).parse(request.query ?? {});
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    return { items: engine.store.recentEvents(id, query.limit ?? 50, 'guard') };
  });

  app.get('/api/conversations/:id/knowledge', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    return { items: manager.listKnowledge(id) };
  });

  app.post('/api/conversations/:id/knowledge', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        category: z.enum(['规则', '资源', 'FAQ', '决定', '其他']).default('其他'),
        content: z.string().min(1).max(4000),
        sourceMessageId: z.string().optional(),
      })
      .parse(request.body ?? {});
    const entry = manager.addKnowledge({
      conversationId: id,
      category: body.category,
      content: body.content,
      sourceMessageId: body.sourceMessageId,
    });
    return reply.code(201).send(entry);
  });

  app.delete('/api/conversations/:id/knowledge/:entryId', async (request, reply) => {
    const { id, entryId } = request.params as { id: string; entryId: string };
    const removed = manager.removeKnowledge(id, Number(entryId));
    if (!removed) return reply.code(404).send({ error: 'knowledge not found' });
    return { ok: true };
  });

  app.get('/api/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = z.object({ limit: z.coerce.number().optional() }).parse(request.query ?? {});
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    return {
      items: manager.recentMessages(id, Math.min(query.limit ?? 50, 500)).map((message) => ({
        id: message.id,
        sender: message.sender.displayName,
        kind: message.kind,
        text: message.text,
        summary: message.summary,
        at: message.timestamp,
      })),
    };
  });

  app.post('/api/conversations/:id/summary', async (request, reply) => {
    // 摘要始终可用：AI 关闭时 AiService 会退化为统计口径摘要，仍是有用的信息。
    if (!options.ai) return reply.code(503).send({ error: 'ai disabled' });
    const { id } = request.params as { id: string };
    const body = z
      .object({ focus: z.string().optional(), limit: z.number().int().positive().max(2000).optional() })
      .parse(request.body ?? {});
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    return options.ai.summarize(id, body);
  });

  app.post('/api/conversations/:id/ask', async (request, reply) => {
    if (!options.ai) return reply.code(503).send({ error: 'ai disabled' });
    const { id } = request.params as { id: string };
    const body = z.object({ question: z.string().min(1) }).parse(request.body ?? {});
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    const answer = await options.ai.ask(id, body.question);
    if (!answer) return reply.code(503).send({ error: 'ai disabled' });
    return answer;
  });

  app.get('/api/rules', async () => ({
    alertThreshold: config.guard.alertThreshold,
    windowMs: config.guard.windowMs,
    rules: config.guard.rules.map((rule) => ({
      id: rule.id,
      description: rule.description,
      enabled: rule.enabled,
      action: rule.action,
      weight: rule.weight,
    })),
  }));

  app.get('/api/stats', async () => {
    const conversations = engine.store.listConversations();
    const totalMessages = conversations.reduce((sum, row) => sum + row.message_count, 0);
    return {
      ...engine.stats,
      conversations: conversations.length,
      totalMessages,
      aiEnabled: Boolean(options.ai?.enabled),
    };
  });

  app.get('/', async (_request, reply) => {
    void reply.header('content-type', 'text/html; charset=utf-8');
    // 有客户端宿主时用客户端面板（带宿主能力区块与品牌信息），否则用通用控制台。
    return options.client ? renderPanel() : renderConsole();
  });

  /** 面板单文件导出：离线预览、或塞进客户端插件的资源目录。 */
  app.get('/panel.html', async (_request, reply) => {
    void reply.header('content-type', 'text/html; charset=utf-8');
    return renderPanel();
  });

  /**
   * 宿主状态。
   *
   * 面板「关于」页与 `wechatpro doctor` 都读它。字段刻意包含能力清单而不只是布尔值：
   * 排查「为什么没弹通知」时，第一要确认的就是宿主到底有没有注册 `notify`。
   */
  app.get('/api/client', async () => {
    const client = options.client;
    return {
      enabled: Boolean(client),
      host: client?.host ?? 'none',
      panelRoute: client?.panelRoute ?? config.client.panelRoute,
      capabilities: client?.capabilities() ?? [],
      notifyOnAlert: config.client.notifyOnAlert,
      badgeMax: config.client.badgeMax,
      callStats: client?.gateway.callStats() ?? [],
      brand: BRAND,
    };
  });

  /**
   * 宿主注入入口（HTTP 形态）。
   *
   * 客户端插件壳在能直接 `inject()` 时不必用它；插件跑在辅助进程、
   * 或调试时想用 curl 灌数据，就走这里。与 `/webhook` 的区别是它接受
   * **微信 PC 原生字段**（`StrTalker`/`StrContent`…），不需要调用方先转换。
   */
  app.post('/api/ingest', async (request, reply) => {
    const client = options.client;
    if (!client) return reply.code(503).send({ error: 'client mode disabled' });
    const body = request.body as unknown;
    if (Array.isArray(body)) {
      return client.ingestBatch(body as Array<Record<string, unknown>>);
    }
    const result = await client.ingest(body as Record<string, unknown>);
    return reply.code(result.accepted ? 202 : 422).send(result);
  });

  /**
   * 让宿主把面板拉到前台（例如群内 `/面板` 指令、或风控告警点击后跳转）。
   * 同时清掉角标——用户已经看到了。
   */
  app.post('/api/client/focus', async (request, reply) => {
    const client = options.client;
    if (!client) return reply.code(503).send({ error: 'client mode disabled' });
    const body = z.object({ route: z.string().optional() }).parse(request.body ?? {});
    return client.focus(body.route);
  });

  /** 群档案导出：交给宿主弹原生保存对话框；宿主不支持时返回内容让前端自己下载。 */
  app.get('/api/conversations/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!engine.store.getConversation(id)) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    const payload = manager.exportConversation(id);
    const filename = `wechatpro-${id.replace(/[@:]/, '_')}.json`;
    const content = JSON.stringify(payload, null, 2);
    const saved = options.client
      ? await options.client.gateway.exportFile({ filename, content })
      : null;
    return { filename, savedTo: saved, content: saved ? undefined : content };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      void reply.code(400).send({ error: 'invalid request', issues: error.issues });
      return;
    }
    logger.error({ err: error }, 'API 请求处理失败');
    void reply.code(500).send({ error: 'internal error' });
  });

  return app;
}

/**
 * 绑定地址安全校验。
 *
 * 监听非回环地址却不配 token，等于把社群的聊天记录公开在网络上。
 * 与其写进文档靠人记得，不如启动即拒绝。
 */
export function assertSafeBinding(config: AppConfig): void {
  const isLoopback =
    config.api.host === '127.0.0.1' || config.api.host === 'localhost' || config.api.host === '::1';
  if (!isLoopback && !config.api.token) {
    throw new Error(
      `拒绝启动：api.host=${config.api.host} 非回环地址但未配置 api.token，会导致群聊数据无鉴权暴露。`,
    );
  }
}

/**
 * 自包含控制台页面。
 *
 * 单文件内联 CSS/JS，不引任何外部资源：内网部署经常无法访问 CDN，
 * 页面必须能离线打开。数据全部走同源 `/api/*`。
 */
function renderConsole(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeChatPro 控制台</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --panel:#181b22; --line:#272b34; --fg:#e6e8ee; --muted:#8b93a7; --accent:#4f8cff; --warn:#ffb020; --danger:#ff5d5d; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; }
  header .muted { color:var(--muted); font-size:12px; }
  main { padding:20px; display:grid; gap:16px; grid-template-columns: minmax(240px, 1fr) 3fr; }
  @media (max-width: 820px) { main { grid-template-columns: 1fr; } }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .panel h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 10px; }
  .conv { padding:8px 10px; border-radius:8px; cursor:pointer; border:1px solid transparent; }
  .conv:hover { background:#20242e; }
  .conv.active { border-color:var(--accent); background:#1d2534; }
  .conv .name { font-weight:600; }
  .conv .sub { color:var(--muted); font-size:12px; }
  .cards { display:grid; gap:10px; grid-template-columns:repeat(auto-fit, minmax(130px,1fr)); }
  .card { background:#141821; border:1px solid var(--line); border-radius:8px; padding:10px; }
  .card .k { color:var(--muted); font-size:12px; }
  .card .v { font-size:20px; font-weight:600; margin-top:2px; }
  .heat { display:grid; grid-template-columns:repeat(24, 1fr); gap:2px; }

  .cell { aspect-ratio:1; border-radius:2px; background:#1c2029; }
  .bars { display:grid; gap:6px; }
  .bar { display:grid; grid-template-columns:110px 1fr 56px; align-items:center; gap:8px; font-size:12px; }
  .bar .track { background:#1c2029; border-radius:4px; height:14px; overflow:hidden; }
  .bar .fill { height:100%; background:var(--accent); }
  .tags { display:flex; gap:6px; flex-wrap:wrap; }
  .tag { background:#1c2029; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; color:var(--muted); }
  .event { font-size:12px; padding:6px 0; border-bottom:1px solid var(--line); }
  .event .sev-high { color:var(--danger); } .event .sev-medium { color:var(--warn); } .event .sev-low { color:var(--muted); }
  pre { white-space:pre-wrap; word-break:break-word; font-size:12px; color:var(--muted); margin:0; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:6px 12px; cursor:pointer; font-size:13px; }
  input, select { background:#141821; border:1px solid var(--line); color:var(--fg); border-radius:6px; padding:6px 8px; font-size:13px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .err { color:var(--danger); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>WeChatPro</h1>
  <span class="muted" id="status">加载中…</span>
</header>
<main>
  <section class="panel">
    <h2>群聊</h2>
    <div id="convs"></div>
    <h2 style="margin-top:16px">指令</h2>
    <div class="row">
      <input id="q" placeholder="问群内问题，如：团建时间定了吗" style="flex:1">
      <button id="ask">提问</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button id="summary">生成摘要</button>
    </div>
    <p class="err" id="aiErr"></p>
  </section>
  <section style="display:grid;gap:16px">
    <div class="panel"><h2>概览</h2><div class="cards" id="cards"></div></div>
    <div class="panel"><h2>活跃时段热力图（周 × 小时）</h2><div class="heat" id="heat"></div></div>
    <div class="panel"><h2>发言排行</h2><div class="bars" id="top"></div></div>
    <div class="panel"><h2>热门话题</h2><div class="tags" id="topics"></div></div>
    <div class="panel"><h2>风控事件</h2><div id="events"></div></div>
    <div class="panel"><h2>摘要 / 回答</h2><pre id="out">选择群聊后点击上方按钮。</pre></div>
  </section>
</main>
<script>
const api = (path, init) => fetch(path, init).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
});
let current = null;

const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];

async function loadConversations() {
  const { items } = await api('/api/conversations');
  const box = document.getElementById('convs');
  box.innerHTML = '';
  if (items.length === 0) { box.innerHTML = '<p class="muted">暂无群聊数据，等待消息接入。</p>'; }
  items.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'conv' + (index === 0 ? ' active' : '');
    el.innerHTML = '<div class="name"></div><div class="sub"></div>';
    el.querySelector('.name').textContent = item.name;
    el.querySelector('.sub').textContent = item.messageCount + ' 条 · ' + item.memberCount + ' 人 · ' + fmt(item.lastSeenAt);
    el.onclick = () => { current = item.id; document.querySelectorAll('.conv').forEach((n) => n.classList.remove('active')); el.classList.add('active'); refresh(); };
    box.appendChild(el);
  });
  if (items.length && !current) { current = items[0].id; }
}

function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-'; }

async function refresh() {
  if (!current) return;
  const days = 7;
  const [activity, heat, topics, events] = await Promise.all([
    api('/api/conversations/' + current + '/activity?days=' + days),
    api('/api/conversations/' + current + '/heatmap?days=' + days),
    api('/api/conversations/' + current + '/topics?limit=30'),
    api('/api/conversations/' + current + '/events?limit=8'),
  ]);
  renderCards(activity);
  renderHeat(heat);
  renderTop(activity);
  renderTopics(topics);
  renderEvents(events);
}

function renderCards(a) {
  const cards = [
    ['总消息', a.totalMessages],
    ['活跃成员', a.activeMembers],
    ['人均', a.messagesPerMember],
    ['日均', a.messagesPerDay],
  ];
  document.getElementById('cards').innerHTML = cards.map(([k, v]) =>
    '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
}

function renderHeat(h) {
  const grid = new Map(h.cells.map((c) => [c.weekday + ':' + c.hour, c.count]));
  const max = Math.max(1, ...h.cells.map((c) => c.count));
  const box = document.getElementById('heat');
  box.innerHTML = '';
  for (let w = 0; w < 7; w++) {
    for (let hour = 0; hour < 24; hour++) {
      const count = grid.get(w + ':' + hour) || 0;
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.title = WEEKDAYS[w] + ' ' + hour + ':00 — ' + count + ' 条';
      cell.style.background = count === 0 ? '#1c2029' : 'rgba(79,140,255,' + (0.15 + 0.85 * count / max).toFixed(3) + ')';
      box.appendChild(cell);
    }
  }
}

function renderTop(a) {
  const members = a.members.slice(0, 8);
  const max = Math.max(1, ...members.map((m) => m.messageCount));
  document.getElementById('top').innerHTML = members.map((m) =>
    '<div class="bar"><span>' + esc(m.displayName) + '</span><div class="track"><div class="fill" style="width:' +
    (100 * m.messageCount / max).toFixed(1) + '%"></div></div><span>' + m.messageCount + '</span></div>').join('')
    || '<p class="muted">暂无数据</p>';
}

function renderTopics(t) {
  document.getElementById('topics').innerHTML = t.words.slice(0, 24).map((w) =>
    '<span class="tag">' + esc(w.word) + ' · ' + w.count + '</span>').join('') || '<p class="muted">暂无数据</p>';
}

function renderEvents(e) {
  document.getElementById('events').innerHTML = e.items.map((item) => {
    let detail = {};
    try { detail = JSON.parse(item.detail); } catch {}
    return '<div class="event"><span class="sev-' + item.severity + '">● ' + item.severity + '</span> ' +
      esc(detail.reason || item.type) + ' <span class="muted">' + esc(item.member_id) + ' · ' + fmt(item.ts) + '</span></div>';
  }).join('') || '<p class="muted">暂无事件</p>';
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

document.getElementById('ask').onclick = async () => {
  const q = document.getElementById('q').value.trim();
  if (!q || !current) return;
  const out = document.getElementById('out'); const err = document.getElementById('aiErr');
  err.textContent = ''; out.textContent = '思考中…';
  try {
    const res = await api('/api/conversations/' + current + '/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }),
    });
    out.textContent = res.answer + '\\n\\n（依据 ' + res.evidenceCount + ' 条历史消息）';
  } catch (e) { out.textContent = ''; err.textContent = '提问失败：' + e.message; }
};

document.getElementById('summary').onclick = async () => {
  if (!current) return;
  const out = document.getElementById('out'); const err = document.getElementById('aiErr');
  err.textContent = ''; out.textContent = '生成中…';
  try {
    const res = await api('/api/conversations/' + current + '/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    out.textContent = res.summary + (res.degraded ? '\\n\\n（AI 未启用，以上为统计口径摘要）' : '');
  } catch (e) { out.textContent = ''; err.textContent = '摘要失败：' + e.message; }
};

(async function boot() {
  try {
    const health = await api('/health');
    document.getElementById('status').textContent = '已接入 ' + health.conversations + ' 个会话 · 接收 ' + health.stats.accepted + ' 条 · AI ' + (health.aiEnabled ? '已启用' : '未启用');
    await loadConversations();
    await refresh();
  } catch (e) {
    document.getElementById('status').textContent = '加载失败：' + e.message;
  }
  setInterval(() => { void refresh(); }, 15000);
})();
</script>
</body>
</html>`;
}

export { renderConsole, DAY_MS };
