import { DAY_MS } from '../analytics/index.js';
import { GroupManager } from '../manage/index.js';
import type { EngineContext } from '../core/context.js';
import type { Plugin } from '../core/plugin.js';

/**
 * 群聊信息管理插件。
 *
 * 做两件事：定时数据留存（防止磁盘无限增长）、把候选群知识落成正式条目。
 * 候选（knowledge_seed）与正式（knowledge）分开存，是为了让「自动挖掘」与
 * 「人工确认」两个来源可区分，避免自动抽取的噪声直接污染问答语料。
 */

export interface ManagePluginOptions {
  /** 留存检查的 cron，默认每小时。 */
  retentionCron?: string;
}

export function createManagePlugin(): Plugin {
  let manager: GroupManager | null = null;

  return {
    manifest: {
      name: 'manage',
      description: '群聊信息管理：群档案、成员台账、群知识、数据留存',
    },
    setup(context: EngineContext): void {
      manager = new GroupManager(context.store);
      context.logger.debug(
        { conversations: manager.listConversations().length },
        '群聊管理插件已配置',
      );
    },
    subscriptions(context) {
      return [
        {
          event: 'member.join' as const,
          handle: (payload) => {
            context.logger.info({ payload }, '检测到成员入群事件');
          },
        },
        {
          event: 'command' as const,
          handle: (payload) => {
            const command = payload as { intent?: string; reply: (text: string) => void; conversationId: string };
            if (command.intent !== 'profile' || !manager) return;
            const digest = manager.digest(command.conversationId);
            if (!digest) {
              command.reply('暂无该群档案，等待消息积累后自动建立。');
              return;
            }
            const lines = [
              `📇 ${digest.conversation.name}`,
              `累计消息：${digest.conversation.message_count} 条`,
              `成员数：${manager.listMembers(command.conversationId).length} 人`,
              `近三天新增：${digest.newMembers.length} 人`,
              `沉默成员（>14 天）：${digest.silentMembers.length} 人`,
              `近期风控事件：${digest.recentAlerts.length} 起`,
            ];
            command.reply(lines.join('\n'));
          },
        },
      ];
    },
    /**
     * 数据留存。
     *
     * 用 setInterval 而非 cron 库：这里只需「周期性执行」，引入调度器
     * 会多一个依赖与一套 cron 语法，收益为零。真正的定时报表走 API 层调度。
     */
    start(context: EngineContext): void {
      const retain = context.config.manage.retainMessagesPerConversation;
      if (retain <= 0) return;
      const timer = setInterval(() => {
        try {
          const removed = manager?.applyRetention(retain) ?? {};
          const total = Object.values(removed).reduce((sum, count) => sum + count, 0);
          if (total > 0) context.logger.info({ removed }, '已按留存策略清理历史消息');
        } catch (error) {
          context.logger.warn({ err: error }, '留存清理失败');
        }
      }, 6 * 60 * 60 * 1000);
      // 允许进程正常退出，不被这个定时器拖住。
      timer.unref();
    },
  };
}

export { DAY_MS };
