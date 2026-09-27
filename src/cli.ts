#!/usr/bin/env node
import { bootstrap, loadConfig, builtinPlugins } from './runtime/bootstrap.js';
import { AnalyticsEngine, lastDays } from './analytics/index.js';
import { GroupManager } from './manage/index.js';
import { renderReport } from './plugins/analytics.js';
import { Store } from './core/store.js';
import { parseConfig } from './core/config.js';
import { registerBuiltinAdapters } from './protocols.js';
import { listAdapterProtocols } from './core/registry.js';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * 命令行入口。
 *
 * 只做「运维与排查」类操作：启动服务、看报表、导出数据。
 * 业务动作（回复、处罚）不放 CLI——它们需要审计与权限，应该走 API。
 */

const USAGE = `WeChatPro — 微信社群智能引擎

用法:
  wechatpro start [--config <path>]              启动引擎与控制台
  wechatpro report <conversationId> [options]    输出群聊统计报表
  wechatpro conversations [--config <path>]      列出已知会话
  wechatpro members <conversationId>             列出群成员台账
  wechatpro knowledge <conversationId>           查看群知识库
  wechatpro rules [--config <path>]              查看生效的检测规则
  wechatpro adapters                             列出已注册的协议适配器
  wechatpro plugins                              列出内置插件
  wechatpro check [--config <path>]              校验配置并打印解析结果
  wechatpro export <conversationId> [--out f]    导出群档案 JSON

选项:
  --config <path>   配置文件路径（默认 config.json，不存在则用内置默认值）
  --days <n>        报表覆盖天数（默认 7）
  --db <path>       直接指定 SQLite 路径，覆盖配置
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
    case 'report':
      return reportCommand(flags);
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
  positionals: string[];
}

function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = { days: 7, positionals: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--config' || arg === '--db' || arg === '--days' || arg === '--out') {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      if (arg === '--config') flags.config = value;
      else if (arg === '--db') flags.db = value;
      else if (arg === '--out') flags.out = value;
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

/** 只读命令共用的 store 打开逻辑：不启动适配器，直接读库。 */
async function openReadonlyStore(flags: Flags): Promise<{ store: Store; close: () => void }> {
  const config = await loadConfig(flags.config);
  const path = flags.db ?? config.storage.sqlitePath;
  const store = new Store({ path, wal: config.storage.wal });
  return { store, close: () => store.close() };
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
