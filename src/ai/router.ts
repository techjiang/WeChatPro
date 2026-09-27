/**
 * 意图路由。
 *
 * 群里 @ 机器人的话术千变万化，纯 LLM 路由要一次额外往返且不稳定；
 * 纯正则又漏。这里走「规则优先 + 置信度」：能确定的立刻路由（零延迟零成本），
 * 拿不准的返回 `unknown` 交由上层决定（转 LLM 或忽略），避免误触发。
 */

export type IntentName =
  | 'summary'
  | 'qa'
  | 'stats'
  | 'heatmap'
  | 'top'
  | 'profile'
  | 'rules'
  | 'help'
  | 'unknown';

export interface IntentMatch {
  intent: IntentName;
  /** 0~1，越高越确定。 */
  confidence: number;
  /** 从话术里解析出的参数，如时间范围、被查询成员。 */
  slots: Record<string, unknown>;
  /** 触发词，便于调试路由。 */
  trigger: string;
}

interface IntentPattern {
  intent: IntentName;
  patterns: RegExp[];
  /** 命中关键词后额外提权的词，用来区分「帮我总结」和「总结这个词啥意思」。 */
  boosts?: RegExp[];
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

const PATTERNS: IntentPattern[] = [
  {
    intent: 'help',
    patterns: [/^\/?help\b/i, /^\/?帮助$/, /有什么功能/, /怎么用/, /能做什么/],
  },
  {
    intent: 'summary',
    patterns: [/(总结|摘要|汇总|概括|复盘|聊了(什么|啥))/, /\bsummar(y|ize)\b/i],
    boosts: [/今天|昨天|本周|上周|最近|这周/],
  },
  {
    intent: 'top',
    patterns: [/(排行|榜|top|排名|最活跃|话最多|冒泡)/i],
  },
  {
    intent: 'stats',
    patterns: [/(发言|消息|活跃|统计|数据)(数|量)?/, /\b(stat|stats|statistics)\b/i],
  },
  {
    intent: 'heatmap',
    patterns: [/(热力图|活跃时段|高峰|什么时候(最)?(活跃|热闹)|作息)/],
  },
  {
    intent: 'profile',
    patterns: [/(画像|资料|是谁|介绍一下|活跃度)@?/, /\bprofile\b/i],
  },
  {
    intent: 'rules',
    patterns: [/(规则|规范|检测|风控|审核|拦截)/],
  },
  {
    intent: 'qa',
    patterns: [/[?？]$/, /(请问|是否|有没有|谁知道|在哪|怎么|为什么|何时|多少)/, /^\/(ask|q)\b/i],
  },
];

/** 时间表达式 → 区间。只覆盖群聊里高频的说法，其余交给 LLM 兜底。 */
export function parseTimeRange(text: string, now = Date.now()): { from: number; to: number; label: string } | null {
  if (/今天|今日/.test(text)) return { from: startOfDay(now), to: 0, label: '今天' };
  if (/昨天|昨日/.test(text)) return { from: startOfDay(now) - DAY, to: startOfDay(now), label: '昨天' };
  if (/本周|这周|这个星期/.test(text)) return { from: startOfWeek(now), to: 0, label: '本周' };
  if (/上周|上个星期/.test(text)) {
    const thisWeek = startOfWeek(now);
    return { from: thisWeek - 7 * DAY, to: thisWeek, label: '上周' };
  }
  if (/本月|这个月/.test(text)) return { from: startOfMonth(now), to: 0, label: '本月' };
  if (/上个月|上月/.test(text)) {
    const thisMonth = startOfMonth(now);
    const prevMonth = startOfMonth(thisMonth - DAY);
    return { from: prevMonth, to: thisMonth, label: '上个月' };
  }
  const hours = text.match(/(\d+)\s*(小时|个小时|h)/i);
  if (hours) {
    const n = Number(hours[1]);
    return { from: now - n * HOUR, to: 0, label: `最近 ${n} 小时` };
  }
  const days = text.match(/(\d+)\s*(天|日|d)/i) ?? text.match(/([一二两三四五六七八九十])\s*(天|日)/);
  if (days) {
    const n = /^\d+$/.test(days[1] as string) ? Number(days[1]) : chineseNumber(days[1] as string);
    if (n > 0) return { from: now - n * DAY, to: 0, label: `最近 ${n} 天` };
  }
  // 「最近/近期」不带具体数字时默认三天，放在最后兜底，
  // 否则「最近 3 小时」会被它提前命中而丢掉粒度。
  if (/最近|近期/.test(text)) return { from: now - 3 * DAY, to: 0, label: '最近三天' };
  return null;
}

/** 中文数字转阿拉伯数字，只覆盖群聊里会说的个位数与「十」。 */
function chineseNumber(input: string): number {
  const digits: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return digits[input] ?? 0;
}

export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function startOfWeek(ts: number): number {
  const date = new Date(startOfDay(ts));
  // 以周一为一周起点：国内群聊的「本周」默认按工作日直觉理解。
  const weekday = (date.getDay() + 6) % 7;
  return date.getTime() - weekday * DAY;
}

export function startOfMonth(ts: number): number {
  const date = new Date(ts);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 解析「@某人」或「某某的」这类指名。返回原始文本片段，由上层映射到成员 ID。 */
export function parseMentionTarget(text: string): string | null {
  const at = text.match(/@([^\s@，,。？?]+)/);
  if (at?.[1]) return at[1];
  const of = text.match(/([^\s@，,。？?]{1,16})(的(画像|资料|活跃|发言|统计))/);
  return of?.[1] ?? null;
}

/**
 * 路由一条指令文本。
 *
 * 打分：模式命中给基础分，多个模式命中取最高；`boosts` 再叠加。
 * 低于 0.5 视为 `unknown`——宁可让上层再问一次，也不要误解意图后答非所问。
 */
export function routeIntent(input: string, now = Date.now()): IntentMatch {
  const text = input.trim();
  if (!text) return { intent: 'unknown', confidence: 0, slots: {}, trigger: '' };

  let best: IntentMatch = { intent: 'unknown', confidence: 0, slots: {}, trigger: '' };

  for (const pattern of PATTERNS) {
    for (const regex of pattern.patterns) {
      const match = text.match(regex);
      if (!match) continue;
      let confidence = 0.6;
      if (pattern.boosts?.some((boost) => boost.test(text))) confidence += 0.2;
      // 长命中的正则更具体，给更高分。
      if (match[0].length >= 4) confidence += 0.1;
      if (confidence > best.confidence) {
        best = { intent: pattern.intent, confidence: Math.min(1, confidence), slots: {}, trigger: match[0] };
      }
    }
  }

  if (best.intent === 'unknown') return best;

  const range = parseTimeRange(text, now);
  if (range) best.slots.range = range;

  const target = parseMentionTarget(text);
  if (target) best.slots.target = target;

  // 「总结」与「统计」同时出现时，统计更具体，优先给统计。
  if (best.intent === 'summary' && /(统计|数据|多少条)/.test(text)) {
    best.intent = 'stats';
    best.confidence = Math.min(1, best.confidence + 0.1);
  }

  return best;
}
