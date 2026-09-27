import { BRAND, brandIcon, BRAND_COLORS } from './brand.js';

/**
 * 客户端内置面板（单文件、零依赖、可离线）。
 *
 * 为什么不用前端框架：这个面板要在**微信 PC 客户端的嵌入式浏览器**里打开。
 * 那类环境有三个硬约束——(1) 可能没有外网，加载不到 CDN；(2) `file://` 协议下
 * 部分 API 受限；(3) 客户端 WebView 内核版本不可控。所以整个面板压成一个 HTML，
 * CSS/JS 全内联，构建期零打包，打开即用。
 *
 * 数据面：面板只认 `/api/*`，因此同一份 UI 既能被客户端宿主内嵌，也能用
 * `wechatpro ui --out panel.html` 导出成离线单文件，对着已有 SQLite 库预览。
 *
 * 安全：所有用户数据经 `esc()` 转义后才插入 DOM；`innerHTML` 只用于我们自己的模板。
 */

export interface PanelOptions {
  /** 面板标题。 */
  title?: string;
  /** 是否渲染「宿主能力」区块（客户端内嵌时才有意义）。 */
  showHost?: boolean;
}

export function renderPanel(options: PanelOptions = {}): string {
  const icon = brandIcon();
  const title = options.title ?? `${BRAND.name} · ${BRAND.tagline}`;
  const color = BRAND_COLORS;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${icon ?? ''}">
<style>
  :root {
    --deep:${color.deep}; --navy:${color.navy}; --cyan:${color.cyan};
    --ice:${color.ice}; --silver:${color.silver};
    --bg:${color.deep}; --panel:#0f2440; --line:#1d3b5e; --fg:${color.ice};
    --muted:#8ba7c4; --good:#3ecf8e; --warn:#ffb020; --danger:#ff6b6b;
    --radius:10px;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; }
  body {
    font:13px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    background:linear-gradient(160deg,#08152a 0%, var(--deep) 55%, #071022 100%);
    color:var(--fg);
  }
  /* 侧栏 + 内容区，窄屏（客户端右侧栏常只有 360px）自动折叠成上下布局 */
  .shell { display:grid; grid-template-columns:236px 1fr; height:100%; min-height:100vh; }
  @media (max-width:740px) { .shell { grid-template-columns:1fr; } }
  aside { background:rgba(6,18,34,.72); border-right:1px solid var(--line); display:flex; flex-direction:column; }
  @media (max-width:740px) { aside { border-right:0; border-bottom:1px solid var(--line); } }
  .brand { display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid var(--line); }
  .brand img { width:38px; height:38px; border-radius:50%; box-shadow:0 0 0 2px rgba(46,197,197,.35); }
  .brand .n { font-weight:700; font-size:15px; letter-spacing:.02em; }
  .brand .s { color:var(--muted); font-size:11px; }
  .health { padding:10px 16px; font-size:11px; color:var(--muted); border-bottom:1px solid var(--line); }
  .health b { color:var(--cyan); font-weight:600; }
  nav { padding:8px; overflow:auto; display:flex; flex-direction:column; gap:2px; }
  nav button {
    all:unset; cursor:pointer; padding:8px 10px; border-radius:8px; display:flex; align-items:center;
    gap:8px; font-size:13px; color:var(--fg);
  }
  nav button:hover { background:rgba(46,197,197,.09); }
  nav button.on { background:rgba(46,197,197,.16); color:#fff; box-shadow:inset 2px 0 0 var(--cyan); }
  nav button .badge { margin-left:auto; background:var(--danger); color:#fff; border-radius:999px; padding:0 6px; font-size:10px; }
  .hostbox { margin-top:auto; padding:10px 14px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); }
  .hostbox .cap { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:0 6px; margin:2px 2px 0 0; }
  main { overflow:auto; padding:16px 18px 40px; }
  h1 { font-size:16px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:12px; margin-bottom:14px; }
  .panel { background:rgba(15,36,64,.72); border:1px solid var(--line); border-radius:var(--radius); padding:13px 15px; margin-bottom:14px; }
  .panel h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 10px; }
  .cards { display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(112px,1fr)); }
  .card { background:rgba(8,21,42,.7); border:1px solid var(--line); border-radius:8px; padding:9px 11px; }
  .card .k { color:var(--muted); font-size:11px; }
  .card .v { font-size:19px; font-weight:700; margin-top:1px; }
  .card .v.cy { color:var(--cyan); }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  input,select,textarea {
    background:rgba(8,21,42,.85); border:1px solid var(--line); color:var(--fg);
    border-radius:7px; padding:6px 9px; font-size:12px; font-family:inherit;
  }
  textarea { width:100%; min-height:70px; resize:vertical; }
  button.act { background:linear-gradient(180deg,var(--cyan),#1f9d9d); color:#05202a; border:0; font-weight:700;
    border-radius:7px; padding:6px 13px; cursor:pointer; font-size:12px; }
  button.act.ghost { background:transparent; color:var(--cyan); border:1px solid var(--line); font-weight:600; }
  button.act:disabled { opacity:.45; cursor:not-allowed; }
  .list { display:flex; flex-direction:column; gap:6px; max-height:420px; overflow:auto; }
  .conv { text-align:left; width:100%; border:1px solid transparent; background:rgba(8,21,42,.5);
    border-radius:8px; padding:7px 10px; cursor:pointer; color:var(--fg); }
  .conv:hover { border-color:var(--line); }
  .conv.on { border-color:var(--cyan); background:rgba(46,197,197,.09); }
  .conv .n { font-weight:600; }
  .conv .m { color:var(--muted); font-size:11px; }
  .heat { display:grid; grid-template-columns:repeat(25,1fr); gap:2px; }
  .heat .hd { font-size:9px; color:var(--muted); text-align:center; }
  .cell { aspect-ratio:1; border-radius:2px; background:#122a45; }
  .bars { display:flex; flex-direction:column; gap:5px; }
  .bar { display:grid; grid-template-columns:104px 1fr 52px; gap:8px; align-items:center; font-size:12px; }
  .bar .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar .track { background:#122a45; border-radius:4px; height:13px; overflow:hidden; }
  .bar .fill { height:100%; background:linear-gradient(90deg,#1f9d9d,var(--cyan)); }
  .tags { display:flex; flex-wrap:wrap; gap:6px; }
  .tag { background:rgba(46,197,197,.1); border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:11px; color:var(--silver); }
  .ev { border-left:3px solid var(--line); padding:5px 0 5px 9px; font-size:12px; margin-bottom:6px; }
  .ev.high { border-color:var(--danger); } .ev.medium { border-color:var(--warn); } .ev.low { border-color:var(--muted); }
  .ev .rs { color:var(--muted); font-size:11px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  tr:hover td { background:rgba(46,197,197,.05); }
  pre { white-space:pre-wrap; word-break:break-word; font-size:12px; margin:0; color:var(--ice); }
  .muted { color:var(--muted); font-size:12px; }
  .err { color:var(--danger); font-size:12px; }
  .ok { color:var(--good); }
  .legal { border:1px solid rgba(255,107,107,.4); background:rgba(255,107,107,.07); border-radius:10px; padding:12px 14px; }
  .legal h2 { color:var(--danger); }
  .legal ol, .legal ul { margin:8px 0 0; padding-left:18px; font-size:12px; line-height:1.75; color:var(--ice); }
  .legal li { margin-bottom:5px; }
  .legal .sec { margin-top:12px; }
  .legal .sec > .t { font-size:12px; font-weight:600; color:var(--cyan); margin-bottom:2px; }
  .legal strong { color:#fff; }
  .legal .tail { margin-top:12px; font-size:12px; color:var(--muted); }
  .kv { display:grid; grid-template-columns:88px 1fr; gap:4px 10px; font-size:12px; }
  .kv .k { color:var(--muted); }
  .toast { position:fixed; right:14px; bottom:14px; background:rgba(15,36,64,.96); border:1px solid var(--line);
    border-radius:8px; padding:9px 13px; font-size:12px; max-width:320px; box-shadow:0 8px 24px rgba(0,0,0,.45);
    opacity:0; transform:translateY(8px); transition:all .22s; pointer-events:none; }
  .toast.show { opacity:1; transform:none; }
  .spin { display:inline-block; width:11px; height:11px; border:2px solid rgba(46,197,197,.3);
    border-top-color:var(--cyan); border-radius:50%; animation:sp .7s linear infinite; vertical-align:-1px; }
  @keyframes sp { to { transform:rotate(360deg); } }
  .hide { display:none !important; }
</style>
</head>
<body>
<div class="shell">
  <aside>
    <div class="brand">
      ${icon ? `<img src="${icon}" alt="${escapeHtml(BRAND.name)} Logo">` : ''}
      <div>
        <div class="n">${escapeHtml(BRAND.name)}</div>
        <div class="s">${escapeHtml(BRAND.tagline)}</div>
      </div>
    </div>
    <div class="health" id="health">连接中…</div>
    <nav id="nav"></nav>
    <div class="hostbox" id="hostbox"></div>
  </aside>
  <main id="main">
    <div class="panel"><h2>加载中</h2><p class="muted"><span class="spin"></span> 正在读取本地数据…</p></div>
  </main>
</div>
<div class="toast" id="toast"></div>
<script>
"use strict";
/* ── 基础设施 ───────────────────────────────────────────────── */
var WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'];
var api = function (path, init) {
  return fetch(path, init).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    });
  });
};
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}
function n(v) { return (v == null ? 0 : v).toLocaleString('zh-CN'); }
function dt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN', { hour12:false }) : '-'; }
function dur(ms) {
  if (!ms) return '-';
  var s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d > 0) return d + ' 天 ' + (h%24) + ' 小时';
  if (h > 0) return h + ' 小时 ' + (m%60) + ' 分';
  if (m > 0) return m + ' 分 ' + (s%60) + ' 秒';
  return s + ' 秒';
}
var toastTimer = null;
function toast(message) {
  var el = document.getElementById('toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
}
/** 宿主桥：客户端内嵌时由宿主注入 window.__WECHATPRO_HOST__，离线导出时为空。 */
var HOST = window.__WECHATPRO_HOST__ || null;
function hostNotify(title, body) {
  if (HOST && typeof HOST.notify === 'function') HOST.notify({ title: title, body: body });
  else toast(title + '：' + body);
}
function hostClipboard(text) {
  if (HOST && typeof HOST.copy === 'function') { HOST.copy(text); toast('已复制到剪贴板'); return; }
  if (navigator.clipboard) { navigator.clipboard.writeText(text).then(function(){ toast('已复制到剪贴板'); }); return; }
  toast('当前环境不支持复制，请手动选择文本');
}

/* ── 状态 ──────────────────────────────────────────────────── */
var state = {
  conversations: [], current: null, days: 7,
  views: [], route: 'dashboard', cache: {}
};
var guardUnread = 0;

/* ── 视图路由 ──────────────────────────────────────────────── */
var VIEWS = [
  { id:'dashboard', label:'📊 仪表盘' },
  { id:'activity',  label:'📈 活跃统计' },
  { id:'heatmap',   label:'🕒 时段热力' },
  { id:'members',   label:'👥 成员台账' },
  { id:'guard',     label:'🛡 风控中心' },
  { id:'knowledge', label:'📚 群知识库' },
  { id:'ai',        label:'🧠 AI 助手' },
  { id:'rules',     label:'⚙️ 规则配置' },
  { id:'health',    label:'🩺 运行自检' },
  { id:'about',     label:'ℹ️ 关于' }
];

function renderNav() {
  var nav = document.getElementById('nav');
  nav.innerHTML = '';
  VIEWS.forEach(function (view) {
    var b = document.createElement('button');
    b.className = state.route === view.id ? 'on' : '';
    b.textContent = view.label;
    if (view.id === 'guard' && guardUnread > 0) {
      var s = document.createElement('span');
      s.className = 'badge'; s.textContent = guardUnread > 99 ? '99+' : String(guardUnread);
      b.appendChild(s);
    }
    b.onclick = function () { go(view.id); };
    nav.appendChild(b);
  });
}

function go(route) {
  state.route = route;
  if (route === 'guard') { guardUnread = 0; }
  renderNav();
  render();
}

/* ── 数据加载 ──────────────────────────────────────────────── */
function loadConversations() {
  return api('/api/conversations').then(function (res) {
    state.conversations = res.items || [];
    if (!state.current && state.conversations.length) state.current = state.conversations[0].id;
  });
}

function conversation() {
  for (var i = 0; i < state.conversations.length; i += 1) {
    if (state.conversations[i].id === state.current) return state.conversations[i];
  }
  return null;
}

function convQuery(extra) {
  return '/api/conversations/' + encodeURIComponent(state.current) + '/activity?days=' + state.days +
    (extra || '');
}

/* ── 渲染 ──────────────────────────────────────────────────── */
/** 这些视图不依赖「选中的群」，没有数据也能正常打开。 */
var GLOBAL_VIEWS = ['about', 'rules', 'health'];

function render() {
  var main = document.getElementById('main');
  if (!state.current && GLOBAL_VIEWS.indexOf(state.route) === -1) {
    main.innerHTML = '<div class="panel"><h2>还没有数据</h2><p class="muted">' +
      '在微信里正常聊天即可，WeChatPro 会自动接收并统计。也可以先用 mock 适配器离线体验：<br>' +
      '<code>node dist/cli.js start --config examples/config.mock.json</code></p></div>';
    return;
  }
  var renderer = RENDERERS[state.route];
  if (typeof renderer !== 'function') {
    main.innerHTML = '<div class="panel"><h2>未知视图</h2><p class="muted">' + esc(state.route) + '</p></div>';
    return;
  }
  main.innerHTML = '<div class="panel"><h2>读取中</h2><p class="muted"><span class="spin"></span> 正在加载 ' +
    esc(state.route) + '…</p></div>';
  // 用 Promise.resolve 包一层：渲染器可能同步返回 undefined（例如无会话时的空实现），
  // 直接 .catch 会抛 TypeError 把整个面板打死。
  Promise.resolve()
    .then(function () { return renderer(); })
    .catch(function (error) {
      main.innerHTML = '<div class="panel"><h2>加载失败</h2><p class="err">' +
        esc(error && error.message ? error.message : String(error)) + '</p>' +
        '<p class="muted">检查引擎是否仍在运行，或刷新面板重试。</p></div>';
    });
}

function header(title, sub) {
  return '<h1>' + esc(title) + '</h1><div class="sub">' + esc(sub) + '</div>';
}

function convSwitcher() {
  if (state.conversations.length === 0) return '';
  var html = '<select id="convSel">';
  state.conversations.forEach(function (item) {
    html += '<option value="' + esc(item.id) + '"' + (item.id === state.current ? ' selected' : '') + '>' +
      esc(item.name) + '（' + n(item.messageCount) + '）</option>';
  });
  html += '</select>';
  return html;
}

function bindConvSwitcher() {
  var sel = document.getElementById('convSel');
  if (!sel) return;
  sel.onchange = function () { state.current = sel.value; state.cache = {}; render(); };
}

var RENDERERS = {};

RENDERERS.dashboard = function () {
  return Promise.all([
    api(convQuery()),
    api('/api/conversations/' + encodeURIComponent(state.current) + '/trend?days=' + state.days),
    api('/api/conversations/' + encodeURIComponent(state.current) + '/events?limit=6'),
    api('/api/stats')
  ]).then(function (r) {
    var activity = r[0], trend = r[1], events = r[2], stats = r[3];
    var c = conversation();
    var dirText = trend.direction === 'rising' ? '↑ 升温' : trend.direction === 'falling' ? '↓ 降温' : '→ 平稳';
    var dirClass = trend.direction === 'rising' ? 'ok' : trend.direction === 'falling' ? 'err' : 'muted';
    var html = header('仪表盘', (c ? c.name : '') + ' · 近 ' + state.days + ' 天');
    html += '<div class="panel"><h2>概览</h2><div class="cards">' +
      card('总消息', n(activity.totalMessages), true) +
      card('活跃成员', n(activity.activeMembers)) +
      card('人均条数', n(activity.messagesPerMember)) +
      card('日均条数', n(activity.messagesPerDay)) +
      card('趋势', dirText, false, dirClass) +
      card('风控事件', n(stats.conversations ? events.items.length : 0)) +
      '</div></div>';

    html += '<div class="panel"><h2>群聊切换</h2><div class="row">' + convSwitcher() +
      rangePicker() + '<button class="act ghost" id="refresh">刷新</button></div></div>';

    html += '<div class="panel"><h2>最近风控事件</h2>' + renderEvents(events.items) + '</div>';

    html += '<div class="panel"><h2>引擎状态</h2><div class="kv">' +
      kv('会话数', n(stats.conversations)) + kv('累计消息', n(stats.totalMessages)) +
      kv('已接收', n(stats.received)) + kv('去重丢弃', n(stats.duplicates)) +
      kv('AI', stats.aiEnabled ? '已启用' : '未启用（可离线）') +
      kv('运行时长', dur(Date.now() - stats.startedAt)) +
      kv('适配器', (stats.adapters || []).join('、') || '-') +
      '</div></div>';

    document.getElementById('main').innerHTML = html;
    bindConvSwitcher(); bindRange(); bindRefresh();
  });
};

function card(k, v, cyan, cls) {
  return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v' +
    (cyan ? ' cy' : '') + (cls ? ' ' + cls : '') + '">' + esc(v) + '</div></div>';
}
function kv(k, v) { return '<div class="k">' + esc(k) + '</div><div>' + esc(v) + '</div>'; }

function rangePicker() {
  var opts = [1, 3, 7, 30];
  var html = '<select id="rangeSel">';
  opts.forEach(function (d) {
    html += '<option value="' + d + '"' + (d === state.days ? ' selected' : '') + '>近 ' + d + ' 天</option>';
  });
  return html + '</select>';
}
function bindRange() {
  var sel = document.getElementById('rangeSel');
  if (!sel) return;
  sel.onchange = function () { state.days = Number(sel.value); render(); };
}
function bindRefresh() {
  var b = document.getElementById('refresh');
  if (b) b.onclick = function () { render(); toast('已刷新'); };
}

function renderEvents(items) {
  if (!items || items.length === 0) return '<p class="muted">暂无风控事件，群内秩序良好。</p>';
  return items.map(function (item) {
    var detail = {};
    try { detail = JSON.parse(item.detail); } catch (e) { detail = {}; }
    return '<div class="ev ' + esc(item.severity) + '">' +
      '<b>' + esc(detail.reason || item.type) + '</b>' +
      '<div class="rs">' + esc(item.member_id) + ' · 风险分 ' + esc(item.score) + ' · ' + dt(item.ts) + '</div></div>';
  }).join('');
}

RENDERERS.activity = function () {
  return api(convQuery()).then(function (activity) {
    var html = header('活跃统计', '近 ' + state.days + ' 天 · ' + (conversation() || {}).name);
    html += '<div class="panel"><h2>筛选</h2><div class="row">' + convSwitcher() + rangePicker() +
      '<button class="act ghost" id="copy">复制报表</button></div></div>';
    html += '<div class="panel"><h2>消息类型分布</h2><div class="tags">' +
      Object.keys(activity.kinds).map(function (k) {
        return '<span class="tag">' + esc(k) + ' · ' + n(activity.kinds[k]) + '</span>';
      }).join('') + '</div></div>';
    html += '<div class="panel"><h2>发言排行</h2>' + renderBars(activity.members) + '</div>';
    html += '<div class="panel"><h2>成员明细</h2><table><thead><tr>' +
      '<th>成员</th><th>消息</th><th>字数</th><th>均长</th><th>占比</th><th>最后活跃</th>' +
      '</tr></thead><tbody>' + activity.members.map(function (m) {
        return '<tr><td>' + esc(m.displayName) + '</td><td>' + n(m.messageCount) + '</td><td>' +
          n(m.charCount) + '</td><td>' + m.avgChars + '</td><td>' + (m.share * 100).toFixed(1) + '%</td><td>' +
          dt(m.lastSeenAt) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    document.getElementById('main').innerHTML = html;
    bindConvSwitcher(); bindRange();
    var copy = document.getElementById('copy');
    if (copy) copy.onclick = function () {
      hostClipboard(activity.members.slice(0, 20).map(function (m) {
        return m.displayName + '\t' + m.messageCount + '\t' + (m.share * 100).toFixed(1) + '%';
      }).join(String.fromCharCode(10)));
    };
  });
};

function renderBars(members) {
  var list = (members || []).slice(0, 10);
  if (list.length === 0) return '<p class="muted">暂无数据</p>';
  var max = list.reduce(function (a, b) { return Math.max(a, b.messageCount); }, 1);
  return '<div class="bars">' + list.map(function (m) {
    return '<div class="bar"><div class="nm">' + esc(m.displayName) + '</div>' +
      '<div class="track"><div class="fill" style="width:' + (100 * m.messageCount / max).toFixed(1) + '%"></div></div>' +
      '<div>' + n(m.messageCount) + '</div></div>';
  }).join('') + '</div>';
}

RENDERERS.heatmap = function () {
  return api('/api/conversations/' + encodeURIComponent(state.current) + '/heatmap?days=' + state.days)
    .then(function (heat) {
      var grid = {};
      heat.cells.forEach(function (c) { grid[c.weekday + ':' + c.hour] = c.count; });
      var max = heat.cells.reduce(function (a, b) { return Math.max(a, b.count); }, 1);
      var html = header('时段热力', '近 ' + state.days + ' 天 · 找到群里最热闹的时间');
      html += '<div class="panel"><h2>筛选</h2><div class="row">' + convSwitcher() + rangePicker() + '</div></div>';
      html += '<div class="panel"><h2>星期 × 小时</h2><div class="heat">';
      html += '<div class="hd"></div>';
      for (var h = 0; h < 24; h += 1) html += '<div class="hd">' + h + '</div>';
      for (var w = 0; w < 7; w += 1) {
        html += '<div class="hd">' + WEEKDAYS[w].slice(1) + '</div>';
        for (var hh = 0; hh < 24; hh += 1) {
          var count = grid[w + ':' + hh] || 0;
          var alpha = count === 0 ? 0 : (0.12 + 0.88 * count / max);
          html += '<div class="cell" title="' + WEEKDAYS[w] + ' ' + hh + ':00 — ' + count + ' 条" style="background:' +
            (count === 0 ? '#122a45' : 'rgba(46,197,197,' + alpha.toFixed(3) + ')') + '"></div>';
        }
      }
      html += '</div>';
      if (heat.peak) {
        html += '<p class="muted" style="margin-top:10px">最活跃：<b class="ok">' + WEEKDAYS[heat.peak.weekday] + ' ' +
          heat.peak.hour + ':00</b>（' + n(heat.peak.count) + ' 条）｜最冷清：' +
          (heat.quietest ? WEEKDAYS[heat.quietest.weekday] + ' ' + heat.quietest.hour + ':00' : '-') + '</p>';
      }
      html += '</div><div class="panel"><h2>按小时分布</h2>' + renderHourly(heat.hourly) + '</div>';
      document.getElementById('main').innerHTML = html;
      bindConvSwitcher(); bindRange();
    });
};

function renderHourly(hourly) {
  var max = (hourly || []).reduce(function (a, b) { return Math.max(a, b); }, 1);
  return '<div class="bars">' + (hourly || []).map(function (count, hour) {
    return '<div class="bar"><div class="nm">' + hour + ':00</div>' +
      '<div class="track"><div class="fill" style="width:' + (100 * count / max).toFixed(1) + '%"></div></div>' +
      '<div>' + n(count) + '</div></div>';
  }).join('') + '</div>';
}

RENDERERS.members = function () {
  return api('/api/conversations/' + encodeURIComponent(state.current) + '/members').then(function (res) {
    var items = res.items || [];
    var html = header('成员台账', '共 ' + items.length + ' 位成员 · ' + (conversation() || {}).name);
    html += '<div class="panel"><h2>群聊切换</h2><div class="row">' + convSwitcher() + '</div></div>';
    html += '<div class="panel"><h2>分层运营</h2><div class="cards">' +
      card('核心', n(items.filter(function (m) { return m.stage === 'core'; }).length), true) +
      card('活跃', n(items.filter(function (m) { return m.stage === 'active'; }).length)) +
      card('新人', n(items.filter(function (m) { return m.stage === 'newcomer'; }).length)) +
      card('潜水', n(items.filter(function (m) { return m.stage === 'dormant'; }).length)) +
      card('流失', n(items.filter(function (m) { return m.stage === 'churned'; }).length)) +
      '</div></div>';
    html += '<div class="panel"><h2>成员明细</h2><table><thead><tr><th>成员</th><th>消息</th><th>阶段</th>' +
      '<th>沉默</th><th>近 7 天</th><th>最后活跃</th></tr></thead><tbody>' +
      items.map(function (m) {
        return '<tr><td>' + esc(m.displayName) + '</td><td>' + n(m.messageCount) + '</td><td>' +
          esc(stageText(m.stage)) + '</td><td>' + m.silentDays + ' 天</td><td>' + n(m.lastWeekMessages) + '</td><td>' +
          dt(m.lastSeenAt) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    document.getElementById('main').innerHTML = html;
    bindConvSwitcher();
  });
};

function stageText(stage) {
  return { core:'核心', active:'活跃', newcomer:'新人', dormant:'潜水', churned:'流失' }[stage] || stage;
}

RENDERERS.guard = function () {
  return api('/api/conversations/' + encodeURIComponent(state.current) + '/events?limit=80').then(function (res) {
    var items = res.items || [];
    var byRule = {};
    items.forEach(function (item) {
      var detail = {};
      try { detail = JSON.parse(item.detail); } catch (e) { detail = {}; }
      var key = detail.ruleId || item.type;
      byRule[key] = (byRule[key] || 0) + 1;
    });
    var html = header('风控中心', '近 80 条事件 · ' + (conversation() || {}).name);
    html += '<div class="panel"><h2>群聊切换</h2><div class="row">' + convSwitcher() +
      '<button class="act ghost" id="graphql">清理角标</button></div></div>';
    html += '<div class="panel"><h2>命中规则 TOP</h2><div class="tags">' +
      (Object.keys(byRule).length ? Object.keys(byRule).sort(function (a, b) { return byRule[b] - byRule[a]; })
        .slice(0, 12).map(function (k) {
          return '<span class="tag">' + esc(k) + ' · ' + byRule[k] + '</span>';
        }).join('') : '<span class="muted">暂无命中</span>') + '</div></div>';
    html += '<div class="panel"><h2>事件明细</h2>' + renderEvents(items) + '</div>';
    document.getElementById('main').innerHTML = html;
    bindConvSwitcher();
    var b = document.getElementById('graphql');
    if (b) b.onclick = function () {
      if (HOST && typeof HOST.setBadge === 'function') { HOST.setBadge(0); toast('客户端角标已清理'); }
      else toast('当前环境无客户端角标');
    };
  });
};

RENDERERS.knowledge = function () {
  return api('/api/conversations/' + encodeURIComponent(state.current) + '/knowledge').then(function (res) {
    var items = res.items || [];
    var html = header('群知识库', '长期记忆 ' + items.length + ' 条 · 消息被清理也不会丢');
    html += '<div class="panel"><h2>新增知识</h2>' +
      '<div class="row" style="margin-bottom:8px">' + convSwitcher() +
      '<select id="cat"><option>规则</option><option>资源</option><option>FAQ</option><option>决定</option>' +
      '<option>其他</option></select></div>' +
      '<textarea id="content" placeholder="例如：群内禁止发任何形式的广告，违者移出群聊"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="act" id="add">写入知识库</button>' +
      '<button class="act ghost" id="importFile">从文件导入</button></div></div>';
    html += '<div class="panel"><h2>知识条目</h2>' + (items.length === 0
      ? '<p class="muted">知识库为空。把群规、常见问题、重要决定写进来，AI 问答就会引用它们。</p>'
      : items.map(function (entry) {
        return '<div class="ev"><b>' + esc(entry.content) + '</b><div class="rs">' +
          esc(entry.category) + ' · 命中 ' + entry.hits + ' 次 · ' + dt(entry.createdAt) +
          ' <button class="act ghost" style="padding:1px 7px;font-size:11px" data-del="' + entry.id + '">删除</button>' +
          '</div></div>';
      }).join('')) + '</div>';
    document.getElementById('main').innerHTML = html;
    bindConvSwitcher();
    document.getElementById('add').onclick = function () {
      var body = { category: document.getElementById('cat').value, content: document.getElementById('content').value };
      if (!body.content.trim()) { toast('内容不能为空'); return; }
      api('/api/conversations/' + encodeURIComponent(state.current) + '/knowledge', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      }).then(function () { hostNotify('WeChatPro', '知识已写入'); render(); })
        .catch(function (e) { toast('写入失败：' + e.message); });
    };
    document.getElementById('importFile').onclick = function () {
      if (!HOST || typeof HOST.pickFile !== 'function') { toast('当前环境不支持文件选择，请粘贴到文本框'); return; }
      HOST.pickFile({ title: '选择知识库 JSON / 文本' }).then(function (result) {
        if (!result) return;
        var text = typeof result === 'string' ? result : (result.content || '');
        return api('/api/conversations/' + encodeURIComponent(state.current) + '/knowledge/import', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text, filename: result.filename || 'import.txt' })
        }).then(function (res) {
          hostNotify('WeChatPro', '导入 ' + res.imported + ' 条知识');
          render();
        });
      }).catch(function (e) { toast('导入失败：' + e.message); });
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (node) {
      node.onclick = function () {
        api('/api/conversations/' + encodeURIComponent(state.current) + '/knowledge/' + node.getAttribute('data-del'),
          { method: 'DELETE' }).then(function () { render(); });
      };
    });
  });
};

RENDERERS.ai = function () {
  return api('/api/stats').then(function (stats) {
    var html = header('AI 助手', stats.aiEnabled ? '已启用 · 模型 ' + '' : '未启用（AI 关闭时统计功能不受影响）');
    html += '<div class="panel"><h2>群聊切换</h2><div class="row">' + convSwitcher() + '</div></div>';
    html += '<div class="panel"><h2>群内问答</h2><div class="row"><input id="q" style="flex:1" ' +
      'placeholder="例如：团建时间定了吗 / 谁负责后端接口"></div>' +
      '<div class="row" style="margin-top:8px"><button class="act" id="ask">提问</button>' +
      '<button class="act ghost" id="sum">生成摘要</button>' +
      '<button class="act ghost" id="clip">从剪贴板导入问题</button></div>' +
      '<p class="muted" id="hint" style="margin:8px 0 0"></p></div>';
    html += '<div class="panel"><h2>结果</h2><pre id="out">选择群聊后点击提问或生成摘要。</pre></div>';
    document.getElementById('main').innerHTML = html;
    bindConvSwitcher();
    var out = document.getElementById('out'), hint = document.getElementById('hint');
    function post(path, body) {
      out.textContent = '处理中…'; hint.textContent = '';
      return api('/api/conversations/' + encodeURIComponent(state.current) + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      }).then(function (res) {
        out.textContent = res.answer || res.summary || '（无内容）';
        if (res.evidenceCount !== undefined) hint.textContent = '依据 ' + res.evidenceCount + ' 条历史消息作答';
        else if (res.degraded) hint.textContent = 'AI 未启用，以上为统计口径摘要';
        if (res.answer) hostClipboard(res.answer);
      }).catch(function (e) {
        out.textContent = ''; hint.textContent = '失败：' + e.message;
      });
    }
    document.getElementById('ask').onclick = function () {
      var q = document.getElementById('q').value.trim();
      if (!q) { toast('请输入问题'); return; }
      post('/ask', { question: q });
    };
    document.getElementById('sum').onclick = function () { post('/summary', {}); };
    document.getElementById('clip').onclick = function () {
      if (!HOST || typeof HOST.readClipboard !== 'function') { toast('当前环境不支持读取剪贴板'); return; }
      HOST.readClipboard().then(function (text) {
        if (text) { document.getElementById('q').value = String(text).slice(0, 500); toast('已读入剪贴板内容'); }
      });
    };
  });
};

RENDERERS.rules = function () {
  return api('/api/rules').then(function (res) {
    var html = header('规则配置', '告警阈值 ' + res.alertThreshold + ' · 滑动窗口 ' + Math.round(res.windowMs / 60000) + ' 分钟');
    html += '<div class="panel"><h2>生效规则</h2>' + (res.rules && res.rules.length
      ? '<table><thead><tr><th>状态</th><th>规则</th><th>动作</th><th>权重</th><th>说明</th></tr></thead><tbody>' +
        res.rules.map(function (rule) {
          return '<tr><td>' + (rule.enabled ? '<span class="ok">启用</span>' : '<span class="muted">停用</span>') +
            '</td><td>' + esc(rule.id) + '</td><td>' + esc(rule.action) + '</td><td>' + rule.weight + '</td><td>' +
            esc(rule.description || '-') + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="muted">未配置自定义规则，当前使用全部内置规则（敏感词、刷屏、重复内容、静默时段、@ 轰炸、媒体刷屏、导流话术、链接刷屏）。</p>') +
      '</div>';
    html += '<div class="panel"><h2>内置规则一览</h2><div class="tags">' + BUILTIN_RULES.map(function (r) {
      return '<span class="tag">' + esc(r) + '</span>';
    }).join('') + '</div></div>';
    document.getElementById('main').innerHTML = html;
  });
};

var BUILTIN_RULES = ['敏感词命中', '链接刷屏', '刷屏', '重复内容', '静默时段', '@ 轰炸', '媒体刷屏', '导流话术'];

/**
 * 运行自检。
 *
 * 这个视图存在的理由：客户端插件的故障几乎都表现为「面板里什么都没有」，
 * 而「宿主没投进来」「投进来但字段名对不上」「投进来也入库了只是没选群」
 * 在界面上长得一模一样。把注入链路实测一遍并给出**一句结论**，
 * 比让用户去读日志快得多。
 */
RENDERERS.health = function () {
  return api('/api/health/deep').then(function (res) {
    var html = header('运行自检', '注入链路 / 宿主能力 / 数据落地一次看全');
    html += '<div class="panel"><h2>结论</h2><p class="' + (res.ok ? 'ok' : 'err') + '" style="margin:0 0 10px">' +
      esc(res.verdict) + '</p><div class="row"><button class="act" id="reprobe">重新探测</button></div></div>';

    html += '<div class="panel"><h2>注入探测</h2><div class="cards">' +
      card('结果', res.probe.accepted ? '通过' : '失败', res.probe.accepted) +
      card('耗时', res.probe.latencyMs + ' ms') +
      card('原因', res.probe.reason || '-') +
      '</div><p class="muted" style="margin-top:8px">探针消息带 <code>eventType: selftest</code>，' +
      '引擎不会把它写进消息表，因此不会污染统计。</p></div>';

    if (res.transport) {
      html += '<div class="panel"><h2>适配器计数</h2><div class="cards">' +
        card('已订阅', res.transport.bound ? '是' : '否', res.transport.bound) +
        card('已接收', n(res.transport.received)) +
        card('已丢弃', n(res.transport.dropped)) +
        card('无法映射', n(res.transport.rejected)) +
        '</div>' + (res.transport.lastRejected
          ? '<p class="err" style="margin-top:8px">最近一次无法映射：' + esc(res.transport.lastRejected) + '</p>'
          : '') + '</div>';
    }

    html += '<div class="panel"><h2>数据</h2><div class="kv">' +
      kv('会话数', n(res.data.conversations)) + kv('累计消息', n(res.data.totalMessages)) +
      kv('累计接收', n(res.engine.received)) + kv('去重丢弃', n(res.engine.duplicates)) +
      kv('处理失败', n(res.engine.failed)) +
      kv('适配器', (res.engine.adapters || []).join('、') || '-') +
      '</div></div>';

    html += '<div class="panel"><h2>宿主能力</h2>' + (res.host.capabilities.length
      ? '<div class="tags">' + res.host.capabilities.map(function (c) { return '<span class="tag">' + esc(c) + '</span>'; }).join('') + '</div>'
      : '<p class="muted">当前未接入客户端宿主（离线预览或纯 HTTP 形态）。这属于合法状态：' +
        '统计、风控、面板都可正常工作，只是没有原生通知/角标/文件对话框。</p>') + '</div>';

    document.getElementById('main').innerHTML = html;
    document.getElementById('reprobe').onclick = function () { render(); toast('已重新探测'); };
  });
};

/**
 * 免责声明区块。
 *
 * 文本从引擎接口取（/api/disclaimer），不在面板里硬编码一份：声明是法律文本，
 * 只能有一个事实源（见 src/legal/disclaimer.ts）。取不到时明确说「未能从引擎读取」，
 * 而不是静默省略 —— 让人以为「这项目好像没有声明」比展示失败更糟。
 */
function renderDisclaimer() {
  if (DISCLAIMER) return disclaimerHtml(DISCLAIMER);
  return '<div class="panel legal"><h2>⚠️ 免责声明与风险提示（高风险）</h2>' +
    '<p class="err">未能从引擎读取声明文本，请直接查看仓库根目录的 README。</p>' +
    '<p class="muted">作者与项目按「现状」提供，因使用或无法使用本项目产生的一切后果由使用者自行承担。</p></div>';
}

/** 把结构化声明拼成 HTML。文本里的粗体标记在这里转成 strong 标签。 */
function disclaimerHtml(d) {
  var html = '<div class="panel legal"><h2>⚠️ ' + esc(d.risk.label) + ' · 免责声明与风险提示</h2>' +
    '<p class="err" style="font-size:12px">' + md(d.risk.summary) + '</p><ol>';
  (d.notice || []).forEach(function (line) { html += '<li>' + md(line) + '</li>'; });
  html += '</ol>';
  (d.sections || []).forEach(function (sec) {
    html += '<div class="sec"><div class="t">' + esc(sec.title) + '</div><ul>';
    (sec.items || []).forEach(function (line) { html += '<li>' + md(line) + '</li>'; });
    html += '</ul></div>';
  });
  html += '<p class="tail">以上为完整声明。若你不同意其中任何一条，请立即停止使用并删除本项目。</p></div>';
  return html;
}

/** 只放行粗体标记：声明文本里没有别的 Markdown 语法，不需要引入解析器。 */
function md(text) {
  return esc(text).replace(/[*][*]([^*]+)[*][*]/g, '<strong>$1</strong>');
}

RENDERERS.about = function () {
  var html = header('关于', BRAND_NAME + ' · ' + BRAND_TAGLINE);
  html += renderDisclaimer();
  html += '<div class="panel"><h2>项目</h2><div class="kv">' +
    kv('名称', BRAND_NAME) + kv('定位', '微信社群智能引擎 · PC 客户端内直接使用与管理') +
    kv('作者', BRAND_AUTHOR) + kv('许可', BRAND_LICENSE) +
    '</div><p class="muted" style="margin-top:10px">群聊统计 · 自动化检测 · 群聊信息管理 · AI 助手，四合一。<br>' +
    '运行在微信 PC 客户端内，打开插件面板即可使用与管理，无需外部服务。</p></div>';
  html += '<div class="panel"><h2>作者与社区</h2><div class="row">' +
    linkButton(BRAND_WEBSITE, '文档站') + linkButton(BRAND_GITHUB, 'GitHub') +
    linkButton(BRAND_BILIBILI, '哔哩哔哩') + linkButton(BRAND_FORUM, '玲珑论坛') + '</div>' +
    '<p class="muted" style="margin-top:10px">QQ 群：' + BRAND_QQ.join(' ｜ ') + '</p></div>';
  html += '<div class="panel"><h2>宿主能力</h2>' + (HOST_CAPS.length
    ? '<div class="tags">' + HOST_CAPS.map(function (c) { return '<span class="tag">' + esc(c) + '</span>'; }).join('') + '</div>'
    : '<p class="muted">当前不在客户端宿主内运行（离线预览模式）。客户端宿主会提供通知、角标、原生发送等能力。</p>') +
    '</div>';
  document.getElementById('main').innerHTML = html;
  Array.prototype.forEach.call(document.querySelectorAll('[data-url]'), function (node) {
    node.onclick = function () {
      var url = node.getAttribute('data-url');
      if (HOST && typeof HOST.openExternal === 'function') HOST.openExternal(url);
      else window.open(url, '_blank');
    };
  });
};

function linkButton(url, label) {
  return '<button class="act ghost" data-url="' + esc(url) + '">' + esc(label) + '</button>';
}

var BRAND_NAME = ${JSON.stringify(BRAND.name)};
var BRAND_TAGLINE = ${JSON.stringify(BRAND.tagline)};
var BRAND_AUTHOR = ${JSON.stringify(BRAND.author)};
var BRAND_WEBSITE = ${JSON.stringify(BRAND.website)};
var BRAND_GITHUB = ${JSON.stringify(BRAND.github)};
var BRAND_BILIBILI = ${JSON.stringify(BRAND.bilibili)};
var BRAND_FORUM = ${JSON.stringify(BRAND.forum)};
var BRAND_QQ = ${JSON.stringify(BRAND.qqGroups)};
var BRAND_LICENSE = ${JSON.stringify(BRAND.license)};
var HOST_CAPS = [];
/* 免责声明文本，启动时从 /api/disclaimer 拉一次（内容固定，不必每次进「关于」页都请求）。 */
var DISCLAIMER = null;

/* ── 宿主握手 ──────────────────────────────────────────────── */
function initHost() {
  var box = document.getElementById('hostbox');
  if (!HOST) { box.textContent = '离线预览模式'; return; }
  HOST_CAPS = Array.isArray(HOST.capabilities) ? HOST.capabilities : Object.keys(HOST).filter(function (k) {
    return typeof HOST[k] === 'function';
  });
  box.innerHTML = '<b>' + esc(HOST.name || '客户端宿主') + '</b>' + (HOST.version ? ' v' + esc(HOST.version) : '') +
    '<br>' + HOST_CAPS.slice(0, 8).map(function (c) { return '<span class="cap">' + esc(c) + '</span>'; }).join('');
}

function boot() {
  initHost();
  renderNav();
  // 声明文本先拉，不阻塞主渲染：取不到也只是「关于」页少一块，
  // 而引擎连不上时面板本来就要走错误分支。
  api('/api/disclaimer').then(function (d) { DISCLAIMER = d; }).catch(function () { DISCLAIMER = null; });
  api('/health').then(function (health) {
    document.getElementById('health').innerHTML = '已接入 <b>' + health.conversations + '</b> 个会话 · 接收 <b>' +
      n(health.stats.accepted) + '</b> 条 · AI ' + (health.aiEnabled ? '已启用' : '未启用');
    return loadConversations();
  }).then(function () {
    render();
    startWatch();
  }).catch(function (error) {
    document.getElementById('health').innerHTML = '<span class="err">连接失败：' + esc(error.message) + '</span>';
    render();
  });
}

/**
 * 轮询健康数据。
 *
 * 用轮询而不是 WebSocket：客户端 WebView 对长连接支持不稳定，
 * 而且这个面板本来就是「看一眼」的用法。
 *
 * 这里做两件早期版本做错的事：
 *  1. 发现异常要看得见：以前只要有一条重复消息就把未读角标清零，角标因此基本没生效过。
 *  2. 侧栏的接收数要刷新：以前只有首屏读一次，用户盯着面板看的时候
 *     数字永远不动，很容易误以为「消息没进来」。
 */
var watchTimer = null;
function startWatch() {
  if (watchTimer) return;
  watchTimer = setInterval(function () {
    api('/health').then(function (health) {
      var el = document.getElementById('health');
      if (el) {
        el.innerHTML = '已接入 <b>' + health.conversations + '</b> 个会话 · 接收 <b>' +
          n(health.stats.accepted) + '</b> 条 · AI ' + (health.aiEnabled ? '已启用' : '未启用');
      }
      // 处理失败数作为「有东西不对劲」的信号亮到入口角标上，
      // 用户不必主动翻日志就能察觉异常。
      if (HOST && typeof HOST.setBadge === 'function') {
        HOST.setBadge(Math.min(health.stats.failed || 0, 99));
      }
    }).catch(function () {
      var el = document.getElementById('health');
      if (el) el.innerHTML = '<span class="err">引擎已断开，正在重试…</span>';
    });
  }, 20000);
  if (watchTimer && typeof watchTimer.unref === 'function') watchTimer.unref();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
</script>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

export { escapeHtml };
