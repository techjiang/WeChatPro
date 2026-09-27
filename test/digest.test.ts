import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/core/store.js';
import { HOUR_MS, DAY_MS } from '../src/analytics/index.js';
import { buildDigest, formatDay, previousDayWindow } from '../src/analytics/digest.js';
import { Scheduler, createDigestJob } from '../src/runtime/scheduler.js';
import { pino } from 'pino';
import type { NormalizedMessage } from '../src/core/types.js';

/**
 * 日报与调度。
 *
 * 这两块是「没人盯着就出问题」的典型：日报挂了只是某天早上不来，
 * 调度器挂了则完全静默。所以测试重点不在「正常路径能不能跑」，
 * 而在**边界**：区间算错、空群刷屏、失败不记账、非法 cron 让进程起不来。
 */

const logger = pino({ level: 'silent' });

function msg(partial: Partial<NormalizedMessage> & { id: string; timestamp: number }): NormalizedMessage {
  const text = partial.text ?? '项目进度同步';
  return {
    id: partial.id,
    conversation: partial.conversation ?? { id: 'g1', kind: 'group', name: '产品群' },
    sender: partial.sender ?? { id: 'u1', displayName: '张工' },
    kind: partial.kind ?? 'text',
    direction: 'inbound',
    timestamp: partial.timestamp,
    text,
    summary: text.slice(0, 80),
    mentions: [],
  };
}

function seededStore(now = Date.now()): Store {
  const store = new Store({ path: ':memory:' });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const yesterday = startOfToday.getTime() - DAY_MS;
  const rows: NormalizedMessage[] = [
    msg({ id: 'y1', timestamp: yesterday + HOUR_MS }),
    msg({ id: 'y2', timestamp: yesterday + 2 * HOUR_MS, sender: { id: 'u2', displayName: '李设计' } }),
    msg({ id: 't1', timestamp: now }),
  ];
  for (const row of rows) store.insertMessage(row, ['项目'], HOUR_MS);
  store.insertEvent({
    conversation_id: 'g1',
    member_id: 'u1',
    type: 'guard',
    severity: 'medium',
    score: 40,
    detail: JSON.stringify({ ruleId: 'keyword-blocklist', reason: '命中敏感词: 刷单' }),
    ts: yesterday + HOUR_MS,
  });
  return store;
}

describe('日报区间', () => {
  it('覆盖「昨天」而不是「最近 24 小时」', () => {
    const now = new Date('2026-09-27T09:00:00').getTime();
    const window = previousDayWindow(now);
    expect(new Date(window.range.from).getDate()).toBe(26);
    expect(new Date(window.range.to).getDate()).toBe(27);
    expect(new Date(window.range.from).getHours()).toBe(0);
    expect(window.label).toBe('2026-09-26');
  });

  it('凌晨触发时仍然算「昨天」，不会退化成空白区间', () => {
    const now = new Date('2026-09-27T00:05:00').getTime();
    const window = previousDayWindow(now);
    expect(window.label).toBe('2026-09-26');
    expect(window.range.to - window.range.from).toBe(DAY_MS);
  });

  it('formatDay 用本地时区而不是 UTC', () => {
    // 本地时间 00:30 在任何时区都应是「当天」，用 toISOString 会变成前一天。
    const ts = new Date('2026-01-02T00:30:00').getTime();
    expect(formatDay(ts)).toBe('2026-01-02');
  });
});

describe('日报内容', () => {
  it('只覆盖区间内的消息，不含今天与更早', () => {
    const now = new Date('2026-09-27T09:00:00').getTime();
    const store = seededStore(now);
    const report = buildDigest(store, 'g1', previousDayWindow(now));
    store.close();

    expect(report?.totalMessages).toBe(2);
    expect(report?.text).toContain('张工');
    expect(report?.text).toContain('李设计');
    expect(report?.text).not.toContain('今天');
  });

  it('含发言排行、类型分布与风控摘要', () => {
    const now = new Date('2026-09-27T09:00:00').getTime();
    const store = seededStore(now);
    const report = buildDigest(store, 'g1', previousDayWindow(now));
    store.close();

    expect(report?.text).toContain('发言排行');
    expect(report?.text).toContain('类型分布');
    expect(report?.text).toContain('keyword-blocklist');
    expect(report?.text).toContain('日报');
  });

  it('无消息的群默认不产出正文（避免每天推一堆空日报）', () => {
    const store = new Store({ path: ':memory:' });
    const now = new Date('2026-09-27T09:00:00').getTime();
    // 只有今天的消息：昨天为空。
    store.insertMessage(msg({ id: 'a', timestamp: now }), [], HOUR_MS);

    const quiet = buildDigest(store, 'g1', previousDayWindow(now));
    const explicit = buildDigest(store, 'g1', previousDayWindow(now), { includeEmpty: true });
    store.close();

    expect(quiet?.totalMessages).toBe(0);
    expect(quiet?.text).toBe('');
    expect(explicit?.text).toContain('昨日无消息');
  });

  it('未知会话返回 null 而不是抛错', () => {
    const store = new Store({ path: ':memory:' });
    expect(buildDigest(store, 'nope', previousDayWindow())).toBeNull();
    store.close();
  });

  it('详情不是合法 JSON 时退化为事件类型，不影响日报生成', () => {
    const now = new Date('2026-09-27T09:00:00').getTime();
    const store = seededStore(now);
    store.insertEvent({
      conversation_id: 'g1',
      member_id: 'u1',
      type: 'guard',
      severity: 'low',
      score: 10,
      detail: '不是 JSON',
      ts: now - DAY_MS + HOUR_MS,
    });
    const report = buildDigest(store, 'g1', previousDayWindow(now));
    store.close();
    expect(report?.text).toContain('风控事件');
  });
});

