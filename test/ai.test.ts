import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmGateway, withRetry } from '../src/ai/llm.js';
import { Retriever } from '../src/ai/retriever.js';
import { Summarizer, planChunks } from '../src/ai/summarizer.js';
import { parseJudgment } from '../src/ai/index.js';
import { parseTimeRange, routeIntent, startOfWeek } from '../src/ai/router.js';
import { renderTranscript } from '../src/ai/prompts.js';
import { Store } from '../src/core/store.js';
import { HOUR_MS } from '../src/analytics/index.js';
import { message } from './helpers.js';
import { pino } from 'pino';

const silent = pino({ level: 'silent' });

/** 假的 OpenAI 兼容响应，避免测试依赖真实网络。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LlmGateway', () => {
  it('解析标准响应', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: 'test-model',
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    ) as unknown as typeof fetch;
    const gateway = new LlmGateway({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'test-model',
      timeoutMs: 5000,
      maxConcurrency: 2,
      logger: silent,
      fetchImpl,
    });
    const result = await gateway.chat([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('你好');
    expect(result.usage?.promptTokens).toBe(5);
  });

  it('4xx 不可重试，5xx 可重试', async () => {
    const make = (status: number) =>
      new LlmGateway({
        baseUrl: 'https://example.com/v1',
        apiKey: 'k',
        model: 'm',
        timeoutMs: 5000,
        maxConcurrency: 1,
        logger: silent,
        fetchImpl: (async () => jsonResponse({ error: 'x' }, status)) as unknown as typeof fetch,
      });
    await expect(make(400).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      status: 400,
      retriable: false,
    });
    await expect(make(503).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      status: 503,
      retriable: true,
    });
  });

  it('空内容视为错误', async () => {
    const gateway = new LlmGateway({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 5000,
      maxConcurrency: 1,
      logger: silent,
      fetchImpl: (async () => jsonResponse({ choices: [{ message: {} }] })) as unknown as typeof fetch,
    });
    await expect(gateway.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/空内容/);
  });

  it('解析 SSE 流并逐块回调', async () => {
    const chunks = [
      'data: {"model":"m","choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const gateway = new LlmGateway({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 5000,
      maxConcurrency: 1,
      logger: silent,
      fetchImpl: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    const result = await gateway.chat([{ role: 'user', content: 'x' }], {
      onDelta: (delta) => deltas.push(delta),
    });
    expect(result.content).toBe('你好');
    expect(deltas).toEqual(['你', '好']);
  });

  it('withRetry 只重试可重试错误', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw Object.assign(new Error('busy'), { retriable: true });
        return 'ok';
      },
      { retries: 3, baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });
});

describe('routeIntent', () => {
  it('识别统计意图', () => {
    expect(routeIntent('帮我统计一下本周消息量').intent).toBe('stats');
  });

  it('识别摘要意图', () => {
    expect(routeIntent('总结一下今天的讨论').intent).toBe('summary');
  });

  it('识别热力图意图', () => {
    expect(routeIntent('群活跃时段热力图').intent).toBe('heatmap');
  });

  it('识别排行意图', () => {
    expect(routeIntent('发言排行榜').intent).toBe('top');
  });

  it('识别问答意图（问号结尾）', () => {
    expect(routeIntent('周五团建几点开始？').intent).toBe('qa');
  });

  it('识别帮助意图', () => {
    expect(routeIntent('help').intent).toBe('help');
    expect(routeIntent('/help').intent).toBe('help');
  });

  it('无意义输入返回 unknown', () => {
    expect(routeIntent('嗯').intent).toBe('unknown');
    expect(routeIntent('').intent).toBe('unknown');
  });

  it('解析时间槽位', () => {
    const now = new Date('2026-01-07T12:00:00').getTime();
    const match = routeIntent('昨天聊了什么', now);
    expect(match.intent).toBe('summary');
    expect((match.slots.range as { label: string }).label).toBe('昨天');
  });

  it('解析 @ 目标', () => {
    const match = routeIntent(' @张三 的画像', Date.now());
    expect(match.slots.target).toBe('张三');
  });
});

describe('parseTimeRange', () => {
  const now = new Date('2026-01-07T12:00:00').getTime();

  it('识别今天与昨天', () => {
    expect(parseTimeRange('今天', now)?.label).toBe('今天');
    expect(parseTimeRange('昨天', now)?.label).toBe('昨天');
  });

  it('识别最近 N 小时/天', () => {
    expect(parseTimeRange('最近 3 小时', now)?.label).toBe('最近 3 小时');
    expect(parseTimeRange('最近两天', now)?.label).toBe('最近 2 天');
    expect(parseTimeRange('2天', now)?.label).toBe('最近 2 天');
  });

  it('本周起点是周一', () => {
    const week = startOfWeek(now);
    expect(new Date(week).getDay()).toBe(1);
  });

  it('无法识别时返回 null', () => {
    expect(parseTimeRange('随便聊聊', now)).toBeNull();
  });
});

describe('Retriever', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store({ path: ':memory:' });
    const now = Date.now();
    store.insertMessage(message({ id: 'r1', text: '周五团建地点定在西湖边', timestamp: now - 1000 }), [], HOUR_MS);
    store.insertMessage(message({ id: 'r2', text: '团建的预算每人 200 元', timestamp: now - 2000 }), [], HOUR_MS);
    store.insertMessage(message({ id: 'r3', text: '今天天气不错', timestamp: now - 3000 }), [], HOUR_MS);
  });

  it('按关键词检索并重排', () => {
    const retriever = new Retriever(store);
    const result = retriever.retrieve('g1', '团建地点', { limit: 5 });
    expect(result.chunks.length).toBeGreaterThan(0);
    // 同时含「团建」与「地点」的消息应排第一
    expect(result.chunks[0]?.message.id).toBe('r1');
    expect(result.chunks[0]?.matchedTerms).toContain('团建');
    expect(result.context).toContain('西湖');
  });

  it('无关查询不返回噪声', () => {
    const retriever = new Retriever(store);
    const result = retriever.retrieve('g1', '股票行情', { limit: 5 });
    expect(result.chunks).toHaveLength(0);
  });

  it('无可检索词时退化为最近消息', () => {
    const retriever = new Retriever(store);
    const result = retriever.retrieve('g1', '？？', { limit: 2 });
    expect(result.chunks).toHaveLength(2);
  });
});

describe('planChunks', () => {
  it('空输入返回空分段', () => {
    expect(planChunks([], 10, 5).segments).toEqual([]);
  });

  it('按窗口切分', () => {
    const rows = Array.from({ length: 25 }, (_, i) => message({ id: `c${i}` }));
    const plan = planChunks(rows, 10, 10);
    expect(plan.segments).toHaveLength(3);
    expect(plan.segments[0]).toHaveLength(10);
    expect(plan.segments[2]).toHaveLength(5);
  });

  it('超出上限时保留最近的消息', () => {
    const rows = Array.from({ length: 100 }, (_, i) => message({ id: `c${i}` }));
    const plan = planChunks(rows, 10, 3);
    expect(plan.segments).toHaveLength(3);
    // 保留最后 30 条：首段应从 c70 开始
    expect(plan.segments[0]?.[0]?.id).toBe('c70');
  });
});

describe('Summarizer', () => {
  function gatewayReturning(content: string): LlmGateway {
    return new LlmGateway({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 5000,
      maxConcurrency: 1,
      logger: silent,
      fetchImpl: (async () =>
        jsonResponse({ choices: [{ message: { content } }] })) as unknown as typeof fetch,
    });
  }

  it('单窗口直接摘要', async () => {
    const summarizer = new Summarizer(gatewayReturning('今天聊了团建安排'));
    const rows = [message({ id: 's1', text: '团建怎么安排' }), message({ id: 's2', text: '定在周五' })];
    const result = await summarizer.summarize(rows, { conversationName: '测试群', window: 10 });
    expect(result.segments).toBe(1);
    expect(result.summary).toContain('团建');
    expect(result.coveredMessages).toBe(2);
  });

  it('多窗口走归并路径', async () => {
    const summarizer = new Summarizer(gatewayReturning('分段要点'));
    const rows = Array.from({ length: 25 }, (_, i) => message({ id: `m${i}`, text: `内容${i}` }));
    const result = await summarizer.summarize(rows, { conversationName: '测试群', window: 10 });
    expect(result.segments).toBe(3);
    expect(result.summary).toBe('分段要点');
  });

  it('空消息返回明确说明而非调用模型', async () => {
    const fetchImpl = vi.fn();
    const summarizer = new Summarizer(
      new LlmGateway({
        baseUrl: 'https://example.com/v1',
        apiKey: 'k',
        model: 'm',
        timeoutMs: 5000,
        maxConcurrency: 1,
        logger: silent,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    const result = await summarizer.summarize([], { conversationName: '空的' });
    expect(result.coveredMessages).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('renderTranscript', () => {
  it('按时间升序渲染并保留发言者', () => {
    const rows = [
      message({ id: 't1', text: '第一句', timestamp: 1000, sender: { id: 'a', displayName: '甲' } }),
      message({ id: 't2', text: '第二句', timestamp: 2000, sender: { id: 'b', displayName: '乙' } }),
    ];
    const text = renderTranscript(rows);
    expect(text.indexOf('第一句')).toBeLessThan(text.indexOf('第二句'));
    expect(text).toContain('甲: 第一句');
  });

  it('超长时丢弃最旧内容', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      message({ id: `x${i}`, text: `内容${i}`, timestamp: 1000 + i }),
    );
    const text = renderTranscript(rows, { maxChars: 100 });
    expect(text).toContain('内容49');
    expect(text).not.toContain('内容0:');
  });
});

describe('parseJudgment', () => {
  it('解析裸 JSON', () => {
    const result = parseJudgment('{"violation":true,"category":"广告","severity":80,"reason":"导流"}');
    expect(result?.violation).toBe(true);
    expect(result?.severity).toBe(80);
  });

  it('解析代码块包裹的 JSON', () => {
    const result = parseJudgment('好的：\n```json\n{"violation":false,"category":"无","severity":0,"reason":""}\n```');
    expect(result?.violation).toBe(false);
  });

  it('无法解析时返回 null', () => {
    expect(parseJudgment('我觉得没问题')).toBeNull();
  });

  it('severity 越界被裁剪', () => {
    expect(parseJudgment('{"violation":true,"severity":999}')?.severity).toBe(100);
    expect(parseJudgment('{"violation":true,"severity":-5}')?.severity).toBe(0);
  });
});
