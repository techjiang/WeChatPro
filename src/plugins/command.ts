import { routeIntent, parseTimeRange } from '../ai/index.js';
import { lastDays } from '../analytics/index.js';
import type { EngineContext } from '../core/context.js';
import type { Plugin } from '../core/plugin.js';
import type { NormalizedMessage } from '../core/types.js';

/**
 * 指令插件。
 *
 * 职责单一：把「群里的一句话」翻译成「结构化指令事件」发到总线。
 * 具体怎么执行由 analytics / ai / guard 插件各自订阅 —— 这样加一个新能力
 * 只需订阅 `command`，不必改这里的分发逻辑（避免出现越来越长的 switch）。
 */

export interface CommandPluginOptions {
  /** 触发指令的前缀，命中即视为指令。默认 `/`。 */
  prefix?: string;
  /** 机器人的别名，出现在文本里即视为被呼叫。 */
  aliases?: string[];
  /** 无需前缀/呼叫也响应的裸指令词（如 `help`、`帮助`）。 */
  bareCommands?: string[];
  /** 低置信度时是否回复提示（避免用户以为机器人没反应）。 */
  replyOnUnknown?: boolean;
}

/** 裸指令词默认值：群成员喊一句「help」就该给帮助，不必先学会 `/` 语法。 */
export const DEFAULT_BARE_COMMANDS = ['help', '帮助', '菜单', '指令'];

const HELP_TEXT = [
  '🤖 WeChatPro 指令一览',
  '',
  '📊 统计',
  '  /统计 [今天|昨天|本周|最近3天] — 群活跃度概览',
  '  /热力图 — 活跃时段分布',
  '  /排行 — 发言排行 Top10',
  '',
  '🧠 AI（需开启 ai.enabled）',
  '  /总结 [今天|本周] — 生成群聊摘要',
  '  /ask <问题> — 基于群内记录问答',
  '',
  '🛡 风控',
  '  /规则 — 查看当前生效的检测规则',
  '',
  '也可直接 @我 并说出需求，例如「@机器人 这周大家都聊了什么」。',
].join('\n');

export function createCommandPlugin(): Plugin {
  let options: CommandPluginOptions = {};

  return {
    manifest: {
      name: 'command',
      description: '指令解析：把群消息路由为结构化指令事件',
    },
    setup(context: EngineContext, raw: Record<string, unknown>): void {
      options = raw as CommandPluginOptions;
      context.logger.debug({ aliases: options.aliases }, '指令插件已配置');
    },
    subscriptions(context) {
      return [
        {
          event: 'message' as const,
          handle: (payload) => {
            const message = payload as NormalizedMessage;
            const decision = extractCommand(message.text, options);
            if (!decision.isCommand) return;

            const match = routeIntent(decision.text, message.timestamp);
            const range = (match.slots.range as { from: number; to: number } | undefined) ??
              parseTimeRange(decision.text, message.timestamp) ??
              undefined;

            context.bus.emit('command', {
              intent: match.intent,
              confidence: match.confidence,
              conversationId: message.conversation.id,
              conversationName: message.conversation.name,
              memberId: message.sender.id,
              memberName: message.sender.displayName,
              question: decision.text,
              trigger: match.trigger,
              range: range ?? lastDays(7),
              target: match.slots.target,
              messageId: message.id,
              reply: (text: string) => {
                void context.sendMessage(message.conversation.id, text);
              },
            });

            if (match.intent === 'unknown' && options.replyOnUnknown !== false) {
              void context.sendMessage(message.conversation.id, HELP_TEXT);
            }
          },
        },
        {
          event: 'command' as const,
          handle: (payload) => {
            const command = payload as { intent?: string; reply: (text: string) => void };
            if (command.intent === 'help') command.reply(HELP_TEXT);
          },
        },
      ];
    },
  };
}

export interface CommandDecision {
  isCommand: boolean;
  /** 去掉前缀与 @ 后的指令正文。 */
  text: string;
  /** 命中方式，便于排障：prefix / mention / plain。 */
  reason: 'prefix' | 'mention' | 'plain';
}

/**
 * 判断一条消息是否是对机器人的指令，并剥离出正文。
 *
 * @ 的表示法在各协议里不统一（`@name`、`@name\u2005`、纯 `@`），
 * 所以不能只看 `mentions` 数组；文本里出现别名同样算呼叫。
 */
export function extractCommand(text: string, options: CommandPluginOptions = {}): CommandDecision {
  const prefix = options.prefix ?? '/';
  const aliases = options.aliases ?? ['机器人', 'bot', '小助手'];
  const bareCommands = options.bareCommands ?? DEFAULT_BARE_COMMANDS;
  const trimmed = text.trim();
  if (!trimmed) return { isCommand: false, text: '', reason: 'plain' };

  if (prefix && trimmed.startsWith(prefix)) {
    return { isCommand: true, text: trimmed.slice(prefix.length).trim(), reason: 'prefix' };
  }

  // 裸指令词：整条消息就是一个已知指令，省掉前缀。只在完全相等时匹配，
  // 避免「帮助我改下这个文件」这种正常句子被当成指令。
  if (bareCommands.some((word) => word.toLowerCase() === trimmed.toLowerCase())) {
    return { isCommand: true, text: trimmed, reason: 'prefix' };
  }

  const hasAt = /@/.test(trimmed);
  const aliasHit = aliases.find((alias) => trimmed.toLowerCase().includes(alias.toLowerCase()));

  if (hasAt || aliasHit) {
    // 去掉所有 @xxx 片段与别名，剩下的才是真正的问题。
    let body = trimmed.replace(/@[^\s@，,。？?！!：:]+/g, ' ').trim();
    if (aliasHit) body = body.replace(new RegExp(escapeRegExp(aliasHit), 'gi'), ' ').trim();
    if (!body) return { isCommand: true, text: trimmed, reason: aliasHit ? 'mention' : 'plain' };
    return { isCommand: true, text: body, reason: 'mention' };
  }

  return { isCommand: false, text: trimmed, reason: 'plain' };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { HELP_TEXT };
