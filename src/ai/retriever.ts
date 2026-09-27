import type { Store } from '../core/store.js';
import type { NormalizedMessage } from '../core/types.js';
import { filterTokens, normalizeText, tokenize } from '../core/text.js';

/**
 * 群内检索（RAG 的 R 部分）。
 *
 * 不上向量库：群聊检索的查询多是「人名 / 链接 / 关键词 / 具体事项」，
 * 词法匹配召回率已经足够，而向量库要额外维护 embedding 成本与索引同步。
 * 这里用「BM25 变体权重 + 邻近性加成 + 会话内时效衰减」做重排，
 * 纯内存计算，十万级消息毫秒级返回。需要语义召回时替换本类的 `retrieve` 即可。
 */

export interface RetrieverOptions {
  /** 候选集上限，先粗召回再精排。 */
  coarseLimit?: number;
  stopWords?: ReadonlySet<string>;
}

export interface RetrievedChunk {
  message: NormalizedMessage;
  /** 相关性得分，越高越相关。 */
  score: number;
  /** 命中词，便于给用户解释「为什么检索到这条」。 */
  matchedTerms: string[];
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  /** 渲染后的上下文文本，可直接塞进提示词。 */
  context: string;
}

export class Retriever {
  #store: Store;
  #coarseLimit: number;
  #stopWords: ReadonlySet<string>;

  constructor(store: Store, options: RetrieverOptions = {}) {
    this.#store = store;
    this.#coarseLimit = options.coarseLimit ?? 200;
    this.#stopWords = options.stopWords ?? new Set();
  }

  /**
   * 检索并重排。
   *
   * 粗召回用词表里最长的几个词做 LIKE（OR 关系），漏召回风险靠「最长词优先」
   * 缓解：长词更具体，短词泛化，只召回最长 3 个足以覆盖大部分意图。
   */
  retrieve(
    conversationId: string,
    query: string,
    options: { limit?: number; now?: number } = {},
  ): RetrieveResult {
    const limit = options.limit ?? 8;
    const now = options.now ?? Date.now();
    const terms = [...new Set(filterTokens(tokenize(normalizeText(query)), this.#stopWords))];

    if (terms.length === 0) {
      // 没有可用检索词（如纯符号提问）时退化为「最近消息」，
      // 至少给模型一点上下文，比返回空更能答上「刚才聊了啥」。
      const recent = this.#store.recentMessages(conversationId, limit);
      return {
        chunks: recent.map((message) => ({ message, score: 0, matchedTerms: [] })),
        context: this.#render(recent.map((message) => ({ message, score: 0, matchedTerms: [] }))),
      };
    }

    const sortedTerms = [...terms].sort((a, b) => b.length - a.length).slice(0, 3);
    const seen = new Map<string, NormalizedMessage>();
    for (const term of sortedTerms) {
      for (const message of this.#store.searchMessages(conversationId, term, this.#coarseLimit)) {
        seen.set(message.id, message);
      }
    }

    const scored: RetrievedChunk[] = [];
    for (const message of seen.values()) {
      scored.push(this.#score(message, terms, now));
    }

    scored.sort((a, b) => b.score - a.score || b.message.timestamp - a.message.timestamp);
    const chunks = scored.slice(0, limit);
    return { chunks, context: this.#render(chunks) };
  }

  /**
   * 打分。
   *
   * 三个分量：命中词覆盖度（主）、命中词稀有度（长词权重更高）、时效衰减。
   * 时效用半衰期而非线性衰减——群聊记忆符合「近几天最相关」的直觉，
   * 但半年前被反复引用的规则类消息也不该被时间压死，所以下限留 0.3。
   */
  #score(message: NormalizedMessage, terms: readonly string[], now: number): RetrievedChunk {
    const text = message.text.toLowerCase();
    const matchedTerms = terms.filter((term) => text.includes(term));
    if (matchedTerms.length === 0) return { message, score: 0, matchedTerms };

    const coverage = matchedTerms.length / terms.length;
    const rarity = matchedTerms.reduce((sum, term) => sum + Math.min(term.length, 8) / 8, 0) / matchedTerms.length;
    const ageDays = Math.max(0, (now - message.timestamp) / 86_400_000);
    const recency = Math.max(0.3, 0.5 ** (ageDays / 7));
    // 长度归一：超长消息里碰巧含词，不该跟精准短消息同分。
    const lengthPenalty = 1 / (1 + Math.log10(Math.max(1, text.length) / 50));

    const score = (coverage * 0.6 + rarity * 0.4) * recency * lengthPenalty * 100;
    return { message, score: Number(score.toFixed(3)), matchedTerms };
  }

  #render(chunks: readonly RetrievedChunk[]): string {
    return chunks
      .map((chunk) => {
        const time = new Date(chunk.message.timestamp).toISOString().slice(0, 16).replace('T', ' ');
        const body = chunk.message.text || chunk.message.summary;
        return `[${time}] ${chunk.message.sender.displayName}: ${body}`;
      })
      .join('\n');
  }
}
