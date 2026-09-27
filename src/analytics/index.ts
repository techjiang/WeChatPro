import type { Store, MemberRow } from '../core/store.js';
import type { NormalizedMessage } from '../core/types.js';
import { filterTokens, normalizeText, tokenize } from '../core/text.js';

/**
 * 群聊统计引擎。
 *
 * 只从预聚合表（activity_buckets / word_stats）读数，不扫 messages 全表：
 * 报表是高频只读操作，全表扫会随历史增长线性劣化，而预聚合让查询成本与
 * 时间跨度而非总数据量相关。
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface TimeRange {
  /** 毫秒时间戳，闭区间。 */
  from: number;
  /** 毫秒时间戳；0 表示不限上界。 */
  to: number;
}

/** 常用区间构造器：以 `now` 为基准往前推。 */
export function lastDays(days: number, now = Date.now()): TimeRange {
  return { from: now - days * DAY_MS, to: 0 };
}

export interface MemberStat {
  memberId: string;
  displayName: string;
  messageCount: number;
  charCount: number;
  /** 平均每条消息字数，衡量「话痨程度」而非「发言次数」。 */
  avgChars: number;
  /** 群内发言占比（0~1）。 */
  share: number;
  /** 参与的消息类型分布。 */
  kinds: Record<string, number>;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ActivityReport {
  conversationId: string;
  range: TimeRange;
  totalMessages: number;
  /** 活跃成员数：区间内至少发过一条消息的成员。 */
  activeMembers: number;
  /** 人均条数。 */
  messagesPerMember: number;
  /** 日均条数，按区间跨度折算。 */
  messagesPerDay: number;
  members: MemberStat[];
  kinds: Record<string, number>;
}

export interface HeatmapCell {
  /** 0 = 周日 … 6 = 周六，与 `Date.getDay()` 一致。 */
  weekday: number;
  /** 0–23。 */
  hour: number;
  count: number;
}

export interface HeatmapReport {
  conversationId: string;
  range: TimeRange;
  cells: HeatmapCell[];
  /** 最活跃的时段，无数据时为 `null`。 */
  peak: HeatmapCell | null;
  /** 最冷清的时段（仅统计有桶的时段）。 */
  quietest: HeatmapCell | null;
  /** 按小时聚合的总量，长度 24。 */
  hourly: number[];
  /** 按星期聚合的总量，长度 7。 */
  weekday: number[];
}

export interface TrendPoint {
  /** 桶起始毫秒时间戳。 */
  at: number;
  count: number;
}

export interface TrendReport {
  conversationId: string;
  range: TimeRange;
  /** 采样粒度（毫秒），由区间长度自动选择或调用方指定。 */
  bucketMs: number;
  points: TrendPoint[];
  total: number;
  /** 线性回归斜率（条/桶），正数代表升温。 */
  slopePerBucket: number;
  direction: 'rising' | 'falling' | 'stable';
}

export interface TopicReport {
  conversationId: string;
  words: Array<{ word: string; count: number; lastSeenAt: number }>;
  /** 词频总和，用于计算归一化热度。 */
  totalOccurrences: number;
}

export interface MemberProfile {
  member: MemberRow;
  messageCount: number;
  charCount: number;
  avgChars: number;
  share: number;
  kinds: Record<string, number>;
  /** 活跃时段排名前 3 的小时。 */
  activeHours: number[];
  /** 该成员最常用的词（基于其历史文本）。 */
  topWords: Array<{ word: string; count: number }>;
  /** 首末发言距今的天数。 */
  tenureDays: number;
  silentDays: number;
}

export class AnalyticsEngine {
  #store: Store;
  #hourlyBuckets: number;

  constructor(store: Store, hourlyBuckets = 24) {
    this.#store = store;
    this.#hourlyBuckets = hourlyBuckets;
  }

  /** 统计的抽样粒度。默认 1 小时；把细粒度桶聚合到目标粒度。 */
  get bucketMs(): number {
    return Math.max(HOUR_MS, Math.floor(DAY_MS / this.#hourlyBuckets));
  }

  activity(conversationId: string, range: TimeRange): ActivityReport {
    const rows = this.#store.activityBySender(conversationId, range.from, range.to);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const members: MemberStat[] = rows.map((row) => {
      const profile = this.#store.getMember(conversationId, row.sender_id);
      const kinds: Record<string, number> = {};
      for (const kind of row.kinds.split(',')) {
        if (kind) kinds[kind] = (kinds[kind] ?? 0) + 1;
      }
      return {
        memberId: row.sender_id,
        displayName: profile?.display_name ?? row.sender_id,
        messageCount: row.count,
        charCount: row.char_count,
        avgChars: row.count > 0 ? Number((row.char_count / row.count).toFixed(2)) : 0,
        share: total > 0 ? Number((row.count / total).toFixed(4)) : 0,
        kinds,
        firstSeenAt: profile?.first_seen_at ?? 0,
        lastSeenAt: profile?.last_seen_at ?? 0,
      };
    });

    const kindRows = this.#store.kindBreakdown(conversationId, range.from, range.to);
    const kinds: Record<string, number> = {};
    for (const row of kindRows) kinds[row.kind] = row.count;

    const spanDays = this.#spanDays(range);
    return {
      conversationId,
      range,
      totalMessages: total,
      activeMembers: members.length,
      messagesPerMember: members.length > 0 ? Number((total / members.length).toFixed(2)) : 0,
      messagesPerDay: spanDays > 0 ? Number((total / spanDays).toFixed(2)) : total,
      members,
      kinds,
    };
  }

