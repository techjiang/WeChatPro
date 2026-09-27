#!/usr/bin/env node
import { bootstrap, loadConfig, builtinPlugins } from './runtime/bootstrap.js';
import { AnalyticsEngine, lastDays } from './analytics/index.js';
import { buildDigest, previousDayWindow } from './analytics/digest.js';
import { hostDropStats } from './runtime/bootstrap.js';
import { GroupManager } from './manage/index.js';
import { renderReport } from './plugins/analytics.js';
import { Store } from './core/store.js';
import { parseConfig } from './core/config.js';
import { registerBuiltinAdapters } from './protocols/index.js';
import { listAdapterProtocols } from './core/registry.js';
import { readFile, writeFile } from 'node:fs/promises';
import { HostGateway, HOST_CAPABILITIES, type HostCapability } from './core/host-bridge.js';
import { createClientHost, bridgeFromShell, type ClientShellApi } from './client/host.js';
import { renderPanel } from './client/panel.js';
import { parseChatExport, WECHAT_PC_MAPPING } from './protocols/host.js';
import { BRAND, asciiBanner, brandIcon } from './client/brand.js';

/**
 * 命令行入口。
 *
 * 只做「运维与排查」类操作：启动服务、看报表、导出数据。
 * 业务动作（回复、处罚）不放 CLI——它们需要审计与权限，应该走 API。
 */

