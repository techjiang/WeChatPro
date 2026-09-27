import { AnalyticsEngine, lastDays, type TimeRange } from '../analytics/index.js';
import { buildDigest, previousDayWindow, type DigestWindow } from '../analytics/digest.js';
import { Scheduler } from '../runtime/scheduler.js';
import type { EngineContext } from '../core/context.js';
import type { Plugin } from '../core/plugin.js';
import type { NormalizedMessage } from '../core/types.js';

/**
 * 统计插件。
 *
 * 统计的重活（落库、预聚合）已经在引擎里做完，这个插件只负责
 * 「定时产出报表」与「响应统计指令」。放在插件而不是引擎里，
 * 是为了让不需要报表的部署（比如只做风控）不必承担这部分开销。
 *
 * 日报是**主动推送**而非等人来问：群运营的节奏是早上想知道昨天发生了什么，
 * 而不是自己去翻面板。默认推送时间是本地时区每天 09:00。
 */

export interface AnalyticsPluginOptions {
  /**
   * 每日报表推送时间（cron 表达式），默认每天 09:00。
   *
   * 用 5 段标准 cron，按**本地时区**解释：群聊活跃度天然按用户所在时区理解，
   * 用 UTC 会让「昨晚 9 点高峰」在日报里变成凌晨。
   */
  digestCron?: string;
  /** 日报覆盖的天数（1 = 只报昨天）。 */
  digestDays?: number;
  /** 日报推送到哪个会话；为空则推送到每个有消息的群自身。 */
  reportConversationId?: string;
  /** 无消息的群是否也推日报。默认 false。 */
  digestIncludeEmpty?: boolean;
  /** 单次最多推送几个群，防止首次运行时一次性刷屏。 */
  digestMaxConversations?: number;
  /** 是否启用日报调度。默认跟随 `analytics.enabled`。 */
  digestEnabled?: boolean;
}

export function createAnalyticsPlugin(): Plugin {
  let engine: AnalyticsEngine | null = null;
  let scheduler: Scheduler | null = null;
  let options: AnalyticsPluginOptions = {};

  return {
    manifest: {
      name: 'analytics',
      description: '群聊统计：活跃度、热力图、趋势、词频、成员画像、定时日报',
    },
    setup(context: EngineContext, raw: Record<string, unknown>): void {
      options = raw as AnalyticsPluginOptions;
      engine = new AnalyticsEngine(context.store, context.config.analytics.hourlyBuckets);
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
        {
          event: 'command' as const,
          handle: (payload) => {
            // `/日报`：不想等早上九点，现在就要一份。
            const command = payload as {
              intent?: string;
              question?: string;
              conversationId?: string;
              reply: (text: string) => void;
            };
            if (command.intent !== 'stats') return;
            if (!/日报|digest/i.test(command.question ?? '')) return;
            const report = buildDigest(context.store, command.conversationId ?? '', previousDayWindow(), {
              includeEmpty: true,
            });
            command.reply(report && report.text ? report.text : '昨日无消息。');
          },
        },
      ];
    },
    /**
     * 启动日报调度。
     *
     * 放在 `start()` 而不是 `setup()`：`setup()` 只保证依赖注入完成，
     * 此时引擎可能还没起、适配器还没绑，日报发出去会「成功」但正文是空的。
     * 放在 `start()` 才能确保发送通道已经就绪。
     */
    start(context: EngineContext): void {
      const enabled = options.digestEnabled ?? context.config.analytics.enabled;
      if (!enabled) {
        context.logger.debug('日报调度未启用（analytics.enabled 为 false 或显式关闭）');
        return;
      }
      // 优先级：插件私有 options > 顶层 analytics 配置 > 内置默认。
      // 顶层是「运维一眼能找到」的位置，options 留给需要按环境覆盖的部署。
      const expression = options.digestCron ?? context.config.analytics.digestCron;
      const days = Math.max(1, options.digestDays ?? context.config.analytics.digestDays);
      const configuredTarget = options.reportConversationId ?? context.config.analytics.digestConversationId;
      scheduler = new Scheduler(context.logger);

      const window: (now: number) => DigestWindow =
        days === 1
          ? previousDayWindow
          : (now) => ({ range: lastDays(days, now), label: `最近 ${days} 天` });

      scheduler.add({
        name: 'analytics-daily-digest',
        expression,
        run: async () => {
          const target = configuredTarget || undefined;
          const ids = target
            ? [target]
            : context.store
                .listConversations()
                .map((row) => row.id)
                .slice(0, options.digestMaxConversations ?? context.config.analytics.digestMaxConversations);
          const resolved = window(Date.now());
          let sent = 0;
          for (const conversationId of ids) {
            const report = buildDigest(context.store, conversationId, resolved, {
              includeEmpty: options.digestIncludeEmpty ?? context.config.analytics.digestIncludeEmpty,
            });
            if (!report || report.totalMessages === 0) continue;
            const delivered = await context.sendMessage(
              target ?? conversationId,
              target ? `【${report.conversationName}】
${report.text}` : report.text,
            );
            // 发送失败不抛错：一个群发不出去不该让整个任务记成失败而影响别的群。
            if (delivered) sent += 1;
            else context.logger.warn({ conversationId }, '日报发送失败（适配器不支持主动发送或发送通道报错）');
          }
          context.logger.info({ sent, label: resolved.label, conversations: ids.length }, '日报推送完成');
        },
      });
    },
    stop(): void {
      scheduler?.stop();
      scheduler = null;
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
