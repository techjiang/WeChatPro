import { registerAdapter, listAdapterProtocols } from '../core/registry.js';
import type { AdapterFactory } from '../core/registry.js';
import { buildMockAdapter, buildWebhookAdapter } from './webhook.js';
import { createHostAdapter } from './host.js';
import type { MockAdapterOptions, WebhookAdapterOptions } from './webhook.js';
import type { HostAdapterOptions } from './host.js';
import type { HostGateway } from '../core/host-bridge.js';

/**
 * 协议适配器注册中心。
 *
 * 内置三类「通用底座」，而不是绑死某一家微信协议：
 *
 * - `mock`：测试与演示，按脚本投递消息，全链路可离线验证。
 * - `http-webhook`：接收任意微信中间件（本地 hook、云网关、企业微信）推来的 HTTP 事件。
 * - `host`：PC 客户端进程内注入（本仓库的主形态），宿主直接调用 `inject` 投递消息对象。
 *
 * 对接私有协议时按 `ProtocolAdapter` 实现并 `registerAdapter`，不修改本文件。
 */

export { buildMockAdapter, buildWebhookAdapter, mapPayload, coerceKind } from './webhook.js';
export type { MockAdapterOptions, WebhookAdapterOptions } from './webhook.js';
export {
  createHostAdapter,
  HostTransport,
  WECHAT_PC_MAPPING,
  WECHAT_KIND_ALIASES,
  coerceHostKind,
  parseChatExport,
  dumpPayload,
} from './host.js';
export type { HostAdapterOptions, HostIngestPayload, IngestResult } from './host.js';

export interface RegisterBuiltinOptions {
  /** 宿主反向调用桥；只为 `host` 适配器注入。 */
  hostGateway?: HostGateway;
  /** 宿主桥实现；与 `hostGateway` 同时给出时，构造 `host` 适配器即挂载。 */
  hostBridge?: import('../core/host-bridge.js').HostBridge;
  /**
   * 宿主适配器工厂。
   *
   * 客户端形态必须传入，且**每次返回同一个实例**（由 `createClientHost` 保证）。
   * 原因：消息入口 `inject()` 与引擎绑定的是同一个 `HostTransport`，
   * 工厂若每次新建实例，宿主注入的消息会落到一个没有订阅者的 transport 上，
   * 表现为「日志正常、消息全丢」。
   */
  hostFactory?: AdapterFactory;
}

/** 注册内置适配器。由 `bootstrap()` 调用一次，避免模块导入副作用。 */
/**
 * 幂等注册。
 *
 * `registerAdapter` 对同名协议会抛错（防止悄悄覆盖），但 bootstrap 在
 * 「检测到客户端形态」与「常规启动」两处都会调用本函数，测试里更是每个用例都调。
 * 所以这里先查已注册列表，已存在就跳过——配置 `hostFactory` 时也只在首次生效，
 * 避免第二次注册被忽略后宿主实例与引擎实例脱钩。
 */
export function registerBuiltinAdapters(options: RegisterBuiltinOptions = {}): void {
  const existing = new Set(listAdapterProtocols());
  if (!existing.has('mock')) {
    registerAdapter('mock', (async (raw) => buildMockAdapter(raw as MockAdapterOptions)) as AdapterFactory);
  }
  if (!existing.has('http-webhook')) {
    registerAdapter(
      'http-webhook',
      (async (raw) => buildWebhookAdapter(raw as WebhookAdapterOptions)) as AdapterFactory,
    );
  }
  if (!existing.has('host')) {
    const factory: AdapterFactory =
      options.hostFactory ??
      ((async (raw) =>
        createHostAdapter(raw as HostAdapterOptions, options.hostGateway, options.hostBridge)) as AdapterFactory);
    registerAdapter('host', factory);
  }
}
