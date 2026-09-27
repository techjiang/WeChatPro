import { beforeEach, describe, expect, it } from 'vitest';
import { GuardEngine, builtinRules, createRules, toRuleConfigMap } from '../src/guard/index.js';
import { parseConfig } from '../src/core/config.js';
import { burst, message } from './helpers.js';

function makeEngine(overrides: Record<string, unknown> = {}): GuardEngine {
  const config = parseConfig({
    logLevel: 'silent',
    guard: {
      enabled: true,
      alertThreshold: 30,
      windowMs: 10 * 60_000,
      rules: [],
      ...overrides,
    },
  });
  return new GuardEngine({
    rules: createRules(config.guard.rules),
    ruleConfigs: toRuleConfigMap(config.guard.rules),
    alertThreshold: config.guard.alertThreshold,
    windowMs: config.guard.windowMs,
  });
}

describe('GuardEngine', () => {
  let engine: GuardEngine;

  beforeEach(() => {
    engine = makeEngine();
  });

  it('默认规则全部启用', () => {
    expect(engine.activeRules().length).toBe(builtinRules.length);
  });

  it('命中敏感词', () => {
    const custom = makeEngine({
      rules: [{ id: 'keyword-blocklist', enabled: true, weight: 40, options: { words: ['刷单'] } }],
    });
    const alerts = custom.evaluate(message({ text: '招人刷单日结' }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.ruleId).toBe('keyword-blocklist');
    expect(alerts[0]?.reason).toContain('刷单');
    expect(alerts[0]?.riskScore).toBe(40);
    expect(alerts[0]?.breached).toBe(true);
  });

  it('未命中时无告警', () => {
    const custom = makeEngine({
      rules: [{ id: 'keyword-blocklist', enabled: true, options: { words: ['刷单'] } }],
    });
    expect(custom.evaluate(message({ text: '今天天气不错' }))).toHaveLength(0);
  });

  it('链接刷屏达到阈值才告警', () => {
    const now = Date.now();
    const custom = makeEngine({
      rules: [{ id: 'link-flood', enabled: true, options: { windowMs: 300_000, threshold: 3 } }],
    });
    const links = burst(4, { senderId: 'ads', text: 'https://spam.example.com', startAt: now });
    const results = links.flatMap((item, index) =>
      custom.evaluate({ ...item, kind: 'link' as const, timestamp: now + index * 1000 }, now + index * 1000),
    );
    // 窗口内已发 3 条才越阈值，故第一条 1 条、第二条起各命中一次
    expect(results.filter((a) => a.ruleId === 'link-flood')).toHaveLength(1);
    // 校验阈值语义：再来一条必然命中
    const t = now + 5000;
    expect(
      custom.evaluate({ ...(links[0] as any), id: 'extra', kind: 'link', timestamp: t }, t).some(
        (a) => a.ruleId === 'link-flood',
      ),
    ).toBe(true);
  });

  it('刷屏检测按发送者独立计算', () => {
    const now = Date.now();
    const custom = makeEngine({
      rules: [{ id: 'burst-spam', enabled: true, options: { windowMs: 60_000, threshold: 5 } }],
    });
    const rows = burst(6, { senderId: 'fast', startAt: now });
    const alerts = rows.flatMap((item, index) =>
      custom.evaluate({ ...item, timestamp: now + index * 100 }, now + index * 100),
    );
    const spam = alerts.filter((a) => a.ruleId === 'burst-spam');
    expect(spam.length).toBeGreaterThan(0);
    // 窗口内其他成员不应被牵连
    const other = custom.evaluate(
      message({ sender: { id: 'quiet', displayName: '潜水员' }, timestamp: now + 10_000 }),
      now + 10_000,
    );
    expect(other.filter((a) => a.ruleId === 'burst-spam')).toHaveLength(0);
  });

  it('重复内容达到阈值告警', () => {
    const now = Date.now();
    const custom = makeEngine({
      rules: [{ id: 'duplicate-content', enabled: true, options: { windowMs: 600_000, threshold: 3 } }],
    });
    const rows = burst(4, { senderId: 'repeat', text: '同样的内容', startAt: now });
    const alerts = rows.flatMap((item, index) =>
      custom.evaluate({ ...item, timestamp: now + index * 1000 }, now + index * 1000),
    );
    expect(alerts.filter((a) => a.ruleId === 'duplicate-content').length).toBeGreaterThan(0);
  });

  it('静默时段跨零点判断正确', () => {
    const custom = makeEngine({
      rules: [{ id: 'silent-hours', enabled: true, options: { startHour: 23, endHour: 6, minChars: 1 } }],
    });
    const night = new Date('2026-01-05T02:00:00').getTime();
    const noon = new Date('2026-01-05T12:00:00').getTime();
    expect(custom.evaluate(message({ text: '深夜发言', timestamp: night }), night)).toHaveLength(1);
    expect(custom.evaluate(message({ text: '白天发言', timestamp: noon }), noon)).toHaveLength(0);
  });

  it('@ 轰炸规则按提及人数判定', () => {
    const custom = makeEngine({
      rules: [{ id: 'mention-storm', enabled: true, options: { threshold: 3 } }],
    });
    const alerts = custom.evaluate(message({ text: '@所有人', mentions: ['a', 'b', 'c', 'd'] }));
    expect(alerts.some((a) => a.ruleId === 'mention-storm')).toBe(true);
  });

  it('导流话术命中', () => {
    const alerts = engine.evaluate(message({ text: '需要的话私聊我，扫码进群' }));
    expect(alerts.some((a) => a.ruleId === 'contact-solicitation')).toBe(true);
  });

  it('媒体刷屏按媒体类消息计数', () => {
    const now = Date.now();
    const custom = makeEngine({
      rules: [{ id: 'media-flood', enabled: true, options: { windowMs: 180_000, threshold: 3 } }],
    });
    const rows = burst(4, { senderId: 'media', startAt: now });
    const alerts = rows.flatMap((item, index) =>
      custom.evaluate(
        { ...item, kind: 'image' as const, text: '', timestamp: now + index * 1000 },
        now + index * 1000,
      ),
    );
    expect(alerts.filter((a) => a.ruleId === 'media-flood').length).toBeGreaterThan(0);
  });

  it('可禁用单条规则', () => {
    const custom = makeEngine({
      rules: [{ id: 'contact-solicitation', enabled: false, weight: 35 }],
    });
    expect(custom.evaluate(message({ text: '私聊我' })).some((a) => a.ruleId === 'contact-solicitation')).toBe(false);
  });

  it('自定义词表规则可生效', () => {
    const custom = makeEngine({
      rules: [{ id: 'my-blocklist', description: '内部黑话', weight: 20, options: { words: ['黑话'] } }],
    });
    const alerts = custom.evaluate(message({ text: '这是黑话' }));
    expect(alerts.some((a) => a.ruleId === 'my-blocklist')).toBe(true);
  });

  it('reset 清空窗口', () => {
    const now = Date.now();
    const custom = makeEngine({
      rules: [{ id: 'burst-spam', enabled: true, options: { windowMs: 60_000, threshold: 3 } }],
    });
    for (const item of burst(5, { senderId: 'x', startAt: now })) custom.evaluate(item, now);
    custom.reset('g1');
    expect(custom.evaluate(message({ sender: { id: 'x', displayName: 'x' }, timestamp: now }), now)).toHaveLength(0);
  });

  it('自定义规则执行异常不会中断整条链路', () => {
    const broken = new GuardEngine({
      rules: [
        {
          id: 'broken',
          description: '总是抛错',
          action: 'alert',
          defaultWeight: 10,
          evaluate() {
            throw new Error('boom');
          },
        },
      ],
      ruleConfigs: new Map(),
      alertThreshold: 30,
      windowMs: 60_000,
    });
    const alerts = broken.evaluate(message({ text: 'hi' }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.weight).toBe(0);
    expect(alerts[0]?.reason).toContain('boom');
  });
});
