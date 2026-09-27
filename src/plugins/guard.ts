import { createRules, GuardEngine, toRuleConfigMap, type GuardAlert } from '../guard/index.js';
import type { EngineContext } from '../core/context.js';
import type { Plugin } from '../core/plugin.js';
import type { NormalizedMessage } from '../core/types.js';

/**
 * 风控插件。
 *
 * 处置策略刻意保守：默认只「记录事件 + 提示管理员」，不自动禁言/踢人。
 * 群聊语境下自动处罚的误伤代价远高于漏报——一次错误禁言会让群主失去信任，
 * 而漏报只是晚一步发现。自动动作必须由使用方显式开启 `autoActions`。
 */

export interface GuardPluginOptions {
  /** 是否启用自动动作；关闭时只落事件与告警。 */
  autoActions?: boolean;
  /**
   * 自动动作映射：动作名 → 目标会话。
   * 用显式白名单而不是「所有群都执行」，避免配置失误波及全部社群。
   */
  actionTargets?: Record<string, string[]>;
  /** 是否把 AI 语义审核并入判定（需要 ai.enabled）。 */
  useAi?: boolean;
  /** AI 审核后的策略描述。 */
  aiPolicy?: string;
}

export function createGuardPlugin(): Plugin {
  let guard: GuardEngine | null = null;
  let pluginOptions: GuardPluginOptions = {};

  return {
    manifest: {
      name: 'guard',
      description: '自动化检测：敏感词、广告导流、刷屏、重复内容、异常行为',
    },
    setup(context: EngineContext, options: Record<string, unknown>): void {
      pluginOptions = options as GuardPluginOptions;
      const rules = createRules(context.config.guard.rules);
      guard = new GuardEngine({
        rules,
        ruleConfigs: toRuleConfigMap(context.config.guard.rules),
        alertThreshold: context.config.guard.alertThreshold,
        windowMs: context.config.guard.windowMs,
        riskScoreLookup: (conversationId, memberId, since) =>
          context.store.riskScoreSince(conversationId, memberId, since),
      });
      context.logger.info(
        { rules: guard.activeRules().map((rule) => rule.id) },
        '风控规则已加载',
      );
    },
    subscriptions(context) {
      return [
        {
          event: 'message' as const,
          handle: (payload) => {
            if (!guard || !context.config.guard.enabled) return;
            const message = payload as NormalizedMessage;
            const alerts = guard.evaluate(message);
            for (const alert of alerts) {
              if (alert.weight === 0) {
                // weight 0 表示规则自身异常，不是业务命中，走 engine.error 而非告警。
                context.logger.warn({ rule: alert.ruleId, reason: alert.reason }, '风控规则执行异常');
                continue;
              }
              context.store.insertEvent({
                conversation_id: alert.conversationId,
                member_id: alert.memberId,
                type: 'guard',
                severity: severityOf(alert),
                score: alert.weight,
                detail: JSON.stringify({
                  ruleId: alert.ruleId,
                  reason: alert.reason,
                  evidence: alert.evidence,
                  messageId: alert.messageId,
                }),
                ts: alert.at,
              });
              if (alert.breached) {
                context.bus.emit('alert', alert);
                void maybeAct(context, alert, pluginOptions);
              }
            }
          },
        },
        {
          event: 'alert' as const,
          handle: (payload) => {
            const alert = payload as GuardAlert;
            context.logger.warn(
              { rule: alert.ruleId, conversation: alert.conversationId, risk: alert.riskScore },
              `风控告警: ${alert.reason}`,
            );
          },
        },
      ];
    },
  };
}

/** 越阈值后风险越高，严重度越高；三档足够运营侧分流处理。 */
export function severityOf(alert: GuardAlert): 'low' | 'medium' | 'high' {
  if (alert.riskScore >= 80) return 'high';
  if (alert.riskScore >= 50) return 'medium';
  return 'low';
}

/**
 * 执行自动动作。
 *
 * 目前只实现「发提醒」——它是唯一在群聊里可撤销、零副作用的动作。
 * 禁言/踢人依赖协议能力且不可逆，留给使用方接自己的适配器实现，
 * 这里不提供半成品开关（有开关但没实现的配置比没有更危险）。
 */
async function maybeAct(
  context: EngineContext,
  alert: GuardAlert,
  options: GuardPluginOptions,
): Promise<void> {
  if (!options.autoActions) return;
  const targets = new Set([
    alert.conversationId,
    ...(options.actionTargets?.[alert.action] ?? []),
  ]);
  if (targets.size === 0) return;

  const text = [
    `⚠️ 检测到疑似违规行为`,
    `成员：${alert.memberId}`,
    `原因：${alert.reason}`,
    `风险分：${alert.riskScore}`,
    `建议动作：${alert.action}`,
  ].join('\n');

  for (const target of targets) {
    await context.sendMessage(target, text);
  }
}
