import type { NormalizedMessage } from '../core/types.js';
import type { GuardRuleConfig } from '../core/config.js';

/**
 * 自动化检测引擎。
 *
 * 架构：规则是纯函数（消息 + 规则配置 + 历史窗口 → 判定），引擎负责调度、
 * 滑动窗口维护与风险分累计。纯函数让规则可单测、可热插拔，也让「为什么这条
 * 消息被拦」可以复现——排查误报时这一点比规则数量重要得多。
 *
 * 分级：单条规则给「权重」，引擎按成员在时间窗内累计风险分，
 * 越过阈值才产生 alert。这样单条可疑消息不会直接处罚，符合人工复核的现实流程。
 */

export type RuleAction = GuardRuleConfig['action'];

export interface RuleContext {
  message: NormalizedMessage;
  /** 该成员在本会话内的近期消息，由新到旧。 */
  recentByMember: readonly NormalizedMessage[];
  /** 该会话内的近期消息，由新到旧。 */
  recentByConversation: readonly NormalizedMessage[];
  options: Record<string, unknown>;
  now: number;
}

export interface RuleVerdict {
  /** 是否命中。 */
  hit: boolean;
  /** 命中原因，会写进事件详情，需人类可读。 */
  reason?: string;
  /** 覆盖规则默认权重，如「严重广告」给更高分。 */
  weight?: number;
  /** 附加证据，如命中的词表。 */
  evidence?: Record<string, unknown>;
}

export interface GuardRule {
  id: string;
  description: string;
  /** 命中后的建议处置。 */
  action: RuleAction;
  defaultWeight: number;
  evaluate(context: RuleContext): RuleVerdict;
}

export interface GuardAlert {
  ruleId: string;
  ruleDescription: string;
  action: RuleAction;
  weight: number;
  reason: string;
  conversationId: string;
  memberId: string;
  messageId: string;
  /** 累计风险分（含历史窗口）。 */
  riskScore: number;
  /** 是否已越过告警阈值。 */
  breached: boolean;
  evidence: Record<string, unknown>;
  at: number;
}

/** 判定 `hit` 的便捷构造。 */
function hit(reason: string, extra: Omit<RuleVerdict, 'hit' | 'reason'> = {}): RuleVerdict {
  return { hit: true, reason, ...extra };
}

