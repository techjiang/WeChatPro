import type { Logger } from 'pino';
import type { AppConfig } from '../core/config.js';
import type { Store } from '../core/store.js';
import type { NormalizedMessage } from '../core/types.js';
import { LlmGateway } from './llm.js';
import { Retriever } from './retriever.js';
import { Summarizer } from './summarizer.js';
import { routeIntent, type IntentMatch } from './router.js';
import { SYSTEM_ASSISTANT, moderationPrompt } from './prompts.js';

/**
 * AI 能力门面。
 *
 * 把网关、检索、摘要、路由、审核拼成上层可直接调用的用例方法。
 * 这样 API 层与插件层不必各自组装依赖，也保证「同样的提问走到同样的流程」。
 */

export interface AiServiceOptions {
  config: AppConfig;
  store: Store;
  logger: Logger;
  /** 测试注入自定义网关。 */
  gateway?: LlmGateway;
}

export interface AiAnswer {
  answer: string;
  /** 检索到的证据条数，0 表示模型无据可依。 */
  evidenceCount: number;
}

export interface ModerationJudgment {
  violation: boolean;
  category: string;
  severity: number;
  reason: string;
}

export class AiService {
  readonly gateway: LlmGateway;
  readonly retriever: Retriever;
  readonly summarizer: Summarizer;
  #store: Store;
  #logger: Logger;
  #enabled: boolean;
  #config: AppConfig;

  constructor(options: AiServiceOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#enabled = options.config.ai.enabled;
    this.gateway =
      options.gateway ??
      new LlmGateway({
        baseUrl: options.config.ai.baseUrl,
        apiKey: options.config.ai.apiKey,
        model: options.config.ai.model,
        timeoutMs: options.config.ai.timeoutMs,
        maxConcurrency: options.config.ai.maxConcurrency,
        logger: options.logger,
      });
    this.retriever = new Retriever(options.store, {
      stopWords: new Set(options.config.analytics.stopWords),
    });
    this.summarizer = new Summarizer(this.gateway);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get model(): string {
    return this.#config.ai.model;
  }

  /** 生成群聊摘要。关闭 AI 时退化为「统计摘要」，保证功能永远有输出。 */
  async summarize(
    conversationId: string,
    options: { range?: { from: number; to: number }; focus?: string; limit?: number } = {},
  ): Promise<{ summary: string; degraded: boolean; coveredMessages: number }> {
    const conversation = this.#store.getConversation(conversationId);
    const limit = options.limit ?? this.#config.ai.summaryWindow;
    const messages = this.#store.recentMessages(conversationId, limit);
    if (!this.#enabled) {
      return { summary: fallbackSummary(messages), degraded: true, coveredMessages: messages.length };
    }

    try {
      const result = await this.summarizer.summarize(messages, {
        conversationName: conversation?.name ?? conversationId,
        focus: options.focus,
        window: limit,
      });
      return { summary: result.summary, degraded: false, coveredMessages: result.coveredMessages };
    } catch (error) {
      // AI 不可用不能让「今日摘要」这类例行任务整体失败，退化为统计口径摘要。
      this.#logger.warn({ err: error, conversationId }, 'AI 摘要失败，退化为统计摘要');
      return { summary: fallbackSummary(messages), degraded: true, coveredMessages: messages.length };
    }
  }

  /** 群内问答：先检索，再约束作答。 */
  async ask(conversationId: string, question: string, contextLimit = 8): Promise<AiAnswer | null> {
    if (!this.#enabled) return null;
    const conversation = this.#store.getConversation(conversationId);
    const { chunks, context } = this.retriever.retrieve(conversationId, question, { limit: contextLimit });
    const result = await this.summarizer.answer(
      question,
      context,
      conversation?.name ?? conversationId,
    );
    return { answer: result.answer, evidenceCount: chunks.length };
  }

  /** 语义审核，作为规则引擎的补充——规则查「词」，这里查「意思」。 */
  async moderate(message: NormalizedMessage, policy: string): Promise<ModerationJudgment | null> {
    if (!this.#enabled) return null;
    const result = await this.gateway.chat(
      [
        { role: 'system', content: SYSTEM_ASSISTANT },
        { role: 'user', content: moderationPrompt(message, policy) },
      ],
      { temperature: 0, maxTokens: 200 },
    );
    return parseJudgment(result.content);
  }

  /** 指令路由，供插件在收到 @ 消息时调用。 */
  route(input: string, now = Date.now()): IntentMatch {
    return routeIntent(input, now);
  }
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 模型常把 JSON 包在 ```json 代码块里，或在前后加一句话；这里做宽容解析，
 * 失败返回 `null` 让调用方按「AI 不给结论」处理，而不是抛错中断整条链路。
 */
export function parseJudgment(content: string): ModerationJudgment | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? content).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as Partial<ModerationJudgment>;
    return {
      violation: Boolean(parsed.violation),
      category: typeof parsed.category === 'string' ? parsed.category : '无',
      severity: typeof parsed.severity === 'number' ? clamp(parsed.severity, 0, 100) : 0,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 无 AI 时的兜底摘要：用可计算的口径描述活跃情况，不编造语义内容。 */
function fallbackSummary(messages: readonly NormalizedMessage[]): string {
  if (messages.length === 0) return '该时间段内没有消息。';
  const senders = new Map<string, number>();
  const kinds = new Map<string, number>();
  for (const message of messages) {
    senders.set(message.sender.displayName, (senders.get(message.sender.displayName) ?? 0) + 1);
    kinds.set(message.kind, (kinds.get(message.kind) ?? 0) + 1);
  }
  const topSenders = [...senders.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `${name}(${count})`)
    .join('、');
  const kindText = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}:${count}`)
    .join('，');

  return [
    `共 ${messages.length} 条消息，${senders.size} 人参与。`,
    `发言最多：${topSenders}。`,
    `类型分布：${kindText}。`,
    '（AI 未启用，以上为统计口径摘要）',
  ].join('\n');
}

export { LlmGateway } from './llm.js';
export { Retriever } from './retriever.js';
export { Summarizer } from './summarizer.js';
export { routeIntent, parseTimeRange, startOfDay, startOfWeek, startOfMonth } from './router.js';
export type { IntentMatch, IntentName } from './router.js';
export { renderTranscript, formatClock } from './prompts.js';