const USAGE = `WeChatPro — 微信社群智能引擎（PC 客户端内直接使用与管理）

用法:
  wechatpro start [--config <path>]              启动引擎与面板
  wechatpro client [--config <path>]             以「微信 PC 客户端插件」形态启动
  wechatpro ui [--out panel.html]                导出内置面板单文件（离线可开）
  wechatpro doctor [--config <path>]             环境自检：配置/数据/宿主能力/资源
  wechatpro import <text|json> [options]         导入聊天导出文本或宿主 JSON
  wechatpro report <conversationId> [options]    输出群聊统计报表
  wechatpro digest [conversationId] [--days 1]   生成群日报（定时推送的内容就是它）
  wechatpro conversations [--config <path>]      列出已知会话
  wechatpro members <conversationId>             列出群成员台账
  wechatpro knowledge <conversationId>           查看群知识库
  wechatpro rules [--config <path>]              查看生效的检测规则
  wechatpro adapters                             列出已注册的协议适配器
  wechatpro plugins                              列出内置插件
  wechatpro brand                                输出品牌信息与资源路径
  wechatpro check [--config <path>]              校验配置并打印解析结果
  wechatpro export <conversationId> [--out f]    导出群档案 JSON

选项:
  --config <path>   配置文件路径（默认 config.json，不存在则用内置默认值）
  --days <n>        报表覆盖天数（默认 7）
  --db <path>       直接指定 SQLite 路径，覆盖配置
  --out <path>      输出文件路径
  --conversation <id>  import 时的目标会话 ID
  --json                doctor / brand 输出 JSON，便于脚本消费
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case 'start':
      return startCommand(flags);
    case 'client':
      return clientCommand(flags);
    case 'ui':
      return uiCommand(flags);
    case 'doctor':
      return doctorCommand(flags);
    case 'import':
      return importCommand(flags);
    case 'brand':
      return brandCommand(flags);
    case 'report':
      return reportCommand(flags);
    case 'digest':
      return digestCommand(flags);
    case 'conversations':
      return conversationsCommand(flags);
    case 'members':
      return membersCommand(flags);
    case 'knowledge':
      return knowledgeCommand(flags);
    case 'rules':
      return rulesCommand(flags);
    case 'adapters':
      registerBuiltinAdapters();
      process.stdout.write(listAdapterProtocols().join('\n') + '\n');
      return 0;
    case 'plugins':
      for (const plugin of builtinPlugins) {
        process.stdout.write(`${plugin.manifest.name}\t${plugin.manifest.description ?? ''}\n`);
      }
      return 0;
    case 'check':
      return checkCommand(flags);
    case 'export':
      return exportCommand(flags);
    default:
      process.stderr.write(`未知命令: ${command}\n\n${USAGE}`);
      return 2;
  }
}

interface Flags {
  config?: string;
  db?: string;
  days: number;
  out?: string;
  conversation?: string;
  json?: boolean;
  positionals: string[];
}

function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = { days: 7, positionals: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg === '--config' || arg === '--db' || arg === '--days' || arg === '--out' || arg === '--conversation') {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      if (arg === '--config') flags.config = value;
      else if (arg === '--db') flags.db = value;
      else if (arg === '--out') flags.out = value;
      else if (arg === '--conversation') flags.conversation = value;
      else flags.days = Number(value);
      i += 1;
      continue;
    }
    flags.positionals.push(arg);
  }
  if (!Number.isFinite(flags.days) || flags.days <= 0) throw new Error('--days 必须是正数');
  return flags;
}

async function startCommand(flags: Flags): Promise<number> {
  const { engine, start, stop, config } = await bootstrap({ configPath: flags.config });
  await start();
  const shutdown = async (signal: string): Promise<void> => {
    engine.logger.info({ signal }, '收到退出信号，正在优雅停止');
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  engine.logger.info(
    { adapters: engine.stats.adapters, api: config.api.enabled ? `${config.api.host}:${config.api.port}` : 'off' },
    'WeChatPro 已就绪',
  );
  return 0;
}

/**
 * 客户端形态启动。
 *
 * 与 `start` 的唯一区别：先探一遍宿主环境。真实注入场景里 `WECHATPRO_HOST_*`
 * 由插件壳写入环境变量，这里据此构造宿主桥；探测不到就以「无宿主」启动，
 * 引擎与面板照常工作，只是少了原生通知这类增强能力。
 */
async function clientCommand(flags: Flags): Promise<number> {
  const shell = detectShell();
  const bridge = shell
    ? bridgeFromShell(shell, {
        host: process.env.WECHATPRO_HOST_NAME ?? 'wechat-pc',
        hostVersion: process.env.WECHATPRO_HOST_VERSION ?? '',
        pluginVersion: process.env.WECHATPRO_PLUGIN_VERSION ?? '',
      })
    : undefined;

  if (!bridge) {
    process.stderr.write(
      '提示：未检测到客户端注入环境（WECHATPRO_HOST_SHELL），将以「无宿主」模式启动。\n' +
        '      引擎与面板可用，但原生通知/角标/文件对话框等能力会被跳过降级。\n',
    );
  }

  const { engine, start, stop, config, client } = await bootstrap({
    ...(flags.config ? { configPath: flags.config } : {}),
    clientMode: true,
    ...(bridge ? { hostBridge: bridge } : {}),
  });
  await start();

  const banner = asciiBanner();
  engine.logger.info(
    {
      host: client?.host,
      capabilities: client?.capabilities(),
      adapters: engine.stats.adapters,
      panel: `http://${config.api.host}:${config.api.port}/`,
    },
    `\n${banner}\n客户端插件已就绪`,
  );
  process.stdout.write(
    `${banner}\n\n` +
      `宿主      : ${client?.host ?? 'none'}\n` +
      `能力      : ${(client?.capabilities() ?? []).join(', ') || '（无，已降级）'}\n` +
      `面板      : http://${config.api.host}:${config.api.port}/\n` +
      `消息入口  : POST http://${config.api.host}:${config.api.port}/api/ingest（宿主直连时无需）\n` +
      `\n等待宿主注入消息…（Ctrl+C 退出）\n`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    engine.logger.info({ signal }, '收到退出信号，正在优雅停止');
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  return 0;
}

/**
 * 探测客户端注入环境。
 *
 * 用环境变量而不是直接 require 客户端模块：不同插件的注入方式不同
 * （全局对象 / 预加载脚本 / 子进程环境），环境变量是三条路径都能用的最小公约数。
 * 插件壳只要在加载本包前设置 `WECHATPRO_HOST_SHELL=<shell 模块路径>` 即可。
 */
