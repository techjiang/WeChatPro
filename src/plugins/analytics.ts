import { AnalyticsEngine, lastDays, type TimeRange } from '../analytics/index.js';
import type { EngineContext } from '../core/context.js';
import type { Plugin } from '../core/plugin.js';
import type { NormalizedMessage } from '../core/types.js';

/**
 * 统计插件。
 *
 * 统计的重活（落库、预聚合）已经在引擎里做完，这个插件只负责
 * 「定时产出报表」与「响应统计指令」。放在插件而不是引擎里，
 * 是为了让不需要报表的部署（比如只做风控）不必承担这部分开销。
 */

export interface AnalyticsPluginOptions {
  /** 每日报表推送时间（cron 表达式），默认每天 09:00。 */
  digestCron?: string;
  /** 日报默认覆盖天数。 */
  digestDays?: number;
  /** 报表推送到哪个会话；为空则不主动推送。 */
  reportConversationId?: string;
}

export function createAnalyticsPlugin(): Plugin {
  let engine: AnalyticsEngine | null = null;

  return {
    manifest: {
      name: 'analytics',
      description: '群聊统计：活跃度、热力图、趋势、词频、成员画像',
    },
    setup(context: EngineContext, options: Record<string, unknown>): void {
      const config = options as AnalyticsPluginOptions;
      engine = new AnalyticsEngine(context.store, context.config.analytics.hourlyBuckets);
      void config;
      context.logger.debug({ buckets: context.config.analytics.hourlyBuckets }, '统计插件已配置');
    },
    subscriptions(context) {
      return [
        {
          event: 'command' as const,
          handle: (payload) => {
            // 指令由 command 插件统一路由后再分发到这里，避免每个插件都解析一遍文本。
            const command = payload as {
              intent?: string;
              conversationId: string;
              reply: (text: string) => void;
              range?: TimeRange;
            };
            if (!command.intent || !engine) return;
            if (!['stats', 'heatmap', 'top'].includes(command.intent)) return;
            const range = command.range ?? lastDays(7);
            command.reply(renderReport(engine, command.intent, command.conversationId, range));
          },
        },
        {
          event: 'engine.error' as const,
          handle: (payload) => {
            context.logger.debug({ err: payload }, '统计插件观察到引擎错误');
          },
        },
      ];
    },
  };
}

/** 渲染文本报表。用纯文本而非 Markdown 表格——群聊里表格会错位。 */
export function renderReport(
  engine: AnalyticsEngine,
  intent: string,
  conversationId: string,
  range: TimeRange,
): string {
  if (intent === 'heatmap') {
    const heat = engine.heatmap(conversationId, range);
    const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const peakText = heat.peak
      ? `${weekdayNames[heat.peak.weekday]} ${String(heat.peak.hour).padStart(2, '0')}:00`
      : '无数据';
    const topHours = heat.hourly
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .filter((item) => item.count > 0)
      .map((item) => `${item.hour}:00(${item.count})`)
      .join('、');
    return [
      `📊 活跃时段热力（${rangeLabel(range)}）`,
      `高峰时段：${peakText}`,
      `前三时段：${topHours || '无'}`,
      `时段分布：${renderSparkline(heat.hourly)}`,
    ].join('\n');
  }

  if (intent === 'top') {
    const activity = engine.activity(conversationId, range);
    if (activity.members.length === 0) return `📊 ${rangeLabel(range)}暂无发言记录。`;
    const lines = activity.members.slice(0, 10).map((member, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
      return `${medal} ${member.displayName} — ${member.messageCount} 条（${(member.share * 100).toFixed(1)}%）`;
    });
    return [`📊 发言排行（${rangeLabel(range)}）`, ...lines].join('\n');
  }

  const activity = engine.activity(conversationId, range);
  const heat = engine.heatmap(conversationId, range);
  const trend = engine.trend(conversationId, range);
  const directionText = { rising: '↑ 升温', falling: '↓ 降温', stable: '→ 平稳' }[trend.direction];
  const kindText = Object.entries(activity.kinds)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([kind, count]) => `${kind} ${count}`)
    .join('，');

  return [
    `📊 群聊统计（${rangeLabel(range)}）`,
    `总消息：${activity.totalMessages} 条｜活跃成员：${activity.activeMembers} 人`,
    `人均：${activity.messagesPerMember} 条｜日均：${activity.messagesPerDay} 条`,
    `趋势：${directionText}`,
    `高峰：${heat.peak ? `${heat.peak.hour}:00` : '无数据'}`,
    `类型：${kindText || '无'}`,
    `最活跃：${activity.members[0]?.displayName ?? '无'}`,
  ].join('\n');
}

/** 用方块字符画迷你柱状图。纯文本环境没有图形，这是最省地方的可视化。 */
export function renderSparkline(values: readonly number[]): string {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...values, 1);
  return values
    .map((value) => {
      if (value === 0) return '·';
      const index = Math.min(blocks.length - 1, Math.floor((value / max) * (blocks.length - 1)));
      return blocks[index] as string;
    })
    .join('');
}

export function rangeLabel(range: TimeRange): string {
  if (range.to === 0) return '至今';
  return '指定区间';
}
