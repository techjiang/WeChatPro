/**
 * 中文友好的轻量分词。
 *
 * 为什么不引 jieba/segment：群聊统计要的是「高频词与话题倾向」，不是精确分词；
 * 引入词典型分词会带来几 MB 词典、额外原生依赖，还会因词典缺新词（梗、缩写）
 * 反而不如字级 n-gram。这里用「CJK 按 2-gram + 拉丁按词」的混合策略，
 * 兼顾口径稳定与零依赖。
 */

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const LATIN_WORD = /[a-z0-9][a-z0-9+#'-]*/gi;
const URL = /\bhttps?:\/\/\S+/gi;

/**
 * 抽取可用作统计的 token。
 *
 * 拉丁词统一小写；CJK 连续串切 2-gram，长度为 1 的残片（如单字句）保留原字。
 * 纯地址、纯表情符号不参与统计，否则 `[图片]` 之类的占位符会霸榜。
 */
export function tokenize(input: string): string[] {
  if (!input) return [];
  const text = input.replace(URL, ' ');
  const tokens: string[] = [];
  const cjkBuffer: string[] = [];

  const flushCjk = (): void => {
    if (cjkBuffer.length === 0) return;
    const run = cjkBuffer.join('');
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
    }
    cjkBuffer.length = 0;
  };

  for (const char of text) {
    if (CJK.test(char)) {
      cjkBuffer.push(char);
      continue;
    }
    flushCjk();
  }
  flushCjk();

  for (const match of text.matchAll(LATIN_WORD)) {
    const word = match[0].toLowerCase();
    if (word.length >= 2) tokens.push(word);
  }

  return tokens;
}

/** 统计用文本清洗：去掉 @、去掉零宽字符，避免污染词频。 */
export function normalizeText(input: string): string {
  return input
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/@[^\s@]+/g, ' ')
    .trim();
}

/** 从词表里过滤停用词与过短 token。 */
export function filterTokens(tokens: readonly string[], stopWords: ReadonlySet<string>): string[] {
  return tokens.filter((token) => token.length >= 2 && !stopWords.has(token) && !/^\d+$/.test(token));
}

/**
 * 归一化到消息文本的「可读摘要」。
 *
 * 落库时写摘要而非原始负载：原始负载字段随协议漂移，写进库会让报表口径跟着变。
 */
export function summarize(text: string, limit = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
