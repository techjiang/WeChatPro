import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { message } from './helpers.js';
import { HOUR_MS } from '../src/analytics/index.js';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store({ path: ':memory:' });
  });

  it('写入消息并同步更新会话与成员计数', () => {
    store.insertMessage(message({ id: 'm1', text: '你好世界' }), ['你好', '好世', '世界'], HOUR_MS);
    store.insertMessage(message({ id: 'm2', text: '再聊' }), ['再聊'], HOUR_MS);

    const conversations = store.listConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.message_count).toBe(2);

    const members = store.listMembers('g1');
    expect(members.reduce((sum, m) => sum + m.message_count, 0)).toBe(2);
  });

  it('重复消息 ID 只计一次，返回 false', () => {
    const first = store.insertMessage(message({ id: 'dup' }), [], HOUR_MS);
    const second = store.insertMessage(message({ id: 'dup' }), [], HOUR_MS);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(store.listConversations()[0]?.message_count).toBe(1);
  });

  it('累计字符数用于计算平均长度', () => {
    const now = Date.now();
    store.insertMessage(message({ id: 'a', text: '12345', timestamp: now }), [], HOUR_MS);
    store.insertMessage(message({ id: 'b', text: '123', timestamp: now }), [], HOUR_MS);
    const rows = store.activityBySender('g1', 0, 0);
    const total = rows.reduce((sum, row) => sum + row.char_count, 0);
    expect(total).toBe(8);
  });

  it('按时段分桶并可按区间过滤', () => {
    const base = new Date('2026-01-05T10:00:00Z').getTime();
    store.insertMessage(message({ id: 'p1', timestamp: base }), [], HOUR_MS);
    store.insertMessage(message({ id: 'p2', timestamp: base + 3 * HOUR_MS }), [], HOUR_MS);

    expect(store.activityTimeline('g1', base - HOUR_MS, base + HOUR_MS)).toHaveLength(1);
    expect(store.activityTimeline('g1', 0, 0).length).toBeGreaterThanOrEqual(2);
  });

  it('词频按「出现该词的消息数」计数，同条消息重复词不叠加', () => {
    store.insertMessage(message({ id: 'w1', text: '重要 重要 重要' }), ['重要'], HOUR_MS);
    const words = store.topWords('g1', 10);
    expect(words.find((w) => w.word === '重要')?.count).toBe(1);
  });

  it('风控风险分按窗口累计', () => {
    const now = Date.now();
    store.insertEvent({
      conversation_id: 'g1',
      member_id: 'u1',
      type: 'guard',
      severity: 'high',
      score: 30,
      detail: '{}',
      ts: now,
    });
    store.insertEvent({
      conversation_id: 'g1',
      member_id: 'u1',
      type: 'guard',
      severity: 'high',
      score: 20,
      detail: '{}',
      ts: now,
    });
    expect(store.riskScoreSince('g1', 'u1', now - 1000)).toBe(50);
    expect(store.riskScoreSince('g1', 'u1', now + 1)).toBe(0);
  });

  it('检索历史消息', () => {
    store.insertMessage(message({ id: 's1', text: '周五团建在西湖' }), [], HOUR_MS);
    store.insertMessage(message({ id: 's2', text: '天气不错' }), [], HOUR_MS);
    const found = store.searchMessages('g1', '团建', 10);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain('团建');
  });

  it('裁剪保留最近 N 条', () => {
    const base = Date.now();
    for (let i = 0; i < 10; i += 1) {
      store.insertMessage(message({ id: `k${i}`, timestamp: base + i * 1000 }), [], HOUR_MS);
    }
    const removed = store.pruneMessages('g1', 3, Date.now());
    expect(removed).toBe(7);
    expect(store.recentMessages('g1', 10)).toHaveLength(3);
    // 历史累计计数不因裁剪回退
    expect(store.listConversations()[0]?.message_count).toBe(10);
  });
});
