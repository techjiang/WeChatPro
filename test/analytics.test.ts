import { beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsEngine, DAY_MS, HOUR_MS, lastDays, topWordsOf } from '../src/analytics/index.js';
import { Store } from '../src/core/store.js';
import { message } from './helpers.js';

describe('AnalyticsEngine', () => {
  let store: Store;
  let engine: AnalyticsEngine;

  beforeEach(() => {
    store = new Store({ path: ':memory:' });
    engine = new AnalyticsEngine(store, 24);
  });

  function seed(rows: Array<{ id: string; sender: string; text: string; at: number }>): void {
    for (const row of rows) {
      store.insertMessage(
        message({
          id: row.id,
          sender: { id: row.sender, displayName: row.sender },
          text: row.text,
          timestamp: row.at,
        }),
        [row.text.slice(0, 2)],
        HOUR_MS,
      );
    }
  }

  it('activity 汇总总量、人数与占比', () => {
    const now = Date.now();
    seed([
      { id: 'a1', sender: 'u1', text: 'aaa', at: now },
      { id: 'a2', sender: 'u1', text: 'bbb', at: now + 1000 },
      { id: 'a3', sender: 'u2', text: 'ccc', at: now + 2000 },
    ]);

    const report = engine.activity('g1', lastDays(7, now));
    expect(report.totalMessages).toBe(3);
    expect(report.activeMembers).toBe(2);
    expect(report.members[0]?.memberId).toBe('u1');
    expect(report.members[0]?.messageCount).toBe(2);
    // 两人消息数 2:1，占比应为 2/3
    expect(report.members[0]?.share).toBeCloseTo(2 / 3, 3);
    expect(report.kinds.text).toBe(3);
  });

  it('activity 在同一发送者的同一时段桶内正确累加', () => {
    const now = new Date('2026-01-05T10:15:00Z').getTime();
    seed([
      { id: 'b1', sender: 'u1', text: 'x', at: now },
      { id: 'b2', sender: 'u1', text: 'y', at: now + 60_000 },
    ]);
    const report = engine.activity('g1', { from: now - DAY_MS, to: 0 });
    expect(report.members[0]?.messageCount).toBe(2);
    // 两条都在同一小时桶，桶数应为 1
    expect(store.activityTimeline('g1', 0, 0)).toHaveLength(1);
  });

  it('heatmap 输出 24 小时与 7 天维度且总量守恒', () => {
    const base = new Date('2026-01-05T10:15:00Z').getTime();
    seed([
      { id: 'h1', sender: 'u1', text: 'x', at: base },
      { id: 'h2', sender: 'u2', text: 'y', at: base + 2 * HOUR_MS },
    ]);
    const heat = engine.heatmap('g1', { from: 0, to: 0 });
    expect(heat.hourly).toHaveLength(24);
    expect(heat.weekday).toHaveLength(7);
    const hourTotal = heat.hourly.reduce((sum, n) => sum + n, 0);
    expect(hourTotal).toBe(2);
    expect(heat.peak).not.toBeNull();
    expect(heat.peak?.count).toBe(1);
  });

  it('trend 识别升温与降温', () => {
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    // 第一天 1 条，第二天 5 条 → 升温
    seed([{ id: 't0', sender: 'u1', text: 'x', at: base }]);
    for (let i = 0; i < 5; i += 1) {
      seed([{ id: `t${i + 1}`, sender: 'u1', text: 'y', at: base + DAY_MS + i * 60000 }]);
    }
    const trend = engine.trend('g1', { from: base - DAY_MS, to: 0 }, DAY_MS);
    expect(trend.points.length).toBeGreaterThanOrEqual(2);
    expect(trend.direction).toBe('rising');
    expect(trend.total).toBe(6);
  });

  it('trend 样本不足时判为平稳', () => {
    seed([{ id: 'z1', sender: 'u1', text: 'x', at: Date.now() }]);
    const trend = engine.trend('g1', { from: 0, to: 0 }, DAY_MS);
    expect(trend.direction).toBe('stable');
    expect(trend.slopePerBucket).toBe(0);
  });

  it('topics 按词频降序', () => {
    seed([
      { id: 'w1', sender: 'u1', text: '项目', at: Date.now() },
      { id: 'w2', sender: 'u2', text: '项目', at: Date.now() + 1 },
      { id: 'w3', sender: 'u3', text: '团建', at: Date.now() + 2 },
    ]);
    const topics = engine.topics('g1', 10);
    expect(topics.words[0]?.count).toBeGreaterThanOrEqual(topics.words[1]?.count ?? 0);
    expect(topics.totalOccurrences).toBeGreaterThan(0);
  });

  it('memberProfile 给出沉默天数与画像', () => {
    const now = Date.now();
    seed([{ id: 'p1', sender: 'u1', text: '项目进度同步', at: now - 20 * DAY_MS }]);
    const profile = engine.memberProfile('g1', 'u1', now);
    expect(profile).not.toBeNull();
    expect(profile?.silentDays).toBe(20);
    expect(profile?.tenureDays).toBe(20);
    expect(profile?.messageCount).toBe(1);
  });

  it('memberProfile 对未知成员返回 null', () => {
    expect(engine.memberProfile('g1', 'ghost')).toBeNull();
  });

  it('digest 组合四个维度', () => {
    seed([{ id: 'd1', sender: 'u1', text: '开会', at: Date.now() }]);
    const digest = engine.digest('g1', lastDays(7));
    expect(digest.activity.totalMessages).toBe(1);
    expect(digest.heatmap.cells.length).toBeGreaterThan(0);
    expect(digest.highlights.topMembers).toHaveLength(1);
  });
});

describe('topWordsOf', () => {
  it('按消息维度计数并支持停用词', () => {
    const result = topWordsOf(['项目 项目', '项目 进度'], 5, new Set());
    expect(result[0]?.word).toBe('项目');
    expect(result[0]?.count).toBe(2);
  });

  it('空输入返回空数组', () => {
    expect(topWordsOf([], 5)).toEqual([]);
  });
});