function detectShell(): ClientShellApi | null {
  const shellPath = process.env.WECHATPRO_HOST_SHELL;
  if (!shellPath) return null;
  // 客户端注入的模块路径由宿主提供，只能动态解析；这里用 require 兼容 CJS 插件壳。
  try {
    return loadShell(shellPath);
  } catch (error) {
    process.stderr.write(`警告：客户端壳加载失败（${shellPath}）：${error instanceof Error ? error.message : error}\n`);
    return null;
  }
}

/**
 * 从路径加载插件壳。
 *
 * 抽出来是因为 `client` 命令与 `doctor` 都要用它——两处各写一份的话，
 * 「自检说能加载、启动却加载不了」这类差异会长期存在且没人发现。
 */
function loadShell(shellPath: string): ClientShellApi | null {
  const resolved = shellPath.startsWith('.') ? new URL(shellPath, `file://${process.cwd()}/`).pathname : shellPath;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(resolved) as { shell?: ClientShellApi } & ClientShellApi;
  return loaded.shell ?? loaded;
}

/**
 * 校验 cron 表达式。
 *
 * 直接用调度器自己的校验函数，避免「`doctor` 说没问题、启动时却被跳过」
 * 这种两套口径的问题。延迟 require 是为了不在 CLI 未用到时也加载调度器。
 */
function validateCron(expression: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cron = require('node-cron') as { validate(value: string): boolean };
    return cron.validate(expression);
  } catch {
    // 依赖缺失时不该把自检判成失败：这不是用户配置的问题。
    return true;
  }
}

