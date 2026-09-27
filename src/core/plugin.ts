import type { EventName } from './events.js';
import type { EngineContext } from './context.js';

/**
 * 插件契约。
 *
 * 设计取舍：用「生命周期 + 声明式订阅」而不是给插件传一个裸 bus，
 * 好处是卸载时可以按插件名一次性摘掉全部订阅，热重载不会留下悬挂监听器
 * （这类泄漏在长跑进程里会让内存只增不减，且极难定位）。
 */

export interface PluginManifest {
  name: string;
  /** 简要说明插件做什么，`wechatpro plugins` 会列出。 */
  description?: string;
  /** 声明依赖的其它插件名，引擎按拓扑序启动。 */
  dependsOn?: string[];
}

export interface Plugin {
  readonly manifest: PluginManifest;
  /** 待订阅事件：引擎负责注册与按名退订。 */
  subscriptions?(context: EngineContext): Array<{ event: EventName; handle: (payload: unknown) => void }>;
  /** 插件自有配置（来自 `config.plugins[].options`）。 */
  setup?(context: EngineContext, options: Record<string, unknown>): void | Promise<void>;
  start?(context: EngineContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/** 插件声明重复或依赖缺失时抛出，启动阶段就要失败，别等到运行时。 */
export class PluginGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginGraphError';
  }
}

/**
 * 按依赖关系给插件排序（Kahn 算法）。
 *
 * 返回的数组保证依赖项先于被依赖者；存在环或缺失依赖时抛错。
 */
export function resolvePluginOrder(plugins: readonly Plugin[]): Plugin[] {
  const byName = new Map<string, Plugin>();
  for (const plugin of plugins) {
    if (byName.has(plugin.manifest.name)) {
      throw new PluginGraphError(`插件名重复: ${plugin.manifest.name}`);
    }
    byName.set(plugin.manifest.name, plugin);
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const plugin of plugins) {
    indegree.set(plugin.manifest.name, 0);
    dependents.set(plugin.manifest.name, []);
  }
  for (const plugin of plugins) {
    for (const dependency of plugin.manifest.dependsOn ?? []) {
      if (!byName.has(dependency)) {
        throw new PluginGraphError(`插件 ${plugin.manifest.name} 依赖的 ${dependency} 未注册`);
      }
      indegree.set(plugin.manifest.name, (indegree.get(plugin.manifest.name) ?? 0) + 1);
      dependents.get(dependency)?.push(plugin.manifest.name);
    }
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([name]) => name);
  const ordered: Plugin[] = [];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    ordered.push(byName.get(name) as Plugin);
    for (const dependent of dependents.get(name) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }

  if (ordered.length !== plugins.length) {
    const stuck = plugins
      .map((p) => p.manifest.name)
      .filter((name) => !ordered.some((p) => p.manifest.name === name));
    throw new PluginGraphError(`插件依赖存在环: ${stuck.join(' -> ')}`);
  }
  return ordered;
}
