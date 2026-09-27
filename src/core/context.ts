import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { EventBus } from './events.js';
import type { Store } from './store.js';
import type { ProtocolAdapter } from './types.js';

/**
 * 插件运行上下文。
 *
 * 插件只通过它拿依赖，不直接 import 具体实现——这样测试时可以塞内存 store
 * 与假适配器，也不需要模块级单例（模块级单例在测试间会串状态）。
 */
export interface EngineContext {
  config: AppConfig;
  logger: Logger;
  bus: EventBus;
  store: Store;
  /** 已启动的协议适配器，按名字索引。 */
  adapters: ReadonlyMap<string, ProtocolAdapter>;
  /** 主动发消息：挑一个支持 `send` 的适配器代发。 */
  sendMessage(conversationId: string, text: string): Promise<boolean>;
  /**
   * 客户端宿主句柄（仅在 PC 客户端形态下存在）。
   * 类型用 `unknown` 是为了让核心层不反向依赖 `src/client/`——插件自行做窄化。
   */
  client?: unknown;
}