/** 当日已入库消息数；库打不开时返回 null（自检本身不能因此崩掉）。 */
function digestTodayCount(config: { storage: { sqlitePath: string; wal: boolean } }): number | null {
  try {
    const store = new Store({ path: config.storage.sqlitePath, wal: config.storage.wal });
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const row = store.db
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE ts >= ?`)
      .get(start.getTime()) as { count: number };
    store.close();
    return row.count;
  } catch {
    return null;
  }
}

/** 导出内置面板为单文件 HTML。 */
async function uiCommand(flags: Flags): Promise<number> {
  const html = renderPanel();
  const out = flags.out ?? 'panel.html';
  await writeFile(out, html, 'utf8');
  const icon = brandIcon();
  process.stdout.write(
    `面板已导出: ${out}（${(html.length / 1024).toFixed(1)} KB）\n` +
      `打开方式：浏览器直接打开即可；数据来自同源 /api/*，独立打开时会提示无数据。\n` +
      `品牌资源：${icon ? '已内联 Logo（随包发布）' : '未找到 brand/ 目录，已降级为纯文字标题'}\n`,
  );
  return 0;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** 不阻塞使用的建议。 */
  hint?: string;
}

/**
 * 环境自检。
 *
 * 目标是让「装不上/不生效」这类问题在 10 秒内定位：配置能不能解析、库能不能打开、
 * 适配器认不认得、宿主给了哪些能力、品牌资源在不在。所有检查都**不抛错**，
 * 逐条汇报，最后给出总结——自检工具本身崩掉是最糟糕的体验。
 */
async function doctorCommand(flags: Flags): Promise<number> {
  const checks: DoctorCheck[] = [];

  let config;
  try {
    config = await loadConfig(flags.config);
    checks.push({ name: '配置解析', ok: true, detail: flags.config ?? '默认配置' });
  } catch (error) {
    checks.push({
      name: '配置解析',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      hint: '运行 `wechatpro check --config <path>` 查看字段级错误',
    });
    return reportDoctor(checks, Boolean(flags.json));
  }

  try {
    registerBuiltinAdapters();
    const protocols = listAdapterProtocols();
    const enabled = config.adapters.filter((a) => a.enabled).map((a) => a.protocol);
    const unknown = enabled.filter((p) => !protocols.includes(p));
    checks.push({
      name: '协议适配器',
      ok: unknown.length === 0,
      detail: `已注册 ${protocols.join(', ')}｜启用 ${enabled.join(', ') || '（无）'}`,
      ...(unknown.length ? { hint: `未知协议: ${unknown.join(', ')}` } : {}),
    });
  } catch (error) {
    checks.push({ name: '协议适配器', ok: false, detail: String(error) });
  }

  try {
    const store = new Store({ path: flags.db ?? config.storage.sqlitePath, wal: config.storage.wal });
    const conversations = store.listConversations();
    const total = conversations.reduce((sum, row) => sum + row.message_count, 0);
    store.close();
    checks.push({
      name: '数据库',
      ok: true,
      detail: `${flags.db ?? config.storage.sqlitePath}｜${conversations.length} 会话 / ${total} 条消息`,
    });
  } catch (error) {
    checks.push({
      name: '数据库',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      hint: '确认路径可写，或换 `--db :memory:` 验证引擎本身',
    });
  }

  // 客户端宿主能力探测。
  //
  // 这一步刻意「不配壳也能看」：早期版本在没有注入环境时把结论标成 `✗`，
  // 而下面几项都是 `✓`，看起来像环境坏了。实际上「没注入」是一个合法状态
  // （引擎与面板照常工作，只是缺原生通知这类增强能力），
  // 所以改成「探测到了才检查，没探测到就说明降级范围」。
  const shellPath = process.env.WECHATPRO_HOST_SHELL;
  if (!shellPath) {
    checks.push({
      name: '客户端宿主',
      ok: true,
      detail: `未注入插件壳（合法状态）：引擎与面板可用，原生通知/角标/文件对话框会降级跳过`,
      hint: '要在微信客户端内使用，让插件壳导出 WECHATPRO_HOST_SHELL=<shell 模块路径> 后运行 `wechatpro client`',
    });
  } else {
    try {
      const shell = loadShell(shellPath);
      const bridge = shell ? bridgeFromShell(shell, { host: process.env.WECHATPRO_HOST_NAME ?? 'wechat-pc' }) : null;
      const gateway = new HostGateway();
      if (bridge) gateway.attach(bridge);
      const caps = gateway.capabilities();
      checks.push({
        name: '客户端宿主',
        ok: Boolean(bridge) && caps.length > 0,
        detail: bridge
          ? `已注入 ${bridge.host}｜能力 ${caps.length}/${HOST_CAPABILITIES.length}：${caps.join(', ') || '（无）'}`
          : `插件壳加载失败：${shellPath}`,
        ...(bridge && caps.length === 0
          ? { hint: '插件壳没挂任何能力：确认它实现的方法名与 ClientShellApi 一致，未实现的能力不要写成空函数' }
          : {}),
      });
    } catch (error) {
      checks.push({
        name: '客户端宿主',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        hint: '插件壳模块需可被 Node 加载（CJS/ESM 均可），且需能从进程中读到',
      });
    }
  }

  // 注入被拒计数：宿主最容易踩的坑是「发出去了但没进库」，症状与「没发」无法区分。
  const drops = hostDropStats();
  const dropped = Object.values(drops).reduce((sum, count) => sum + count, 0);
  checks.push({
    name: '注入健康',
    ok: dropped === 0,
    detail:
      dropped === 0
        ? '本进程未发现被拒的注入'
        : `被拒 ${dropped} 条：${Object.entries(drops)
            .map(([reason, count]) => `${reason}×${count}`)
            .join('、')}`,
    hint: 'unmapped 表示载荷缺会话/发送者字段，核对下发的字段名与 mapping',
  });

  checks.push({
    name: '日报调度',
    ok: validateCron(config.analytics.digestCron),
    detail: validateCron(config.analytics.digestCron)
      ? `${config.analytics.digestCron}（本地时区）｜覆盖 ${config.analytics.digestDays} 天｜当日消息 ${
          digestTodayCount(config) === null ? '待运行时统计' : digestTodayCount(config)
        }`
      : `cron 表达式非法：${config.analytics.digestCron}`,
    hint: '5 段标准 cron，如 `0 9 * * *` 表示每天 09:00；写错只会在日志里警告，不会阻塞启动',
  });

  const icon = brandIcon();
  checks.push({
    name: '品牌资源',
    ok: Boolean(icon),
    detail: icon ? `Logo 已装载（${Math.round(icon.length / 1024)} KB base64）` : '未找到 brand/logo-256.png',
    hint: '缺资源不影响功能，面板会降级为纯文字标题',
  });

  checks.push({
    name: 'AI 能力',
    ok: true,
    detail: config.ai.enabled ? `已启用 · ${config.ai.model}` : '未启用（统计与风控不受影响，摘要自动降级）',
  });

  checks.push({
    name: '宿主字段映射',
    ok: true,
    detail: `${Object.keys(WECHAT_PC_MAPPING).length} 个字段（StrTalker/StrContent/MsgSvrID…）`,
  });

  checks.push({
    name: '面板',
    ok: true,
    detail: `${(renderPanel().length / 1024).toFixed(0)} KB 单文件，零外部依赖`,
  });

  return reportDoctor(checks, Boolean(flags.json));
}

function reportDoctor(checks: DoctorCheck[], asJson: boolean): number {
  const failed = checks.filter((c) => !c.ok);
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, checks }, null, 2) + '\n');
    return failed.length === 0 ? 0 : 1;
  }
  process.stdout.write(`${BRAND.name} 环境自检\n\n`);
  for (const check of checks) {
    process.stdout.write(`${check.ok ? '✓' : '✗'} ${check.name.padEnd(12, ' ')} ${check.detail}\n`);
    if (!check.ok && check.hint) process.stdout.write(`  ↳ ${check.hint}\n`);
  }
  process.stdout.write(`\n${failed.length === 0 ? '全部通过。' : `${failed.length} 项需要处理。`}\n`);
  return failed.length === 0 ? 0 : 1;
}

