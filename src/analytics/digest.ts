import { AnalyticsEngine, DAY_MS, lastDays, type TimeRange } from './index.js';
import { GroupManager } from '../manage/index.js';
import { renderSparkline } from '../plugins/analytics.js';
import type { Store } from '../core/store.js';
import type { EventRow } from '../core/store.js';

/**
 * 群日报。
 *
 * 统计模块原先只会「回答指令」，没人问就什么也不产出。而群运营的真实节奏是：
 * 群主早上想知道昨天群里发生了什么，而不是自己去翻面板。所以日报必须能**主动推**。
 *
 * 两条硬约束决定了实现方式：
 *
 * 1. **不能静默失败**。定时任务的失败是最难发现的故障——没人盯着它，
 *    出错后只是「日报某天不来了」，用户以为是自己没看到。所以这里把
 *    「为什么没推」也当成结果的一部分返回。
 * 2. **必须可测**。cron 本身不可测，但「给定时间点应该推哪一天的日报」
 *    是纯函数，把它抽出来单独钉住，剩下的调度逻辑就只剩几行胶水。
 */

export interface DigestWindow {
  /** 报表区间（毫秒时间戳）。 */
  range: TimeRange;
  /** 区间的人类可读标签，如「2026-09-26」。 */
  label: string;
}

/**
 * 计算「刚过去的那个自然日」。
 *
 * 用**本地时区**而不是 UTC：群聊活跃度天然按用户所在时区理解，
 * 统一成 UTC 会让「昨晚 9 点高峰」在报表里变成凌晨。
 */
export function previousDayWindow(now = Date.now()): DigestWindow {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const from = startOfToday.getTime() - DAY_MS;
  const to = startOfToday.getTime();
  return { range: { from, to }, label: formatDay(from) };
}

/** `YYYY-MM-DD`（本地时区）。 */
export function formatDay(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface DigestReport {
  conversationId: string;
  conversationName: string;
  label: string;
  range: TimeRange;
  text: string;
  /** 区间内消息数，为 0 时调用方可以选择不推。 */
  totalMessages: number;
}

export interface BuildDigestOptions {
  /** 无消息的群是否也产出日报。默认 false（避免每天推送一堆「昨日无消息」）。 */
  includeEmpty?: boolean;
  /** 排行展示人数。 */
  topMembers?: number;
  /** 热门词展示个数。 */
  topWords?: number;
  /** 事件明细最多展示条数。 */
  maxEvents?: number;
}

/**
 * 生成一个群在给定区间的日报文本。
 *
 * 用纯文本而不是 Markdown 表格：日报要能直接发到微信群里，
 * 群聊里表格会因字体比例而错位，排行与条形图反而更易读。
 */
export function buildDigest(
  store: Store,
  conversationId: string,
  window: DigestWindow,
  options: BuildDigestOptions = {},
): DigestReport | null {
  const conversation = store.getConversation(conversationId);
  if (!conversation) return null;

  const analytics = new AnalyticsEngine(store);
  const activity = analytics.activity(conversationId, window.range);
  const topics = analytics.topics(conversationId, options.topWords ?? 8);
  const trend = analytics.trend(conversationId, window.range);
  const events = store.recentEvents(conversationId, 200, 'guard');

  if (activity.totalMessages === 0 && !options.includeEmpty) {
    return {
      conversationId,
      conversationName: conversation.name,
      label: window.label,
      range: window.range,
      text: '',
      totalMessages: 0,
    };
  }

  const lines: string[] = [];
  lines.push(`📅 ${conversation.name} · ${window.label} 日报`);
  lines.push('');

  if (activity.totalMessages === 0) {
    lines.push('昨日无消息。');
  } else {
    const directionText = { rising: '↑ 升温', falling: '↓ 降温', stable: '→ 平稳' }[trend.direction];
    lines.push(
      `总消息 ${activity.totalMessages} 条｜活跃成员 ${activity.activeMembers} 人｜人均 ${activity.messagesPerMember} 条｜趋势 ${directionText}`,
    );

    const top = activity.members.slice(0, options.topMembers ?? 5);
    if (top.length > 0) {
      lines.push('');
      lines.push('发言排行：');
      for (const [index, member] of top.entries()) {
        const medal = ['🥇', '🥈', '🥉'][index] ?? `${index + 1}.`;
        lines.push(`  ${medal} ${member.displayName} — ${member.messageCount} 条（${(member.share * 100).toFixed(1)}%）`);
      }
    }

    const kindText = Object.entries(activity.kinds)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${kind} ${count}`)
      .join('，');
    if (kindText) lines.push(`\n类型分布：${kindText}`);

    // 小时分布用迷你条形图：一天的节奏一眼就能看出来，比列 24 行数字省地方。
    const heat = analytics.heatmap(conversationId, window.range);
    if (heat.hourly.some((count) => count > 0)) {
      const peak = heat.hourly.reduce((best, count, hour) => (count > heat.hourly[best]! ? hour : best), 0);
      lines.push(`时段分布：${renderSparkline(heat.hourly)}（高峰 ${peak}:00）`);
    }

    if (topics.words.length > 0) {
      lines.push(`\n热门话题：${topics.words.map((word) => `${word.word}(${word.count})`).join('、')}`);
    }
  }

  const scoped = events.filter((event) => event.ts >= window.range.from && event.ts < window.range.to);
  if (scoped.length > 0) {
    const byRule = new Map<string, number>();
    for (const event of scoped) {
      const ruleId = ruleIdOf(event);
      byRule.set(ruleId, (byRule.get(ruleId) ?? 0) + 1);
    }
    lines.push('');
    lines.push(`⚠️ 风控事件 ${scoped.length} 起：${[...byRule.entries()].map(([rule, count]) => `${rule}×${count}`).join('、')}`);
    for (const event of scoped.slice(0, options.maxEvents ?? 3)) {
      lines.push(`  · ${reasonOf(event)}（${event.member_id}｜风险分 ${event.score}）`);
    }
  }

  const digest = new GroupManager(store).digest(conversationId);
  if (digest && (digest.newMembers.length > 0 || digest.silentMembers.length > 0)) {
    lines.push('');
    if (digest.newMembers.length > 0) lines.push(`👋 近三天新增 ${digest.newMembers.length} 人`);
    if (digest.silentMembers.length > 0) lines.push(`💤 沉默超两周 ${digest.silentMembers.length} 人（可考虑回访）`);
  }

  return {
    conversationId,
    conversationName: conversation.name,
    label: window.label,
    range: window.range,
    text: lines.join('\n'),
    totalMessages: activity.totalMessages,
  };
}

/** 从事件详情里取规则 id；详情不是 JSON 时退化为事件类型。 */
export function ruleIdOf(event: EventRow): string {
  const detail = parseDetail(event.detail);
  return typeof detail.ruleId === 'string' ? detail.ruleId : event.type;
}

export function reasonOf(event: EventRow): string {
  const detail = parseDetail(event.detail);
  return typeof detail.reason === 'string' ? detail.reason : event.type;
}

function parseDetail(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 便于 CLI 复用：取最近 N 天的聚合日报区间。 */
export function recentWindow(days: number, now = Date.now()): DigestWindow {
  return { range: lastDays(days, now), label: `最近 ${days} 天` };
}