  /**
   * 星期 × 小时热力图。
   *
   * 用服务端本地时区换算业务时间——群聊活跃度天然按「用户所在时区」理解，
   * 统一成 UTC 会让「晚上 9 点高峰」显示成凌晨，报表就没法用了。
   */
  heatmap(conversationId: string, range: TimeRange): HeatmapReport {
    const timeline = this.#store.activityTimeline(conversationId, range.from, range.to);
    const acc = new Map<string, HeatmapCell>();
    const hourly = new Array<number>(24).fill(0);
    const weekday = new Array<number>(7).fill(0);

    for (const point of timeline) {
      const date = new Date(point.bucket_start);
      // 桶可能跨小时（hourlyBuckets < 24），按桶起始小时归档并保持总量守恒。
      const cell: HeatmapCell = {
        weekday: date.getDay(),
        hour: date.getHours(),
        count: 0,
      };
      const key = `${cell.weekday}:${cell.hour}`;
      const existing = acc.get(key);
      if (existing) {
        existing.count += point.count;
      } else {
        acc.set(key, { ...cell, count: point.count });
      }
      hourly[cell.hour] = (hourly[cell.hour] ?? 0) + point.count;
      weekday[cell.weekday] = (weekday[cell.weekday] ?? 0) + point.count;
    }

    const cells = [...acc.values()].sort((a, b) => b.count - a.count);
    return {
      conversationId,
      range,
      cells,
      peak: cells[0] ?? null,
      quietest: cells.length > 0 ? (cells[cells.length - 1] as HeatmapCell) : null,
      hourly,
      weekday,
    };
  }

  /**
   * 活跃度趋势。
   *
   * 粒度自适应：区间越长桶越粗，否则短区间会画出上百个噪声点。
   * `slopePerBucket` 用最小二乘拟合，给「群在升温还是变冷」一个可程序判定的信号。
   */
  trend(conversationId: string, range: TimeRange, bucketMs?: number): TrendReport {
    const span = this.#spanMs(range);
    const auto = span <= DAY_MS ? HOUR_MS : span <= 30 * DAY_MS ? DAY_MS : 7 * DAY_MS;
    const granularity = bucketMs ?? auto;

    const timeline = this.#store.activityTimeline(conversationId, range.from, range.to);
    const merged = new Map<number, number>();
    for (const point of timeline) {
      const bucket = Math.floor(point.bucket_start / granularity) * granularity;
      merged.set(bucket, (merged.get(bucket) ?? 0) + point.count);
    }
    const points = [...merged.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([at, count]) => ({ at, count }));

    return {
      conversationId,
      range,
      bucketMs: granularity,
      points,
      total: points.reduce((sum, p) => sum + p.count, 0),
      ...this.#slope(points),
    };
  }

  topics(conversationId: string, limit = 50): TopicReport {
    const words = this.#store.topWords(conversationId, limit);
    return {
      conversationId,
      words: words.map((row) => ({
        word: row.word,
        count: row.count,
        lastSeenAt: row.last_seen_at,
      })),
      totalOccurrences: words.reduce((sum, row) => sum + row.count, 0),
    };
  }

  /**
   * 成员画像。
   *
   * `silentDays` 是流失预警的核心指标：长期沉默但有历史积累的成员，
   * 比新进群就潜水的人更值得打扰一次。
   */
  memberProfile(conversationId: string, memberId: string, now = Date.now()): MemberProfile | null {
    const member = this.#store.getMember(conversationId, memberId);
    if (!member) return null;

    const totals = this.#store.activityBySender(conversationId, 0, 0);
    const row = totals.find((item) => item.sender_id === memberId);
    const total = totals.reduce((sum, item) => sum + item.count, 0);
    const kinds: Record<string, number> = {};
    for (const kind of (row?.kinds ?? '').split(',')) {
      if (kind) kinds[kind] = (kinds[kind] ?? 0) + 1;
    }

    // 成员级活跃时段需按 sender 聚合 activity_buckets；该表已按 sender 分桶，这里是单成员查询。
    const activeHours = this.#topHoursForMember(conversationId, memberId);

    return {
      member,
      messageCount: row?.count ?? 0,
      charCount: row?.char_count ?? 0,
      avgChars: row && row.count > 0 ? Number((row.char_count / row.count).toFixed(2)) : 0,
      share: total > 0 && row ? Number((row.count / total).toFixed(4)) : 0,
      kinds,
      activeHours,
      topWords: this.#wordsForMember(conversationId, memberId),
      tenureDays: Math.max(0, Math.round((now - member.first_seen_at) / DAY_MS)),
      silentDays: Math.max(0, Math.floor((now - member.last_seen_at) / DAY_MS)),
    };
  }