/**
 * 导入聊天记录。
 *
 * 支持两种输入：`--out`-less 的导出文本（人类可读的「时间 昵称: 内容」），
 * 与宿主直出的 JSON 数组（微信字段名）。两者最终都走同一个 `HostTransport`，
 * 因此去重、统计口径与实时注入完全一致——这点很重要，否则「导入的数据」
 * 与「实时数据」会算出两套数字。
 */
async function importCommand(flags: Flags): Promise<number> {
  const source = flags.positionals[0];
  if (!source) throw new Error('import 需要一个文件路径或 `-`（从 stdin 读取）');
  const raw = source === '-' ? await readStdin() : await readFile(source, 'utf8');
  const conversationId = flags.conversation ?? 'imported@chatroom';

  // `--db` 必须在这里就生效：bootstrap 会自己 `loadConfig`，
  // 若把覆盖留到之后，数据会写进默认库，用户以为导入失败。
  const baseConfig = await loadConfig(flags.config);
  if (flags.db) baseConfig.storage.sqlitePath = flags.db;

  const { engine, client, stop } = await bootstrap({ config: baseConfig, clientMode: true });
  const host = client ?? createClientHost();
  await engine.start();

  let payloads;
  let format;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed);
    payloads = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
    format = 'json';
  } else {
    payloads = parseChatExport(raw, { conversationId, conversationName: conversationId });
    format = 'text';
  }

  if (payloads.length === 0) {
    process.stderr.write('没有解析出任何消息。文本格式需为「2026-09-27 10:30:05 昵称: 内容」。\n');
    await stop();
    return 1;
  }

  const result = await host.ingestBatch(payloads);
  const conversations = engine.store.listConversations();
  process.stdout.write(
    `格式 ${format}｜解析 ${payloads.length} 条｜入库 ${result.accepted} 条｜丢弃 ${result.dropped} 条\n` +
      conversations
        .map((row) => `  ${row.name}（${row.id}）：${row.message_count} 条消息`)
        .join('\n') +
      '\n',
  );
  await stop();
  return 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** 输出品牌信息，便于脚本/客户端插件读取资源路径。 */
