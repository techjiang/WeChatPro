import { Engine } from './engine.js';
import { parseConfig, applyEnvOverrides, ConfigError, type AppConfig } from '../core/config.js';
import { registerBuiltinAdapters } from '../protocols.js';
import { createAnalyticsPlugin } from '../plugins/analytics.js';
import { createAiPlugin } from '../plugins/ai.js';
import { createCommandPlugin } from '../plugins/command.js';
import { createGuardPlugin } from '../plugins/guard.js';
import { createManagePlugin } from '../plugins/manage.js';
import { createRulesInspectorPlugin } from '../plugins/rules-inspector.js';
import { buildServer, assertSafeBinding } from '../api/server.js';
import { AiService } from '../ai/index.js';
import { readFile } from 'node:fs/promises';
import type { Plugin } from '../core/plugin.js';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

/**
 * 组装入口。
 *
 * 分开「注册内置插件」与「启动引擎」两步：测试里常需要只起引擎不起 HTTP，
 * 或替换某个插件为桩，所以 bootstrap 返回各部分句柄而不是直接开跑。
 */

export interface BootstrapOptions {
  configPath?: string;
  /** 直接给配置对象（测试用），给定时忽略 `configPath`。 */
  config?: AppConfig;
  /** 追加/替换插件。同名插件后者覆盖前者。 */
  extraPlugins?: Plugin[];
  /** 是否注册内置插件，默认 true。 */
  withBuiltinPlugins?: boolean;
}

export interface BootstrapResult {
  engine: Engine;
  config: AppConfig;
  logger: Logger;
  server?: FastifyInstance;
  /** 启动全部组件。 */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const builtinPlugins: Plugin[] = [
  createAnalyticsPlugin(),
  createAiPlugin(),
  createCommandPlugin(),
  createGuardPlugin(),
  createManagePlugin(),
  createRulesInspectorPlugin(),
];

export async function loadConfig(configPath?: string, env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  let raw: unknown = {};
  if (configPath) {
    try {
      raw = JSON.parse(await readFile(configPath, 'utf8'));
    } catch (error) {
      throw new Error(
        `读取配置文件失败: ${configPath} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return applyEnvOverrides(parseConfig(raw), env);
}

export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  registerBuiltinAdapters();
  const config = options.config ?? (await loadConfig(options.configPath));

  const plugins: Plugin[] = options.withBuiltinPlugins === false ? [] : [...builtinPlugins];
  for (const plugin of options.extraPlugins ?? []) {
    const index = plugins.findIndex((item) => item.manifest.name === plugin.manifest.name);
    if (index >= 0) plugins[index] = plugin;
    else plugins.push(plugin);
  }

  const engine = new Engine({ config, plugins });
  const ai = new AiService({ config, store: engine.store, logger: engine.logger });

  let server: FastifyInstance | undefined;
  if (config.api.enabled) {
    assertSafeBinding(config);
    server = buildServer({ engine, config, logger: engine.logger, ai });
  }

  return {
    engine,
    config,
    logger: engine.logger,
    server,
    async start(): Promise<void> {
      await engine.start();
      if (server) {
        const address = await server.listen({ host: config.api.host, port: config.api.port });
        engine.logger.info({ address }, '控制台已启动');
      }
    },
    async stop(): Promise<void> {
      await server?.close();
      await engine.stop();
      engine.store.close();
    },
  };
}

export { ConfigError };
