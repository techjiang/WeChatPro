import { createRules, toRuleConfigMap } from '../guard/index.js';
import type { EngineContext } from '../core/context.js';
import type { Plugin } from '../core/plugin.js';

/**
 * 规则查询插件。
 *
 * 抽成独立小插件而不是塞进风控插件：它只读配置、无状态，
 * 部署上不需要风控检测的场景也应能查到「当前配置了哪些规则」。
 */
export function createRulesInspectorPlugin(): Plugin {
  let lines: string[] = [];

  return {
    manifest: {
      name: 'rules-inspector',
      description: '查看当前生效的检测规则与阈值',
    },
    setup(context: EngineContext): void {
      const configMap = toRuleConfigMap(context.config.guard.rules);
      const rules = createRules(context.config.guard.rules).filter(
        (rule) => configMap.get(rule.id)?.enabled ?? true,
      );
      lines = rules.map((rule) => {
        const config = configMap.get(rule.id);
        return `• ${config?.description || rule.description}｜动作 ${config?.action ?? rule.action}｜权重 ${config?.weight ?? rule.defaultWeight}`;
      });
      context.logger.debug({ count: lines.length }, '规则清单已生成');
    },
    subscriptions() {
      return [
        {
          event: 'command' as const,
          handle: (payload) => {
            const command = payload as { intent?: string; reply: (text: string) => void };
            if (command.intent !== 'rules') return;
            command.reply(['🛡 当前生效的检测规则', ...lines].join('\n'));
          },
        },
      ];
    },
  };
}