async function brandCommand(flags: Flags): Promise<number> {
  const icon = brandIcon();
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...BRAND, hasIcon: Boolean(icon) }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`${asciiBanner()}\n\n`);
  for (const [key, value] of Object.entries(BRAND)) {
    process.stdout.write(`${key.padEnd(10, ' ')}: ${Array.isArray(value) ? value.join(' / ') : value}\n`);
  }
  process.stdout.write(`Logo      : ${icon ? '已装载（内联可用）' : '缺失（brand/logo-256.png）'}\n`);
  process.stdout.write(`图标资源  : brand/icons/（16/24/32/48/64/128/256 + ICO）\n`);
  return 0;
}

/** 只读命令共用的 store 打开逻辑：不启动适配器，直接读库。 */
async function openReadonlyStore(flags: Flags): Promise<{ store: Store; close: () => void }> {
  const config = await loadConfig(flags.config);
  const path = flags.db ?? config.storage.sqlitePath;
  const store = new Store({ path, wal: config.storage.wal });
  return { store, close: () => store.close() };
}

/**
 * 生成群日报。
 *
 * 与「早上九点自动推」用的是**同一个** `buildDigest`，所以这个命令可以
 * 直接用来核对「定时推送的内容到底是什么样」——不需要等到第二天早上，
 * 也不必去猜调度有没有生效。
 */
async function digestCommand(flags: Flags): Promise<number> {
  const { store, close } = await openReadonlyStore(flags);
  try {
    const days = flags.days;
    const window = days === 1 ? previousDayWindow() : { range: lastDays(days), label: `最近 ${days} 天` };
    const requested = flags.positionals[0];
    const ids = requested
      ? [requested]
      : store.listConversations().map((row) => row.id);

    if (ids.length === 0) {
      process.stdout.write('暂无会话数据，没有可生成的日报。\n');
      return 0;
    }

    let produced = 0;
    for (const conversationId of ids) {
      const report = buildDigest(store, conversationId, window, { includeEmpty: true });
      if (!report) {
        if (requested) {
          process.stderr.write(`未找到会话 ${conversationId}，可用 conversations 命令查看。\n`);
          return 1;
        }
        continue;
      }
      produced += 1;
      process.stdout.write(report.text ? report.text + '\n\n' : `${report.conversationName}：${window.label} 无消息。\n`);
    }
    if (produced === 0) process.stdout.write('没有可生成的日报。\n');
    return 0;
  } finally {
    close();
  }
}

async function reportCommand(flags: Flags): Promise<number> {
  const conversationId = flags.positionals[0];
  if (!conversationId) throw new Error('report 需要 conversationId');
  const { store, close } = await openReadonlyStore(flags);
  try {
    if (!store.getConversation(conversationId)) {
      process.stderr.write(`未找到会话 ${conversationId}，可用 conversations 命令查看。\n`);
      return 1;
    }
    const config = await loadConfig(flags.config);
    const analytics = new AnalyticsEngine(store, config.analytics.hourlyBuckets);
    const range = lastDays(flags.days);
    process.stdout.write(renderReport(analytics, 'stats', conversationId, range) + '\n');
    process.stdout.write(renderReport(analytics, 'heatmap', conversationId, range) + '\n');
    process.stdout.write(renderReport(analytics, 'top', conversationId, range) + '\n');
    return 0;
  } finally {
    close();
  }
}

