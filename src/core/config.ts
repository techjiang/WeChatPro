import { z } from 'zod';

/**
 * 配置校验。
 *
 * 配置来自 JSON 文件 + 环境变量覆盖，格式错误必须在启动阶段暴露，
 * 而不是等到某条消息触发了某个分支才炸。
 */

const adapterSchema = z.object({
  /** 适配器实现名，对应 `src/core/registry.ts` 中注册的 protocol。 */
  protocol: z.string().min(1),
  /** 是否启用，便于多协议灰度。 */
  enabled: z.boolean().default(true),
  /** 适配器私有配置，由各适配器自行校验。 */
  options: z.record(z.string(), z.unknown()).prefault({}),
});

const analyticsSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** 参与统计的会话白名单；为空表示全部群聊。 */
    includeConversations: z.array(z.string()).default([]),
    /** 词频统计时丢弃的高频停用词。 */
    stopWords: z.array(z.string()).default([]),
    /** 每小时热力图的桶数，24 表示按自然小时。 */
    hourlyBuckets: z.number().int().min(1).max(168).default(24),
    /**
     * 群日报推送时间（cron，本地时区）。默认每天 09:00。
     *
     * 放在配置顶层而不是插件 options 里：日报是「群运营的基本节律」，
     * 而不是某个插件的私有开关；写在顶层，`wechatpro check` 也会一并校验。
     */
    digestCron: z.string().min(1).default('0 9 * * *'),
    /** 日报覆盖天数，1 表示只报昨天。 */
    digestDays: z.number().int().min(1).max(30).default(1),
    /** 日报统一推送到该会话（如管理员群）；为空则各自推回本群。 */
    digestConversationId: z.string().default(''),
    /** 无消息的群是否也推日报，默认否。 */
    digestIncludeEmpty: z.boolean().default(false),
    /** 单次最多推送的群数，防止首次运行时一次性刷屏。 */
    digestMaxConversations: z.number().int().min(1).default(50),
  })
  .prefault({});

const guardRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  /** 命中后的处置动作。 */
  action: z.enum(['alert', 'warn', 'mute-suggest', 'revoke-suggest', 'kick-suggest']).default('alert'),
  /** 规则权重，用于累计风险分。 */
  weight: z.number().min(0).max(100).default(10),
  options: z.record(z.string(), z.unknown()).prefault({}),
});

const guardSchema = z.object({
  enabled: z.boolean().default(true),
  rules: z.array(guardRuleSchema).default([]),
  /** 风险分达到该值即产生一条 alert。 */
  alertThreshold: z.number().min(0).default(30),
  /** 同一成员在该窗口内累计风险分的滑动窗口长度（毫秒）。 */
  windowMs: z.number().int().positive().default(10 * 60_000),
});

const aiSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['openai-compatible', 'mock']).default('openai-compatible'),
  baseUrl: z.string().default('https://api.openai.com/v1'),
  apiKey: z.string().default(''),
  model: z.string().default('gpt-4o-mini'),
  /** 单次请求超时，AI 慢响应不能阻塞消息处理链路。 */
  timeoutMs: z.number().int().positive().default(30_000),
  /** 并发上限，避免瞬时打爆限流。 */
  maxConcurrency: z.number().int().positive().default(4),
  /** 群聊内容摘要的滑动窗口长度（条）。 */
  summaryWindow: z.number().int().positive().default(200),
});

const manageSchema = z.object({
  enabled: z.boolean().default(true),
  /** 群档案、成员档案落库位置。 */
  dataDir: z.string().default('./data'),
  /** 单会话保留的消息条数上限，0 表示不限制。 */
  retainMessagesPerConversation: z.number().int().min(0).default(0),
});

const apiSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8787),
  /** 访问令牌；为空表示不鉴权，仅限本机监听时使用。 */
  token: z.string().default(''),
  /** 允许的跨域来源。 */
  corsOrigins: z.array(z.string()).default([]),
});

const storageSchema = z.object({
  /** SQLite 文件路径，`:memory:` 表示纯内存（测试用）。 */
  sqlitePath: z.string().default('./data/wechatpro.db'),
  /** WAL 提升并发读写；只读场景可关。 */
  wal: z.boolean().default(true),
});

