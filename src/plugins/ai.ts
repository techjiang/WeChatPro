import { AiService } from '../ai/index.js';
import { lastDays } from '../analytics/index.js';
import { renderReport } from './analytics.js';
import { AnalyticsEngine } from '../analytics/index.js';
import type { EngineContext } from '../core/context.js';
import type { Plugin } from '../core/plugin.js';
import type { NormalizedMessage } from '../core/types.js';

/**
 * AI 插件。
 *
 * 只做两件事：被动响应 @ 提问、主动沉淀群知识。
 * 不做「每条消息都过一遍 LLM」——群聊消息量大，逐条调用既贵又慢，
 * 语义审核交给风控插件按需开启（仅对已命中规则的样本复核）。
 */

export interface AiPluginOptions {
  /** 触发词：消息里出现这些词才走 AI（除 @ 机器人外）。 */
  triggers?: string[];
  /** 是否把高价值消息自动沉淀为群知识。 */
  autoKnowledge?: boolean;
  /** 知识抽取的触发条件：消息长度超过该值才考虑。 */
  knowledgeMinChars?: number;
}

export function createAiPlugin(): Plugin {
  let ai: AiService | null = null;
  let analytics: AnalyticsEngine | null = null;

  return {
    manifest: {
      name: 'ai',
      description: 'AI 助手：群聊摘要、群内问答、语义审核、知识沉淀',
      dependsOn: ['analytics'],
    },
    setup(context: EngineContext, options: Record<string, unknown>): void {
      const config = options as AiPluginOptions;
      void config;
      ai = new AiService({ config: context.config, store: context.store, logger: context.logger });
      analytics = new AnalyticsEngine(context.store, context.config.analytics.hourlyBuckets);
      context.logger.info({ enabled: ai.enabled, model: ai.model }, 'AI 插件已配置');
    },
    subscriptions(context) {
      return [
        {
          event: 'command' as const,
          handle: (payload) => {
            void (async () => {
              const command = payload as {
                intent?: string;
                conversationId: string;
                question: string;
                reply: (text: string) => void;
                range?: { from: number; to: number };
                target?: string;
              };
              if (!ai || !command.intent) return;

              try {
                switch (command.intent) {
                  case 'summary': {
                    if (!ai.enabled) {
                      command.reply('AI 未启用，无法生成语义摘要。可在配置中开启 ai.enabled。');
                      return;
                    }
                    const result = await ai.summarize(command.conversationId, {
                      focus: command.question,
                    });
                    command.reply(`📝 群聊摘要（${result.coveredMessages} 条消息）\n\n${result.summary}`);
                    return;
                  }
                  case 'qa': {
                    if (!ai.enabled) {
                      command.reply('AI 未启用，无法回答问题。可在配置中开启 ai.enabled。');
                      return;
                    }
                    const answer = await ai.ask(command.conversationId, command.question);
                    if (!answer) return;
                    const evidence =
                      answer.evidenceCount > 0 ? `\n\n（依据 ${answer.evidenceCount} 条历史消息）` : '\n\n（未检索到相关记录）';
                    command.reply(`💬 ${answer.answer}${evidence}`);
                    return;
                  }
                  case 'stats':
                  case 'heatmap':
                  case 'top': {
                    if (!analytics) return;
                    const range = command.range ?? lastDays(7);
                    command.reply(renderReport(analytics, command.intent, command.conversationId, range));
                    return;
                  }
                  default:
                    return;
                }
              } catch (error) {
                // AI 失败不能静默：用户会以为机器人坏了。明确回一句并记日志。
                context.logger.error({ err: error, intent: command.intent }, 'AI 指令执行失败');
                command.reply('抱歉，处理这条请求时出错了，请稍后再试。');
              }
            })();
          },
        },
        {
          event: 'message' as const,
          handle: (payload) => {
            void onMessage(context, payload as NormalizedMessage, ai);
          },
        },
      ];
    },
  };
}

/**
 * 群知识沉淀。
 *
 * 触发条件刻意简单：消息够长、以陈述句结尾、不含疑问与链接。
 * 「让 LLM 判断每条消息值不值得记」成本太高且不稳定；
 * 用可解释的启发式先筛掉 90% 噪声，再由人工通过管理接口补充。
 */
async function onMessage(
  context: EngineContext,
  message: NormalizedMessage,
  ai: AiService | null,
): Promise<void> {
  if (!ai?.enabled || !context.config.manage.enabled) return;
  if (message.kind !== 'text' || message.direction === 'outbound') return;
  if (message.text.length < 20) return;
  if (/[?？]$/.test(message.text.trim())) return;
  if (/https?:\/\//i.test(message.text)) return;
  if (!/(规则|约定|注意|记得|流程|时间|安排|决定|地址|链接|文档|模板|标准)/.test(message.text)) return;

  const category = /(规则|约定|标准|流程|注意)/.test(message.text) ? '规则' : '决定';
  context.store.setKv(
    'knowledge_seed',
    `${message.conversation.id}:${message.id}`,
    JSON.stringify({
      conversationId: message.conversation.id,
      category,
      content: message.text,
      sourceMessageId: message.id,
      createdBy: message.sender.id,
      createdAt: message.timestamp,
    }),
  );
  context.logger.debug({ conversation: message.conversation.id }, '已登记候选群知识');
}