function miss(): RuleVerdict {
  return { hit: false };
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 内置规则集。
 *
 * 刻意保持「少而准」：群聊场景误报的代价是打断正常对话，宁可漏报再由
 * 自定义规则补。默认阈值都偏保守，交给使用方按群文化调 `options`。
 */
export const builtinRules: GuardRule[] = [
  {
    id: 'keyword-blocklist',
    description: '命中敏感/违规词表',
    action: 'alert',
    defaultWeight: 40,
    evaluate({ message, options }) {
      const words = strArray(options.words);
      if (words.length === 0 || !message.text) return miss();
      const loweredText = message.text.toLowerCase();
      const matched = words.filter((word) => word && loweredText.includes(word.toLowerCase()));
      if (matched.length === 0) return miss();
      return hit(`命中敏感词: ${matched.join('、')}`, {
        weight: num(options.weight, 40),
        evidence: { matched },
      });
    },
  },
  {
    id: 'link-flood',
    description: '短时间内重复发送链接',
    action: 'warn',
    defaultWeight: 25,
    evaluate({ message, recentByMember, options }) {
      const isLink = message.kind === 'link' || /https?:\/\//i.test(message.text);
      if (!isLink) return miss();
      const windowMs = num(options.windowMs, 5 * 60_000);
      const threshold = num(options.threshold, 3);
      const count = recentByMember.filter(
        (item) =>
          message.timestamp - item.timestamp <= windowMs &&
          (item.kind === 'link' || /https?:\/\//i.test(item.text)),
      ).length;
      if (count < threshold) return miss();
      return hit(`${windowMs / 60_000} 分钟内发送第 ${count + 1} 条链接`, {
        weight: num(options.weight, 25),
        evidence: { count, windowMs, threshold },
      });
    },
  },
  {
    id: 'burst-spam',
    description: '刷屏：短时间高频发言',
    action: 'mute-suggest',
    defaultWeight: 20,
    evaluate({ message, recentByMember, options }) {
      const windowMs = num(options.windowMs, 60_000);
      const threshold = num(options.threshold, 10);
      const count = recentByMember.filter(
        (item) => message.timestamp - item.timestamp <= windowMs,
      ).length;
      if (count < threshold) return miss();
      return hit(`${windowMs / 1000} 秒内发言 ${count + 1} 条`, {
        weight: num(options.weight, 20),
        evidence: { count, windowMs, threshold },
      });
    },
  },
  {
    id: 'duplicate-content',
    description: '重复内容：同一条消息反复发送',
    action: 'warn',
    defaultWeight: 15,
    evaluate({ message, recentByMember, options }) {
      if (!message.text || message.text.length < 4) return miss();
      const windowMs = num(options.windowMs, 10 * 60_000);
      const threshold = num(options.threshold, 3);
      const normalized = message.text.trim().toLowerCase();
      const count = recentByMember.filter(
        (item) =>
          message.timestamp - item.timestamp <= windowMs &&
          item.text.trim().toLowerCase() === normalized,
      ).length;
      if (count < threshold) return miss();
      return hit(`相同内容重复 ${count + 1} 次`, {
        weight: num(options.weight, 15),
        evidence: { count, windowMs, threshold },
      });
    },
  },
  {
    id: 'silent-hours',
    description: '静默时段发言（深夜扰民）',
    action: 'alert',
    defaultWeight: 10,
    evaluate({ message, options }) {
      const startHour = num(options.startHour, 23);
      const endHour = num(options.endHour, 6);
      const hour = new Date(message.timestamp).getHours();
      // 跨零点区间（23 → 6）要用「或」判断，否则整段逻辑失效。
      const inQuiet = startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
      if (!inQuiet) return miss();
      if (message.text.length < num(options.minChars, 5)) return miss();
      return hit(`静默时段 ${hour}:00 发言`, {
        weight: num(options.weight, 10),
        evidence: { hour, startHour, endHour },
      });
    },
  },
  {
    id: 'mention-storm',
    description: '@ 轰炸：单条消息 @ 大量成员',
    action: 'warn',
    defaultWeight: 30,
    evaluate({ message, options }) {
      const threshold = num(options.threshold, 5);
      if (message.mentions.length < threshold) return miss();
      return hit(`单条消息 @ 了 ${message.mentions.length} 人`, {
        weight: num(options.weight, 30),
        evidence: { mentions: message.mentions.length, threshold },
      });
    },
  },
  {
    id: 'media-flood',
    description: '媒体刷屏：短时间内大量图片/视频/文件',
    action: 'warn',
    defaultWeight: 20,
    evaluate({ message, recentByMember, options }) {
      const mediaKinds = new Set(['image', 'video', 'file', 'sticker']);
      if (!mediaKinds.has(message.kind)) return miss();
      const windowMs = num(options.windowMs, 3 * 60_000);
      const threshold = num(options.threshold, 8);
      const count = recentByMember.filter(
        (item) => message.timestamp - item.timestamp <= windowMs && mediaKinds.has(item.kind),
      ).length;
      if (count < threshold) return miss();
      return hit(`${windowMs / 60_000} 分钟内发送 ${count + 1} 条媒体内容`, {
        weight: num(options.weight, 20),
        evidence: { count, windowMs, threshold },
      });
    },
  },
  {
    id: 'contact-solicitation',
    description: '拉私聊：诱导添加联系方式',
    action: 'alert',
    defaultWeight: 35,
    evaluate({ message, options }) {
      if (!message.text) return miss();
      const patterns = strArray(options.patterns);
      const effective =
        patterns.length > 0
          ? patterns
          : ['加我微信', '加v', '加V', '私聊', '扫码', '点我头像', '备注', '代购', '代理', '返利'];
      const matched = effective.filter((pattern) => message.text.includes(pattern));
      if (matched.length === 0) return miss();
      return hit(`疑似导流话术: ${matched.join('、')}`, {
        weight: num(options.weight, 35),
        evidence: { matched },
      });
    },
  },
];

export interface GuardEngineOptions {
  rules: readonly GuardRule[];
  /** 每条规则是否启用及私有配置，键为规则 id。 */
  ruleConfigs: ReadonlyMap<string, GuardRuleConfig>;
  alertThreshold: number;
  windowMs: number;
  /** 每个会话保留的滑动窗口消息条数。 */
  windowSize?: number;
  /** 风险分查询回调；默认只依赖本次会话内存窗口。 */
  riskScoreLookup?: (conversationId: string, memberId: string, since: number) => number;
}

export class GuardEngine {
  #rules: readonly GuardRule[];
  #ruleConfigs: ReadonlyMap<string, GuardRuleConfig>;
  #alertThreshold: number;
  #windowMs: number;
  #windowSize: number;
  #windows = new Map<string, NormalizedMessage[]>();
  #riskScoreLookup: GuardEngineOptions['riskScoreLookup'];

  constructor(options: GuardEngineOptions) {
    this.#rules = options.rules;
    this.#ruleConfigs = options.ruleConfigs;
    this.#alertThreshold = options.alertThreshold;
    this.#windowMs = options.windowMs;
    this.#windowSize = options.windowSize ?? 200;
    this.#riskScoreLookup = options.riskScoreLookup;
  }

  /** 启用中的规则，供 `wechatpro rules` 展示。 */
  activeRules(): Array<{ id: string; description: string; action: RuleAction; weight: number }> {
    return this.#rules
      .filter((rule) => this.#ruleConfigs.get(rule.id)?.enabled ?? true)
      .map((rule) => {
        const config = this.#ruleConfigs.get(rule.id);
        return {
          id: rule.id,
          description: config?.description || rule.description,
          action: config?.action ?? rule.action,
          weight: config?.weight ?? rule.defaultWeight,
        };
      });
  }

  /**
   * 评估一条消息。
   *
   * 每次调用都会把消息并入窗口——调用方不要另外自己维护窗口，
   * 否则同一条消息会被计两次，刷屏类规则的阈值会提前触发。
   */
  evaluate(message: NormalizedMessage, now = Date.now()): GuardAlert[] {
    const key = `${message.conversation.id}`;
    const window = this.#windows.get(key) ?? [];
    const recentByMember = window.filter((item) => item.sender.id === message.sender.id);
    const alerts: GuardAlert[] = [];
    const since = now - this.#windowMs;

    for (const rule of this.#rules) {
      const config = this.#ruleConfigs.get(rule.id);
      if (config && !config.enabled) continue;
      const options = config?.options ?? {};
      const context: RuleContext = {
        message,
        recentByMember,
        recentByConversation: window,
        options,
        now,
      };

      let verdict: RuleVerdict;
      try {
        verdict = rule.evaluate(context);
      } catch (error) {
        // 单条规则写错不应该让整条消息处理链路中断；记录为 engine.error 由上层处理。
        alerts.push({
          ruleId: rule.id,
          ruleDescription: rule.description,
          action: 'alert',
          weight: 0,
          reason: `规则执行异常: ${error instanceof Error ? error.message : String(error)}`,
          conversationId: message.conversation.id,
          memberId: message.sender.id,
          messageId: message.id,
          riskScore: 0,
          breached: false,
          evidence: { error: String(error) },
          at: now,
        });
        continue;
      }

      if (!verdict.hit) continue;

      const weight = verdict.weight ?? config?.weight ?? rule.defaultWeight;
      const historical = this.#riskScoreLookup?.(message.conversation.id, message.sender.id, since) ?? 0;
      const riskScore = historical + weight;
      alerts.push({
        ruleId: rule.id,
        ruleDescription: config?.description || rule.description,
        action: config?.action ?? rule.action,
        weight,
        reason: verdict.reason ?? rule.description,
        conversationId: message.conversation.id,
        memberId: message.sender.id,
        messageId: message.id,
        riskScore,
        breached: riskScore >= this.#alertThreshold,
        evidence: verdict.evidence ?? {},
        at: now,
      });
    }

    // 窗口维护：按会话裁剪到 windowSize，按时间裁剪到 windowMs 之外的老消息。
    const next = [message, ...window].filter((item) => now - item.timestamp <= this.#windowMs * 4);
    if (next.length > this.#windowSize) next.length = this.#windowSize;
    this.#windows.set(key, next);
    // 空转的会话窗口要回收，否则群数量多时内存随会话数单调增长。
    if (this.#windows.size > 500) {
      for (const [convId, items] of this.#windows) {
        if (items.length === 0 || items.length === next.length) continue;
        if (convId !== key) this.#windows.delete(convId);
      }
    }

    return alerts;
  }

  /** 清理某个会话的窗口，会话解散或配置热更新时调用。 */
  reset(conversationId?: string): void {
    if (conversationId) this.#windows.delete(conversationId);
    else this.#windows.clear();
  }
}

/**
 * 依据配置构建规则实例。
 *
 * `id` 相同但配置自带 `options.words` 等私有字段时，用配置覆盖内置默认值；
 * 配置里出现未知 `id` 时按「自定义规则」处理——只做敏感词匹配，
 * 这样使用方不必写代码就能补充词表类规则。
 */
export function createRules(configs: readonly GuardRuleConfig[]): GuardRule[] {
  const byId = new Map(builtinRules.map((rule) => [rule.id, rule]));
  const custom: GuardRule[] = [];

  for (const config of configs) {
    if (byId.has(config.id)) continue;
    const words = Array.isArray(config.options.words) ? config.options.words : null;
    if (!words) continue;
    const rule: GuardRule = {
      id: config.id,
      description: config.description || `自定义词表规则 ${config.id}`,
      action: config.action,
      defaultWeight: config.weight,
      evaluate({ message }) {
        const list = strArray(config.options.words);
        if (list.length === 0 || !message.text) return miss();
        const lowered = message.text.toLowerCase();
        const matched = list.filter((word) => word && lowered.includes(word.toLowerCase()));
        if (matched.length === 0) return miss();
        return hit(`命中自定义词表: ${matched.join('、')}`, {
          weight: config.weight,
          evidence: { matched },
        });
      },
    };
    custom.push(rule);
  }

  return [...builtinRules, ...custom];
}

/** 把规则配置数组转成引擎要的 Map，重复 id 后者胜出（便于按环境覆盖）。 */
export function toRuleConfigMap(configs: readonly GuardRuleConfig[]): Map<string, GuardRuleConfig> {
  return new Map(configs.map((config) => [config.id, config]));
}
