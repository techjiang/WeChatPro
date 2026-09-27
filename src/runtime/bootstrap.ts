import { Engine } from './engine.js';
import { parseConfig, applyEnvOverrides, ConfigError, type AppConfig } from '../core/config.js';
import { registerBuiltinAdapters } from '../protocols/index.js';
import { describeUnmapped } from '../protocols/host.js';
import { createAnalyticsPlugin } from '../plugins/analytics.js';
import { createAiPlugin } from '../plugins/ai.js';
import { createClientPlugin } from '../plugins/client.js';
import { createCommandPlugin } from '../plugins/command.js';
import { createGuardPlugin } from '../plugins/guard.js';
import { createManagePlugin } from '../plugins/manage.js';
import { createRulesInspectorPlugin } from '../plugins/rules-inspector.js';
import { buildServer, assertSafeBinding } from '../api/server.js';
import { AiService } from '../ai/index.js';
import { createClientHost, type ClientHost } from '../client/host.js';
import { readFile } from 'node:fs/promises';
import type { Plugin } from '../core/plugin.js';
import type { HostBridge } from '../core/host-bridge.js';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

/**
 * 组装入口。
 *
 * 分开「注册内置插件」与「启动引擎」两步：测试里常需要只起引擎不起 HTTP，
 * 或替换某个插件为桩，所以 bootstrap 返回各部分句柄而不是直接开跑。
 *
 * 两种运行形态共用同一条装配线：
 *
 * - **服务形态**（默认）：引擎监听协议中间件推来的 HTTP 事件，面板走 `api.port`。
 * - **客户端形态**（`client.enabled`）：引擎被嵌进微信 PC 客户端进程，宿主直接注入消息，
 *   面板由宿主内嵌渲染。此时 `host` 适配器由 bootstrap 自动接上，并暴露 `client` 句柄。
 */

export interface BootstrapOptions {
  configPath?: string;
  /** 直接给配置对象（测试用），给定时忽略 `configPath`。 */
  config?: AppConfig;
  /** 追加/替换插件。同名插件后者覆盖前者。 */
  extraPlugins?: Plugin[];
  /** 是否注册内置插件，默认 true。 */
  withBuiltinPlugins?: boolean;
  /** 客户端宿主桥；给出即进入客户端形态（等价于 `client.enabled`）。 */
  hostBridge?: HostBridge;
  /** 强制启用/禁用客户端形态，覆盖配置。 */
  clientMode?: boolean;
}

export interface BootstrapResult {
  engine: Engine;
  config: AppConfig;
  logger: Logger;
  server?: FastifyInstance;
  /** 客户端宿主句柄；仅在客户端形态下存在。 */
  client?: ClientHost;
  /** 启动全部组件。 */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 宿主注入被拒的按原因计数。
 *
 * 这类问题在客户端插件里最难查：宿主以为发出去了，面板却什么都没变。
 * 计数挂在模块级（同一个进程只跑一份插件），`client` 命令与自检命令直接读它。
 */
const dropCounters = new Map<string, number>();

export const builtinPlugins: Plugin[] = [
  createAnalyticsPlugin(),
  createAiPlugin(),
  createClientPlugin(),
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
  const config = options.config ?? (await loadConfig(options.configPath));

  const clientMode = options.clientMode ?? (config.client.enabled || Boolean(options.hostBridge));

  // 客户端形态：先建宿主句柄，再把「造适配器的方式」交给注册表，
  // 这样引擎绑定的一定是 `client.ingest()` 用的那个 transport。
  const host = clientMode
    ? createClientHost({
        host: config.client.host,
        panelRoute: config.client.panelRoute,
        ...(options.hostBridge ? { bridge: options.hostBridge } : {}),
      })
    : undefined;

  // `hostProvider` 每次 bootstrap 都重新传入：注册表是全局的，而宿主实例是每份插件一份。
  // 只在首次生效的话，第二个客户端形态会拿到第一个宿主的适配器，注入静默失效。
  //
  // 第三个参数（选项指纹）决定「什么时候允许复用同一个实例」：同一个进程里
  // 客户端形态的宿主与 `import` 用的默认宿主选项不同（mapping / transport），
  // 无条件复用会让导入的数据按另一套字段名解析，表现为「导入 0 条」而日志正常。
  registerBuiltinAdapters(
    host
      ? { hostGateway: host.gateway, hostProvider: () => host.adapter, hostProviderOptions: host.adapterOptions }
      : {},
  );
  const client = host;

  if (client) {
    // 客户端形态下 `host` 适配器必然启用：它就是消息来源，关掉等于引擎空转。
    const hasHostAdapter = config.adapters.some((adapter) => adapter.protocol === 'host');
    if (!hasHostAdapter) {
      config.adapters.unshift({ protocol: 'host', enabled: true, options: { host: config.client.host } });
    }
  }

  const plugins: Plugin[] = options.withBuiltinPlugins === false ? [] : [...builtinPlugins];
  for (const plugin of options.extraPlugins ?? []) {
    const index = plugins.findIndex((item) => item.manifest.name === plugin.manifest.name);
    if (index >= 0) plugins[index] = plugin;
    else plugins.push(plugin);
  }

  const engine = new Engine({ config, plugins, ...(client ? { client } : {}) });
  const ai = new AiService({ config, store: engine.store, logger: engine.logger });

  let server: FastifyInstance | undefined;
  if (config.api.enabled) {
    assertSafeBinding(config);
    server = buildServer({ engine, config, logger: engine.logger, ai, client });
  }

  // 宿主降级金丝雀：把适配器层的丢弃事件转成 bus 上的 `engine.warn`，
  // 让「注入了但没进库」这件事在面板与日志里都看得见（而不是静默消失）。
  const hostAdapter = client?.adapter;
  if (hostAdapter) {
    hostAdapter.transport.onDrop((reason, payload) => {
      dropCounters.set(reason, (dropCounters.get(reason) ?? 0) + 1);
      engine.logger.warn(
        { reason, dropped: hostAdapter.transport.dropped, rejected: hostAdapter.transport.rejected, payload },
        reason === 'unmapped' ? `宿主载荷无法映射：${describeUnmapped(payload)}` : '宿主注入被拒绝（引擎未就绪）',
      );
    });
  }

  return {
    engine,
    config,
    logger: engine.logger,
    ...(server ? { server } : {}),
    ...(client ? { client } : {}),
    async start(): Promise<void> {
      await engine.start();
      if (server) {
        const address = await server.listen({ host: config.api.host, port: config.api.port });
        engine.logger.info({ address }, '控制台已启动');
      }
      if (client) {
        engine.logger.info(
          { host: client.host, capabilities: client.capabilities() },
          '客户端宿主模式已就绪：等待宿主注入消息',
        );
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

/** 读取当前进程里宿主注入被拒的计数（原因 -> 次数）。 */
export function hostDropStats(): Record<string, number> {
  return Object.fromEntries(dropCounters);
}
