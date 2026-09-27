import type { NormalizedMessage } from '../core/types.js';

/**
 * 提示词集中管理。
 *
 * 放在独立文件而不是散在调用点：提示词是会反复迭代的资产，集中后能一眼看出
 * 语气与格式约定是否一致；也让「模型换版本后输出格式崩了」这种问题只需改一处。
 *
 * 约定：所有提示都要求模型不要臆造事实，群聊场景下编造信息比拒答危害大得多。
 */

export const SYSTEM_ASSISTANT = [
  '你是 WeChatPro，一个微信社群智能助手。',
  '你服务于群主与管理员，回答要简短、直接、可执行。',
  '不确定的信息明确说不确定，绝不编造群成员、时间或事件。',
  '输出使用简体中文；除用户要求外不要输出 Markdown 表格。',
].join('\n');

export const SUMMARY_SYSTEM = [
  '你是群聊记录整理助手。',
  '任务：把碎片化的聊天记录压缩成结构化摘要。',
  '要求：只依据给定记录，不补充外部知识；不评价成员人品；保留关键结论与待办。',
].join('\n');

export const MODERATION_SYSTEM = [
  '你是社群内容审核助手。',
  '任务：判断单条消息是否违反社群规范，并给出简短理由。',
  '只输出 JSON，不要输出任何解释性文字。',
].join('\n');

/** 把消息列表渲染成模型可读的对话记录。 */
export function renderTranscript(
  messages: readonly NormalizedMessage[],
  options: { maxChars?: number; withTime?: boolean } = {},
): string {
  const maxChars = options.maxChars ?? 12_000;
  const lines: string[] = [];
  let used = 0;

  // 从最新往回拼，保证截断时丢的是最旧的内容。
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as NormalizedMessage;
    const time = options.withTime === false ? '' : `[${formatClock(message.timestamp)}] `;
    const body = message.text ? message.text : message.summary || `[${message.kind}]`;
    const line = `${time}${message.sender.displayName}: ${body}`;
    used += line.length + 1;
    if (used > maxChars) break;
    lines.push(line);
  }

  return lines.reverse().join('\n');
}

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 群聊每日摘要。 */
export function summaryPrompt(conversationName: string, transcript: string, focus?: string): string {
  const focusLine = focus ? `\n重点关注：${focus}` : '';
  return [
    `群名称：${conversationName}`,
    focusLine,
    '',
    '聊天记录（时间升序）：',
    transcript,
    '',
    '请按以下结构输出：',
    '1. 一句话概览（不超过 40 字）',
    '2. 主要话题（3–6 条，每条一行，标注大致时间段）',
    '3. 待办/决定（若无写“无”）',
    '4. 值得关注的异常（广告、争吵、刷屏等，若无写“无”）',
  ].join('\n');
}

/** 群内问答。 */
export function qaPrompt(conversationName: string, context: string, question: string): string {
  return [
    `以下是「${conversationName}」的聊天记录片段：`,
    context || '（无相关记录）',
    '',
    `问题：${question}`,
    '',
    '要求：仅依据上面的记录回答；记录中没有提到的信息，直接说明“记录中没有相关信息”，不要推测。',
  ].join('\n');
}

/** 内容审核：让模型补充正则/词表覆盖不到的语义判断。 */
export function moderationPrompt(message: NormalizedMessage, policy: string): string {
  return [
    '社群规范：',
    policy,
    '',
    '待审核消息：',
    `发送者：${message.sender.displayName}`,
    `类型：${message.kind}`,
    `内容：${message.text || message.summary}`,
    '',
    '输出 JSON，字段：',
    '{"violation": boolean, "category": "广告|辱骂|敏感|诈骗|无", "severity": 0-100, "reason": "一句话理由"}',
  ].join('\n');
}