/**
 * PC 客户端宿主配置。
 *
 * 这是「在微信 APP 内直接使用」的开关：开启后引擎不再等待 HTTP 推送，
 * 而是由客户端插件壳把消息投进来，并把面板挂到客户端窗口里。
 */
const clientSchema = z
  .object({
    /** 是否启用客户端宿主形态。 */
    enabled: z.boolean().default(false),
    /** 宿主标识，仅用于展示与排障。 */
    host: z.string().default('wechat-pc'),
    /** 宿主版本，便于判断某能力是否可用。 */
    hostVersion: z.string().default(''),
    /** 面板在客户端里的默认路由。 */
    panelRoute: z.string().default('#/dashboard'),
    /** 客户端打开面板时是否先清角标。 */
    clearBadgeOnFocus: z.boolean().default(true),
    /**
     * 风控告警是否顺带弹客户端原生通知。
     * 默认开启：插件的价值就在于「不用盯着也能知道群里出事了」。
     */
    notifyOnAlert: z.boolean().default(true),
    /** 同一告警的去重窗口（毫秒），防止刷屏把客户端通知队列打爆。 */
    notifyDedupeMs: z.number().int().positive().default(60_000),
    /** 未读角标上限，超过只显示 `+`，避免角标数字撑爆入口。 */
    badgeMax: z.number().int().min(0).default(99),
    /** 客户端本地库 / 数据目录，插件壳用它找会话文件。 */
    dataDir: z.string().default(''),
  })
  .prefault({});

const pluginSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  options: z.record(z.string(), z.unknown()).prefault({}),
});

export const configSchema = z.object({
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  storage: storageSchema.prefault({}),
  adapters: z.array(adapterSchema).default([]),
  analytics: analyticsSchema.prefault({}),
  guard: guardSchema.prefault({}),
  ai: aiSchema.prefault({}),
  manage: manageSchema.prefault({}),
  api: apiSchema.prefault({}),
  client: clientSchema,
  plugins: z.array(pluginSchema).default([]),
});

export type AppConfig = z.infer<typeof configSchema>;
export type AdapterConfig = z.infer<typeof adapterSchema>;
export type GuardRuleConfig = z.infer<typeof guardRuleSchema>;
export type PluginConfig = z.infer<typeof pluginSchema>;
export type ClientConfig = z.infer<typeof clientSchema>;

/** 校验失败时抛出，携带字段级路径，便于直接打印给人看。 */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(input: unknown): AppConfig {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    throw new ConfigError('配置校验失败', issues);
  }
  return result.data;
}

/**
 * 用环境变量覆盖部分常用配置，便于容器化部署时不挂配置文件。
 * 只覆盖「部署强相关」的字段，业务规则仍走配置文件，避免环境变量散落各处。
 */
export function applyEnvOverrides(config: AppConfig, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const next: AppConfig = structuredClone(config);
  if (env.WECHATPRO_LOG_LEVEL) next.logLevel = env.WECHATPRO_LOG_LEVEL as AppConfig['logLevel'];
  if (env.WECHATPRO_SQLITE_PATH) next.storage.sqlitePath = env.WECHATPRO_SQLITE_PATH;
  if (env.WECHATPRO_API_PORT) next.api.port = Number(env.WECHATPRO_API_PORT);
  if (env.WECHATPRO_API_HOST) next.api.host = env.WECHATPRO_API_HOST;
  if (env.WECHATPRO_API_TOKEN) next.api.token = env.WECHATPRO_API_TOKEN;
  if (env.WECHATPRO_AI_API_KEY) next.ai.apiKey = env.WECHATPRO_AI_API_KEY;
  if (env.WECHATPRO_AI_BASE_URL) next.ai.baseUrl = env.WECHATPRO_AI_BASE_URL;
  if (env.WECHATPRO_AI_MODEL) next.ai.model = env.WECHATPRO_AI_MODEL;
  if (env.WECHATPRO_AI_ENABLED) next.ai.enabled = env.WECHATPRO_AI_ENABLED === 'true';
  if (env.WECHATPRO_CLIENT_ENABLED) next.client.enabled = env.WECHATPRO_CLIENT_ENABLED === 'true';
  if (env.WECHATPRO_CLIENT_HOST) next.client.host = env.WECHATPRO_CLIENT_HOST;
  if (env.WECHATPRO_DIGEST_CRON) next.analytics.digestCron = env.WECHATPRO_DIGEST_CRON;
  return next;
}