async function conversationsCommand(flags: Flags): Promise<number> {
  const { store, close } = await openReadonlyStore(flags);
  try {
    const rows = store.listConversations();
    if (rows.length === 0) {
      process.stdout.write('暂无会话数据。\n');
      return 0;
    }
    process.stdout.write('ID\t名称\t消息数\t成员数\t最后活跃\n');
    for (const row of rows) {
      process.stdout.write(
        `${row.id}\t${row.name}\t${row.message_count}\t${row.member_count ?? '-'}\t${new Date(row.last_seen_at).toISOString()}\n`,
      );
    }
    return 0;
  } finally {
    close();
  }
}

async function membersCommand(flags: Flags): Promise<number> {
  const conversationId = flags.positionals[0];
  if (!conversationId) throw new Error('members 需要 conversationId');
  const { store, close } = await openReadonlyStore(flags);
  try {
    const manager = new GroupManager(store);
    const members = manager.listMembers(conversationId);
    if (members.length === 0) {
      process.stdout.write('该会话暂无成员数据。\n');
      return 0;
    }
    process.stdout.write('成员\t消息数\t阶段\t沉默天数\n');
    for (const member of members) {
      const lifecycle = manager.memberLifecycle(conversationId, member.id);
      process.stdout.write(
        `${member.display_name}\t${member.message_count}\t${lifecycle?.stage ?? '-'}\t${lifecycle?.silentDays ?? '-'}\n`,
      );
    }
    return 0;
  } finally {
    close();
  }
}

async function knowledgeCommand(flags: Flags): Promise<number> {
  const conversationId = flags.positionals[0];
  if (!conversationId) throw new Error('knowledge 需要 conversationId');
  const { store, close } = await openReadonlyStore(flags);
  try {
    const entries = new GroupManager(store).listKnowledge(conversationId);
    if (entries.length === 0) {
      process.stdout.write('该会话群知识库为空。\n');
      return 0;
    }
    for (const entry of entries) {
      process.stdout.write(`[${entry.id}] (${entry.category}) ${entry.content} — 命中 ${entry.hits} 次\n`);
    }
    return 0;
  } finally {
    close();
  }
}

async function rulesCommand(flags: Flags): Promise<number> {
  const config = await loadConfig(flags.config);
  if (config.guard.rules.length === 0) {
    process.stdout.write('未配置自定义规则，将使用全部内置规则。\n');
    return 0;
  }
  process.stdout.write(`告警阈值: ${config.guard.alertThreshold}｜滑动窗口: ${config.guard.windowMs}ms\n`);
  for (const rule of config.guard.rules) {
    process.stdout.write(
      `${rule.enabled ? '✓' : '✗'} ${rule.id}\t${rule.action}\t权重 ${rule.weight}\t${rule.description}\n`,
    );
  }
  return 0;
}

async function checkCommand(flags: Flags): Promise<number> {
  if (!flags.config) {
    // 无配置文件时校验「内置默认值」也能通过，说明默认配置可用。
    const config = parseConfig({});
    process.stdout.write(`配置有效（使用默认值）: ${JSON.stringify(config.ai.enabled ? 'ai on' : 'ai off')}\n`);
    return 0;
  }
  const raw = JSON.parse(await readFile(flags.config, 'utf8'));
  const config = parseConfig(raw);
  process.stdout.write('配置校验通过：\n');
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
  return 0;
}

async function exportCommand(flags: Flags): Promise<number> {
  const conversationId = flags.positionals[0];
  if (!conversationId) throw new Error('export 需要 conversationId');
  const { store, close } = await openReadonlyStore(flags);
  try {
    const payload = new GroupManager(store).exportConversation(conversationId);
    const json = JSON.stringify(payload, null, 2);
    if (flags.out) {
      await writeFile(flags.out, json, 'utf8');
      process.stdout.write(`已导出到 ${flags.out}\n`);
    } else {
      process.stdout.write(json + '\n');
    }
    return 0;
  } finally {
    close();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    // 只读命令正常结束；start 命令会一直挂着，不会走到这里。
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`错误: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
