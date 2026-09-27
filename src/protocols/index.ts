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

export { buildMockAdapter, buildWebhookAdapter, mapPayload, coerceKind, toStringList, isOutbound } from './webhook.js';
export type { MockAdapterOptions, WebhookAdapterOptions } from './webhook.js';
export {
  createHostAdapter,
  HostTransport,
  WECHAT_PC_MAPPING,
  WECHAT_KIND_ALIASES,
  coerceHostKind,
  parseChatExport,
  dumpPayload,
  describeUnmapped,
  selfTestPayload,
} from './host.js';
export type { HostAdapterOptions, HostIngestPayload, IngestResult } from './host.js';

export interface RegisterBuiltinOptions {
  /** 宿主反向调用桥；只为 `host` 适配器注入。 */
  hostGateway?: HostGateway;
  /** 宿主桥实现；与 `hostGateway` 同时给出时，构造 `host` 适配器即挂载。 */
  hostBridge?: import('../core/host-bridge.js').HostBridge;
  /**
   * 当前宿主适配器提供方。
   *
   * 每次 `bootstrap()` 都会传入新的提供方，`host` 分发器在造适配器时读取它——
   * 这是「一个进程能安全地起多次客户端形态」的关键。
   *
   * 提供方应当**每次返回同一个实例**（`createClientHost()` 用 getter 保证了这点）。
   * 若它每次返回新对象，分发器会拒绝复用旧副本并重新构造——代价是旧实例上
   * 挂着的订阅者会变成孤儿（正是「日志正常、消息全丢」那个坑）。
   */
  hostProvider?: () => ReturnType<typeof createHostAdapter>;
  /**
   * 宿主提供方那侧实例的构造选项。
   *
   * 只在「选项一致」时才复用同一个适配器实例：同一个进程里可能既有客户端形态
   * 的宿主、又有 `import` 用的默认宿主，二者 mapping / transport 不同。
   * 不传时按「总是可复用」处理（宿主形态的常规情况）。
   */
  hostProviderOptions?: Record<string, unknown>;
  /**
   * 宿主适配器工厂（旧入口，保留兼容）。
   *
   * 语义等价于 `hostProvider: () => hostFactory(...)`，但**每次调用本函数都会生效**，
   * 与 `hostProvider` 一致。新代码请优先用 `hostProvider`。
   *
   * 注意：工厂必须**每次返回同一个实例**（由 `createClientHost` 保证）。
   * 消息入口 `inject()` 与引擎绑定的是同一个 `HostTransport`，工厂若每次新建实例，
   * 宿主注入的消息会落到没有订阅者的 transport 上，表现为「日志正常、消息全丢」。
   */
  hostFactory?: AdapterFactory;
}

/** 注册内置适配器。由 `bootstrap()` 调用一次，避免模块导入副作用。 */
/**
 * 当前活跃的客户端宿主提供方。
 *
 * 之所以需要这一层间接：适配器注册表是**模块级全局**（`registerAdapter` 会拒绝同名覆盖），
 * 而客户端形态下「一个进程一份插件」——宿主实例必须跟着 `bootstrap()` 走。
 * 如果首次注册就把 `hostFactory` 钉死，第二次 `bootstrap()` 建出的 `ClientHost`
 * 会持有一个只认第一个 host 的适配器，`inject()` 永远返回 `transport-off`：
 * **消息全丢，但日志一切正常**。宿主热重载、同进程多次启停、并行测试都会踩到。
 */
let hostProvider: (() => ReturnType<typeof createHostAdapter>) | null = null;

/** 旧入口 `hostFactory` 的留存位；同样每次 `registerBuiltinAdapters()` 都会被刷新。 */
let legacyHostFactory: AdapterFactory | null = null;

/** 宿主提供方那侧实例的选项指纹；未声明时按「与请求一致」处理，保持向后兼容。 */
let providerFingerprint: string | null = null;

/**
 * 注册（或替换）客户端宿主提供方。
 *
 * 由 `bootstrap()` 在客户端形态下调用。传 `null` 表示退出客户端形态。
 * 与 `registerBuiltinAdapters()` 相比，这里**每次调用都生效**，不做首次冻结。
 */