describe('日报调度任务', () => {
  it('只推有消息的群，空群计入 skipped', async () => {
    const now = new Date('2026-09-27T09:00:00').getTime();
    const store = seededStore(now);
    // 第二个群只有今天的消息 → 昨天为空
    store.insertMessage(
      msg({ id: 'g2-1', timestamp: now, conversation: { id: 'g2', kind: 'group', name: '空群' } }),
      [],
      HOUR_MS,
    );

    const sent: Array<{ id: string; text: string }> = [];
    const { runOnce } = createDigestJob({
      store,
      logger,
      expression: '0 9 * * *',
      conversationIds: () => ['g1', 'g2'],
      send: async (conversationId, text) => {
        sent.push({ id: conversationId, text });
        return true;
      },
      window: () => previousDayWindow(now),
    });

    const result = await runOnce(now);
    store.close();

    expect(result).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
    expect(sent.map((item) => item.id)).toEqual(['g1']);
  });

  it('单个群发送失败不影响其他群，并计入 failed', async () => {
    const now = new Date('2026-09-27T09:00:00').getTime();
    const store = seededStore(now);

    const attempts: string[] = [];
    const { runOnce } = createDigestJob({
      store,
      logger,
      expression: '0 9 * * *',
      conversationIds: () => ['g1'],
      send: async (id) => {
        attempts.push(id);
        throw new Error('发送通道炸了');
      },
      window: () => previousDayWindow(now),
    });

    const result = await runOnce(now);
    store.close();

    expect(attempts).toEqual(['g1']);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
  });

  it('没有任何会话时不报错', async () => {
    const store = new Store({ path: ':memory:' });
    const { runOnce } = createDigestJob({
      store,
      logger,
      expression: '0 9 * * *',
      conversationIds: () => [],
      send: async () => true,
    });
    await expect(runOnce()).resolves.toMatchObject({ sent: 0, skipped: 0 });
    store.close();
  });
});

describe('Scheduler', () => {
  it('非法 cron 表达式被跳过而不是让进程起不来', () => {
    const scheduler = new Scheduler(logger);
    expect(scheduler.add({ name: 'bad', expression: '不是 cron', run: () => {} })).toBe(false);
    expect(scheduler.add({ name: 'good', expression: '0 9 * * *', run: () => {} })).toBe(true);
    expect(scheduler.status().map((item) => item.name)).toEqual(['good']);
    scheduler.stop();
  });

  it('记账执行次数、耗时与失败原因', async () => {
    const scheduler = new Scheduler(logger);
    let calls = 0;
    scheduler.add({
      name: 'job',
      expression: '0 9 * * *',
      run: () => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
      },
    });

    const status = scheduler.status()[0];
    await scheduler.runNow('job', { name: 'job', expression: '0 9 * * *', run: () => void 0 });
    await scheduler.runNow('job', {
      name: 'job',
      expression: '0 9 * * *',
      run: () => {
        throw new Error('boom');
      },
    });

    expect(status?.runs).toBe(1);
    expect(status?.failures).toBe(1);
    expect(status?.lastError).toBe('boom');
    expect(status?.lastDurationMs).not.toBeNull();
    scheduler.stop();
  });

  it('上一次未跑完时跳过本次触发，不叠加执行', async () => {
    const scheduler = new Scheduler(logger);
    let running = 0;
    let maxConcurrent = 0;
    let finished = 0;

    const job = {
      name: 'slow',
      expression: '0 9 * * *',
      run: async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((resolve) => setTimeout(resolve, 60));
        running -= 1;
        finished += 1;
      },
    };

    await Promise.all([scheduler.runNow('slow', job), scheduler.runNow('slow', job), scheduler.runNow('slow', job)]);
    expect(maxConcurrent).toBe(1);
    expect(finished).toBe(1);
    scheduler.stop();
  });

  it('stop() 幂等，重复调用不抛错', () => {
    const scheduler = new Scheduler(logger);
    scheduler.add({ name: 'j', expression: '0 9 * * *', run: () => {} });
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
  });
});

describe('日报接入引擎（端到端）', () => {
  it('有发送通道时把日报发到群里，内容含真实统计数字', async () => {
    const { bootstrap } = await import('../src/runtime/bootstrap.js');
    const { testConfig } = await import('./helpers.js');
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    yesterday.setHours(10, 0, 0, 0);

    const config = testConfig({
      api: { enabled: false },
      storage: { sqlitePath: ':memory:' },
      adapters: [{ protocol: 'mock', options: { intervalMs: 1000, script: [] } }],
      plugins: [{ name: 'analytics', enabled: true, options: {} }],
    });

    const { engine, start, stop } = await bootstrap({ config });
    const sent: string[] = [];
    engine.sendMessage = async (_id: string, text: string) => {
      sent.push(text);
      return true;
    };

    engine.store.insertMessage(
      msg({
        id: 'y1',
        timestamp: yesterday.getTime(),
        conversation: { id: 'g1', kind: 'group', name: '日报群' },
      }),
      ['项目'],
      HOUR_MS,
    );

    await start();
    const scheduler = new Scheduler(logger);
    const { job, runOnce } = createDigestJob({
      store: engine.store,
      logger,
      expression: '0 9 * * *',
      conversationIds: () => ['g1'],
      send: (conversationId, text) => engine.sendMessage(conversationId, text),
      window: () => previousDayWindow(now.getTime()),
    });
    scheduler.add(job);

    const result = await runOnce(now.getTime());
    await stop();

    expect(result.sent).toBe(1);
    expect(sent[0]).toContain('日报群');
    expect(sent[0]).toContain('总消息 1 条');
    scheduler.stop();
  });
});
