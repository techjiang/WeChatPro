/**
 * WeChatPro 公共 API。
 *
 * 只导出「稳定契约」：引擎、核心类型、统计、风控、AI、管理门面。
 * 内部实现细节（具体规则、提示词模板）不导出——它们会变，
 * 一旦被外部依赖就会变成事实上的公共 API，失去演进自由。
 */

export { Engine } from './runtime/engine.js';
export { bootstrap, loadConfig, builtinPlugins } from './runtime/bootstrap.js';
export type { BootstrapOptions, BootstrapResult } from './runtime/bootstrap.js';

export { EventBus } from './core/events.js';
export { Store } from './core/store.js';
export {
  configSchema,
  parseConfig,
  applyEnvOverrides,
  ConfigError,
} from './core/config.js';
export type { AppConfig, AdapterConfig, ClientConfig, GuardRuleConfig, PluginConfig } from './core/config.js';
export { resolvePluginOrder, PluginGraphError } from './core/plugin.js';
export type { Plugin, PluginManifest } from './core/plugin.js';
export type { EngineContext } from './core/context.js';
export { tokenize, normalizeText, filterTokens, summarize } from './core/text.js';
export type {
  NormalizedMessage,
  ConversationInfo,
  SenderInfo,
  MessageKind,
  ProtocolAdapter,
  RawEvent,
  OutboundMessage,
} from './core/types.js';

export { registerAdapter, listAdapterProtocols, pick, toMillis, normalizeEventType } from './core/registry.js';
export type { RawEventType } from './core/registry.js';
export { registerBuiltinAdapters, setHostProvider } from './protocols/index.js';
export {
  buildMockAdapter,
  buildWebhookAdapter,
  createHostAdapter,
  HostTransport,
  WECHAT_PC_MAPPING,
  WECHAT_KIND_ALIASES,
  coerceHostKind,
  parseChatExport,
  describeUnmapped,
  selfTestPayload,
  mapPayload,
  toStringList,
  isOutbound,
} from './protocols/index.js';
export type { HostAdapterOptions, HostIngestPayload, IngestResult } from './protocols/index.js';

/* ── PC 客户端形态（主要交付形态）────────────────────────── */
export { HostGateway, HOST_CAPABILITIES } from './core/host-bridge.js';
export type {
  HostBridge,
  HostCapability,
  HostNotifyOptions,
  HostContact,
  HostSendRequest,
} from './core/host-bridge.js';
export { createClientHost, bridgeFromShell } from './client/host.js';
export type { ClientHost, ClientHostOptions, ClientShellApi } from './client/host.js';
export { renderPanel } from './client/panel.js';
export { BRAND, BRAND_COLORS, brandIcon, asciiBanner } from './client/brand.js';

/* ── 免责声明与风险提示 ───────────────────────────────────── */
// 导出是为了让宿主插件壳 / 分发方能在自己的界面上展示同一份声明，
// 而不是各自抄一份措辞不同的版本——法律文本只能有一个事实源。
export {
  RISK_LEVEL,
  RISK_NOTICE,
  DISCLAIMER_SECTIONS,
  shortDisclaimer,
  disclaimerText,
  disclaimerPayload,
} from './legal/disclaimer.js';
export type { DisclaimerSection } from './legal/disclaimer.js';
export { createClientPlugin } from './plugins/client.js';

export { AnalyticsEngine, topWordsOf, lastDays, DAY_MS, HOUR_MS } from './analytics/index.js';
export { buildDigest, previousDayWindow, formatDay, ruleIdOf, reasonOf } from './analytics/digest.js';
export type { DigestReport, DigestWindow } from './analytics/digest.js';
export { Scheduler, createDigestJob } from './runtime/scheduler.js';
export type { ScheduledJob, JobStatus } from './runtime/scheduler.js';
export type {
  ActivityReport,
  HeatmapReport,
  TrendReport,
  TopicReport,
  MemberProfile,
  MemberStat,
  TimeRange,
} from './analytics/index.js';

export {
  GuardEngine,
  builtinRules,
  createRules,
  toRuleConfigMap,
} from './guard/index.js';
export type { GuardAlert, GuardRule, RuleVerdict } from './guard/index.js';

export { AiService, LlmGateway, Retriever, routeIntent, parseTimeRange } from './ai/index.js';
export type { AiAnswer, IntentMatch, IntentName } from './ai/index.js';

export { GroupManager, classifyStage } from './manage/index.js';
export type { KnowledgeEntry, MemberLifecycle, GroupDigest } from './manage/index.js';

export { buildServer } from './api/server.js';

export { createAnalyticsPlugin, renderReport, renderSparkline } from './plugins/analytics.js';
export { createAiPlugin } from './plugins/ai.js';
export { createCommandPlugin, extractCommand } from './plugins/command.js';
export { createGuardPlugin } from './plugins/guard.js';
export { createManagePlugin } from './plugins/manage.js';
export { createRulesInspectorPlugin } from './plugins/rules-inspector.js';
