import { BRAND } from '../client/brand.js';
import type { ClientHost } from '../client/host.js';
import type { EngineContext } from '../core/context.js';
import type { GuardAlert } from '../guard/index.js';
import type { Plugin } from '../core/plugin.js';

/**
 * 客户端插件。
 *
 * 职责：把「引擎里发生的事」翻译成「客户端里的可见反馈」，以及把「客户端里的动作」
 * 回灌到引擎。没有它，引擎照样统计入库，但用户在微信里什么都看不到——
 * 这正是「能直接用、能管理」与「只是后台跑个服务」的区别。
 *
 * 三条通路：
 *
 * 1. 风控告警 → 客户端原生通知 + 入口角标（不必盯着群也知道出事了）
 * 2. 成员变动 → 群档案成员数即时刷新（群管理的第一手信息）
 * 3. 群内指令 `/面板` `/导出` → 直接在客户端打开面板 / 弹保存对话框
 */

export interface ClientPluginOptions {
  /** 是否弹原生通知。默认跟随 `client.notifyOnAlert`。 */
  notify?: boolean;
  /** 通知去重窗口（毫秒）。 */
  notifyDedupeMs?: number;
  /** 角标上限，超过显示 `+`。 */
  badgeMax?: number;
  /** 允许在群里触发 `/面板` 打开客户端面板。 */
  allowRemotePanel?: boolean;
}

/**
 * 客户端自定义指令。
 *
 * 这批指令**刻意不进意图路由**：「打开面板」「导出档案」是客户端形态特有的动作，
 * 在只有 HTTP 适配器的部署里毫无意义。放进 `routeIntent` 会让路由表背上
 * 一堆只在特定形态下成立的意图；放这里则是「谁提供动作、谁解析指令」，
 * 而且天然不抢 `/帮助` 的路由（`@机器人 /面板` 只会命中这一条）。
 */
export const CLIENT_COMMANDS = ['面板', 'panel', '导出', 'export'] as const;

/** 判断指令正文是否是客户端自定义指令，并归一化成动作名。 */
export function matchClientCommand(text: string): 'panel' | 'export' | null {
  const normalized = text.trim().replace(/^\/+/, '').toLowerCase();
  if (normalized === '面板' || normalized === 'panel') return 'panel';
  if (normalized === '导出' || normalized === 'export') return 'export';
  return null;
}

export function createClientPlugin(): Plugin {
  let host: ClientHost | null = null;
  let unread = 0;

  /** 取宿主句柄：优先用引擎上下文里注入的（客户端形态），否则插件独立运行。 */
  function resolve(context: EngineContext): ClientHost | null {
    return (context as EngineContext & { client?: ClientHost }).client ?? host;
  }

  return {
    manifest: {
      name: 'client',
      description: 'PC 客户端集成：原生通知、入口角标、面板唤起、群内指令',
    },
    setup(context: EngineContext, raw: Record<string, unknown>): void {
      const options = raw as ClientPluginOptions;
      const injected = (context as EngineContext & { client?: ClientHost }).client;
      if (injected) host = injected;
      const onAlert = options.notify ?? context.config.client.notifyOnAlert;
      context.logger.debug(
        { host: host?.host ?? 'none', notify: onAlert, capabilities: host?.capabilities() ?? [] },
        '客户端插件已配置',
      );
    },
    subscriptions(context) {
      const options = context.config.plugins.find((p) => p.name === 'client')?.options as
        | ClientPluginOptions
        | undefined;
      const notifyEnabled = options?.notify ?? context.config.client.notifyOnAlert;
      const dedupeMs = options?.notifyDedupeMs ?? context.config.client.notifyDedupeMs;
      const badgeMax = options?.badgeMax ?? context.config.client.badgeMax;

      return [
        {
          event: 'alert' as const,
          handle: (payload) => {
            const alert = payload as GuardAlert;
            unread += 1;
            const badge = unread > badgeMax ? `${badgeMax}+` : String(unread);
            void resolve(context)?.gateway.setTitleBadge(badge);
            void resolve(context)?.gateway.setBadge(Math.min(unread, badgeMax));
            if (!notifyEnabled) return;
            // 同一条规则 + 同一个成员在窗口内只提醒一次：
            // 刷屏者往往连续命中，逐条弹通知会让用户直接关掉插件。
            void resolve(context)?.gateway.notify({
              title: `${BRAND.name} · 风控告警`,
              body: `${alert.reason}（风险分 ${alert.riskScore}）`,
              level: alert.riskScore >= 50 ? 'error' : 'warn',
              route: '#/guard',
              dedupeKey: `${alert.conversationId}:${alert.memberId}:${alert.ruleId}`,
            });
            void dedupeMs;
          },
        },
        {
          event: 'member.join' as const,
          handle: (payload) => {
            const event = payload as { payload?: { conversationId?: string; memberId?: string } };
            void resolve(context)?.gateway.toast(
              `新成员加入：${event.payload?.memberId ?? '未知成员'}`,
              'info',
            );
          },
        },
        {
          event: 'command' as const,
          handle: (payload) => {
            const command = payload as {
              intent?: string;
              question?: string;
              conversationId?: string;
              reply: (text: string) => void;
            };
            const text = command.question ?? '';
            const action = matchClientCommand(text);
            // 群内 `/面板`：把客户端插件面板直接拉到前台，比让人自己找入口快。
            if (action === 'panel') {
              if (!(options?.allowRemotePanel ?? true)) return;
              void resolve(context)
                ?.focus('#/dashboard')
                .then((result) => {
                  command.reply(
                    result.opened ? '已在微信客户端打开 WeChatPro 面板。' : '当前环境不支持打开面板。',
                  );
                });
              return;
            }
            if (action === 'export') {
              const conversationId = command.conversationId ?? '';
              const payloadJson = JSON.stringify(
                {
                  conversation: context.store.getConversation(conversationId) ?? null,
                  members: context.store.listMembers(conversationId),
                  events: context.store.recentEvents(conversationId, 200),
                  exportedAt: new Date().toISOString(),
                  generator: BRAND.name,
                },
                null,
                2,
              );
              void resolve(context)
                ?.gateway.exportFile({
                  filename: `wechatpro-${conversationId.replace(/[@:]/g, '_')}.json`,
                  content: payloadJson,
                })
                .then((path) => {
                  command.reply(path ? `群档案已导出到 ${path}` : '导出已取消。');
                });
            }
          },
        },
      ];
    },
    /** 插件独立运行（无 bootstrap 注入）时的兜底：从配置自建宿主句柄。 */
    async start(context) {
      const injected = (context as EngineContext & { client?: ClientHost }).client;
      if (!injected && !host) {
        const { createClientHost } = await import('../client/host.js');
        host = createClientHost({
          host: context.config.client.host,
          panelRoute: context.config.client.panelRoute,
        });
      }
    },
  };
}

/** 供面板与 CLI 复用：读取未读角标文本。 */
export function badgeText(count: number, max = 99): string {
  return count > max ? `${max}+` : String(count);
}