  /** 全群日报：把各维度拼成一份可直接推送的摘要。 */
  digest(conversationId: string, range: TimeRange, topWords = 10, topMembers = 5): {
    activity: ActivityReport;
    heatmap: HeatmapReport;
    trend: TrendReport;
    topics: TopicReport;
    highlights: {
      topMembers: MemberStat[];
      peakHour: number | null;
      peakWeekday: number | null;
    };
  } {
    const activity = this.activity(conversationId, range);
    const heat = this.heatmap(conversationId, range);
    const trend = this.trend(conversationId, range);
    return {
      activity,
      heatmap: heat,
      trend,
      topics: this.topics(conversationId, topWords),
      highlights: {
        topMembers: activity.members.slice(0, topMembers),
        peakHour: heat.peak?.hour ?? null,
        peakWeekday: heat.peak?.weekday ?? null,
      },
    };
  }

  #topHoursForMember(conversationId: string, memberId: string): number[] {
    const rows = this.#store.db
      .prepare(
        `SELECT bucket_start, SUM(count) AS count
           FROM activity_buckets
          WHERE conversation_id = ? AND sender_id = ?
          GROUP BY bucket_start
          ORDER BY count DESC
          LIMIT 200`,
      )
      .all(conversationId, memberId) as Array<{ bucket_start: number; count: number }>;
    const byHour = new Map<number, number>();
    for (const row of rows) {
      const hour = new Date(row.bucket_start).getHours();
      byHour.set(hour, (byHour.get(hour) ?? 0) + row.count);
    }
    return [...byHour.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour]) => hour);
  }

  #wordsForMember(conversationId: string, memberId: string): Array<{ word: string; count: number }> {
    // 词频表是「会话 × 词」维度，没有成员维度；成员级用词得从消息文本现算。
    // 单成员消息量有限（受 retainMessages 控制），代价可接受。
    const rows = this.#store.db
      .prepare(
        `SELECT text FROM messages
          WHERE conversation_id = ? AND sender_id = ? AND kind = 'text'
          ORDER BY ts DESC LIMIT 2000`,
      )
      .all(conversationId, memberId) as Array<{ text: string }>;
    return topWordsOf(rows.map((r) => r.text), 10);
  }

  #spanMs(range: TimeRange): number {
    const end = range.to === 0 ? Date.now() : range.to;
    return Math.max(0, end - range.from);
  }

  #spanDays(range: TimeRange): number {
    return this.#spanMs(range) / DAY_MS;
  }

  #slope(points: readonly TrendPoint[]): Pick<TrendReport, 'slopePerBucket' | 'direction'> {
    if (points.length < 2) return { slopePerBucket: 0, direction: 'stable' };
    const n = points.length;
    // x 用桶序号而非时间戳：时间戳量级 1e12，直接做最小二乘会有精度损失。
    const meanX = (n - 1) / 2;
    const meanY = points.reduce((sum, p) => sum + p.count, 0) / n;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = i - meanX;
      numerator += dx * ((points[i] as TrendPoint).count - meanY);
      denominator += dx * dx;
    }
    const slope = denominator === 0 ? 0 : numerator / denominator;
    // 阈值取均值的一个小比例：绝对斜率会随群规模变化，相对量才可比。
    const threshold = Math.max(0.05, meanY * 0.02);
    const direction: TrendReport['direction'] =
      slope > threshold ? 'rising' : slope < -threshold ? 'falling' : 'stable';
    return { slopePerBucket: Number(slope.toFixed(4)), direction };
  }
}

/** 从一组文本里取高频词，供成员画像等「非预聚合」场景使用。 */
export function topWordsOf(
  texts: readonly string[],
  limit: number,
  stopWords: ReadonlySet<string> = new Set(),
): Array<{ word: string; count: number }> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of new Set(tokenizeForStats(text, stopWords))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

function tokenizeForStats(text: string, stopWords: ReadonlySet<string>): string[] {
  return filterTokens(tokenize(normalizeText(text)), stopWords);
}

export type { NormalizedMessage };