export function setHostProvider(
  provider: (() => ReturnType<typeof createHostAdapter>) | null,
  gateway?: HostGateway,
  bridge?: import('../core/host-bridge.js').HostBridge,
  providerOptions?: Record<string, unknown>,
): void {
  hostProvider = provider;
  providerFingerprint = providerOptions ? fingerprint(providerOptions) : null;
  if (gateway) {
    if (bridge) gateway.attach(bridge);
    setHostGateway(gateway);
  }
}

/** 宿主反向调用桥。引擎与面板的「往客户端写字」动作都经它。 */
let hostGateway: HostGateway | undefined;

function setHostGateway(gateway: HostGateway): void {
  hostGateway = gateway;
}

/**
 * 幂等注册。
 *
 * `registerAdapter` 对同名协议会抛错（防止悄悄覆盖），但 bootstrap 在
 * 「检测到客户端形态」与「常规启动」两处都会调用本函数，测试里更是每个用例都调，
 * 所以这里先查已注册列表，已存在就跳过。
 *
 * `host` 协议注册的是一个**分发器**而不是具体实例：真正用哪个宿主由
 * `setHostProvider()` 决定，因此后续 `bootstrap()` 能安全地替换它。
 * 直接把 `options.hostFactory` 注册成工厂是不行的——那样第二次起的宿主
 * 与引擎会脱钩（见 `setHostProvider` 注释）。
 */
export function registerBuiltinAdapters(options: RegisterBuiltinOptions = {}): void {
  if (options.hostProvider) hostProvider = options.hostProvider;
  // 兼容旧入口 `hostFactory`：同样每次生效，避免又一次「首次冻结」。
  if (options.hostFactory) legacyHostFactory = options.hostFactory;
  if (options.hostGateway) setHostGateway(options.hostGateway);

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
    // 分发器：延迟到真正造适配器时才读当前 provider，
    // 这样「先注册、后 bootstrap」与「多次 bootstrap」都能指向正确的宿主。
    const factory: AdapterFactory = async (raw, deps) => {
      const active = hostProvider?.();
      // 复用同一个实例的前提是**选项一致**：同一个进程里可能既有客户端形态、
      // 又有 `import` 用的默认 host 适配器，它们的 mapping / transport 不同。
      // 无条件复用会让后者拿到前者的 mapping，导入的数据按另一套字段名解析，
      // 表现为「导入 0 条」而日志毫无异常。
      if (active && matchesOptions(active, raw)) return active;
      if (legacyHostFactory) {
        const legacy = await legacyHostFactory(raw, deps);
        const legacyTransport = (legacy as { transport?: unknown }).transport;
        if (active && legacyTransport !== undefined && legacyTransport === active.transport) return active;
        return legacy;
      }
      const created = createHostAdapter(raw as HostAdapterOptions, hostGateway, options.hostBridge);
      adapterOptions.set(created, fingerprint(raw));
      return created;
    };
    registerAdapter('host', factory);
  }
}

/** 宿主适配器当时的构造选项（用于判断能否复用实例）。 */
const adapterOptions = new WeakMap<object, string>();

/** 选项指纹：只比对会改变行为的字段，宿主名与 mapping 不同就不能复用。 */
function fingerprint(options: Record<string, unknown>): string {
  const relevant = ['host', 'transport', 'httpPort', 'httpHost', 'httpPath', 'outbound', 'outboundUrl', 'dumpDir'];
  const picked: Record<string, unknown> = {};
  for (const key of relevant) if (options[key] !== undefined) picked[key] = options[key];
  if (options.mapping && typeof options.mapping === 'object') picked.mapping = options.mapping;
  return JSON.stringify(picked);
}

export function matchesOptions(
  adapter: ReturnType<typeof createHostAdapter>,
  raw: Record<string, unknown>,
): boolean {
  const declared = adapterOptions.get(adapter) ?? providerFingerprint;
  // 提供方没声明选项时按一致处理：宿主形态的默认选项就是引擎注入的那一套，
  // 过于保守会白白丢掉「复用 ⇒ 订阅者不孤儿」这个最重要的性质。
  return declared === null || declared === undefined ? true : declared === fingerprint(raw);
}


