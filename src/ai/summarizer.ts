import type { LlmGateway } from './llm.js';
import type { NormalizedMessage } from '../core/types.js';
import { SYSTEM_ASSISTANT, SUMMARY_SYSTEM, qaPrompt, renderTranscript, summaryPrompt } from './prompts.js';

/**
 * 群聊摘要与问答。
 *
 * 长群聊不能只靠「截断最近 N 条」——话题会被腰斩。这里用「分段摘要 + 归并」：
 * 先按窗口切段各产出要点，再让模型把要点归并成最终摘要。单次请求的上下文
 * 可控，且窗口大小可随模型上下文长度调参。
 */

export interface SummarizeOptions {
  conversationName: string;
  /** 关注点，如「有没有人提到团建」。 */
  focus?: string;
  /** 单次请求容纳的消息条数。 */
  window?: number;
  /** 每段的局部摘要最大字数，控制归并阶段的输入量。 */
  segmentChars?: number;
}

export interface SummaryResult {
  summary: string;
  /** 本次摘要覆盖的消息条数。 */
  coveredMessages: number;
  /** 分段数，>1 说明走了归并路径。 */
  segments: number;
}

export interface ChunkPlan {
  segments: NormalizedMessage[][];
  window: number;
}

/**
 * 规划分段。
 *
 * 抽取成纯函数是为了可测：分段策略一变，摘要质量与成本都跟着变，
 * 必须有测试钉住边界（空输入、恰好整除、超出上限）。
 */
export function planChunks(
  messages: readonly NormalizedMessage[],
  window: number,
  maxSegments: number,
): ChunkPlan {
  const size = Math.max(1, Math.floor(window));
  if (messages.length === 0) return { segments: [], window: size };

  // 超长记录只保留最近的部分：越久远的内容对「今天聊了什么」越不重要。
  const maxMessages = size * maxSegments;
  const slice = messages.length > maxMessages ? messages.slice(messages.length - maxMessages) : messages;

  const segments: NormalizedMessage[][] = [];
  for (let i = 0; i < slice.length; i += size) {
    segments.push(slice.slice(i, i + size));
  }
  return { segments, window: size };
}

export class Summarizer {
  #llm: LlmGateway;
  #maxSegments: number;

  constructor(llm: LlmGateway, maxSegments = 8) {
    this.#llm = llm;
    this.#maxSegments = maxSegments;
  }

  async summarize(
    messages: readonly NormalizedMessage[],
    options: SummarizeOptions,
  ): Promise<SummaryResult> {
    if (messages.length === 0) {
      return { summary: '该时间段内没有可摘要的消息。', coveredMessages: 0, segments: 0 };
    }

    const { segments } = planChunks(messages, options.window ?? 200, this.#maxSegments);
    const covered = segments.reduce((sum, segment) => sum + segment.length, 0);

    if (segments.length === 1) {
      const transcript = renderTranscript(segments[0] as NormalizedMessage[], {
        maxChars: options.segmentChars ? options.segmentChars * 20 : 12_000,
      });
      const result = await this.#llm.chat(
        [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: summaryPrompt(options.conversationName, transcript, options.focus) },
        ],
        { temperature: 0.2, maxTokens: 1200 },
      );
      return { summary: result.content.trim(), coveredMessages: covered, segments: 1 };
    }

    const partials: string[] = [];
    for (const segment of segments) {
      const transcript = renderTranscript(segment);
      // 分段摘要并发上限由网关信号量控制，这里串行避免打乱时间顺序导致归并错乱。
      const result = await this.#llm.chat(
        [
          { role: 'system', content: SUMMARY_SYSTEM },
          {
            role: 'user',
            content: [
              `这是「${options.conversationName}」聊天记录的第 ${partials.length + 1}/${segments.length} 段。`,
              transcript,
              '',
              '请用不超过 200 字总结该段的要点，保留时间线索与待办。',
            ].join('\n'),
          },
        ],
        { temperature: 0.2, maxTokens: 400 },
      );
      partials.push(`【第 ${partials.length + 1} 段】${result.content.trim()}`);
    }

    const merged = await this.#llm.chat(
      [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: summaryPrompt(options.conversationName, partials.join('\n\n'), options.focus),
        },
      ],
      { temperature: 0.2, maxTokens: 1200 },
    );

    return { summary: merged.content.trim(), coveredMessages: covered, segments: segments.length };
  }

  /** 基于检索结果回答问题。调用方负责检索，这里只管「约束在证据内作答」。 */
  async answer(
    question: string,
    context: string,
    conversationName = '群聊',
  ): Promise<{ answer: string }> {
    const result = await this.#llm.chat(
      [
        { role: 'system', content: SYSTEM_ASSISTANT },
        { role: 'user', content: qaPrompt(conversationName, context, question) },
      ],
      { temperature: 0.1, maxTokens: 800 },
    );
    return { answer: result.content.trim() };
  }
}
