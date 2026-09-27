import { HostGateway, type HostBridge, type HostCapability } from '../core/host-bridge.js';
import { createHostAdapter, type HostIngestPayload, type HostTransport } from '../protocols/host.js';

/**
 * 客户端宿主提供方 —— 把「引擎」装进微信 PC 客户端。
 *
 * 这一层是 PC 端形态的粘合剂，只做三件事：
 *
 * 1. **持有宿主桥**：客户端插件壳把 `notify`/`setBadge`/`nativeSend` 等能力注册进来。
 * 2. **暴露注入口**：宿主收到消息后调用 `ingest()`，进入与 HTTP 完全相同的归一化管线。
 * 3. **暴露面板路由**：宿主点插件图标时调用 `openPanel()`，拿到「在客户端窗口里渲染什么」。
 *
 * 关键是它**不依赖具体客户端实现**：Electron 壳、原生 DLL 注入壳、辅助进程壳，
 * 差异全部收敛在宿主提供的 `HostBridge` 实现里，引擎与面板代码零改动。
 */

export interface ClientHostOptions {
  /** 宿主标识。 */
  host?: string;
  hostVersion?: string;
  /** 宿主桥实现；也可以稍后 `attachHost()`。 */
  bridge?: HostBridge;
  /** 字段映射覆盖值：换微信版本时只改这里。 */
  mapping?: Record<string, string[]>;
  /** 面板在客户端里的挂载路径，宿主打开时用它拼 URL/路由。 */
  panelRoute?: string;
  /**
   * 适配器选项覆盖值。
   * 例如把 `transport` 设为 `'http'`，宿主就改用本地 IPC 而不是进程内注入。
   */
  adapterOptions?: Partial<import('../protocols/host.js').HostAdapterOptions>;
}

export interface ClientHost {
  /** 宿主反向调用桥：引擎所有「往客户端里写字」的动作都走它，缺能力自动降级。 */
  gateway: HostGateway;
  /**
   * 宿主 -> 引擎的消息入口。
   *
   * 底层就是 `adapter.transport`，但**必须通过 getter 取**：适配器实例由引擎的
   * 注册表工厂创建（`Engine.createAdapters()`），而工厂可能被多次调用
   * （多适配器配置、测试重建）。如果这里持有一个提前造好的实例副本，
   * 引擎启动时绑定的是工厂造的那个，两边就指向不同对象，`inject()` 永远返回
   * `transport-off` —— 消息全被静默丢弃，而日志上看起来一切正常。
   * 这是本层最容易踩的坑，所以用 getter 而不是字段。
   */
  readonly transport: HostTransport;
  /** 适配器实例（惰性获取，永远指向引擎实际使用的那一个）。 */
  readonly adapter: ReturnType<typeof createHostAdapter>;
  host: string;
  panelRoute: string;
  /** 挂载/替换宿主桥。宿主启动完成、能力就绪后调用。 */
  attachHost(bridge: HostBridge): void;
  /** 客户端重连/插件热重载后调用：清掉通知去重窗口，避免告警被静默吞掉。 */
  resetHostState(): void;
  /** 投递一条宿主消息。返回结构化结果，宿主无需 try/catch。 */
  ingest(payload: HostIngestPayload, options?: { eventType?: string }): ReturnType<HostTransport['inject']>;
  /** 批量投递（例如宿主首次连接时补历史）。 */
  ingestBatch(payloads: readonly HostIngestPayload[]): ReturnType<HostTransport['injectBatch']>;
  /** 宿主点插件入口时：刷新角标 + 打开面板。 */
  focus(route?: string): Promise<{ opened: boolean; badge: boolean }>;
  /** 能力清单，面板「关于」页与 `doctor` 直接展示。 */
  capabilities(): HostCapability[];
}

export function createClientHost(options: ClientHostOptions = {}): ClientHost {
  const host = options.host ?? 'wechat-pc';
  const gateway = new HostGateway();
  if (options.bridge) gateway.attach(options.bridge);

  // 只保存「如何造适配器」，不提前造实例：实例必须由引擎的注册表工厂产生，
  // 否则会出现「引擎绑定了 A、client 注入到 B」的双实例静默丢消息问题。
  const adapterOptions = {
    host,
    transport: 'none',
    outbound: 'host',
    ...(options.mapping ? { mapping: options.mapping } : {}),
    ...(options.adapterOptions ?? {}),
  } satisfies import('../protocols/host.js').HostAdapterOptions;

  let cached: ReturnType<typeof createHostAdapter> | null = null;
  const resolveAdapter = (): ReturnType<typeof createHostAdapter> => {
    cached ??= createHostAdapter(adapterOptions, gateway);
    return cached;
  };

  const panelRoute = options.panelRoute ?? '#/dashboard';

  const clientHost: ClientHost = {
    gateway,
    get transport() {
      return resolveAdapter().transport;
    },
    get adapter() {
      return resolveAdapter();
    },
    host,
    panelRoute,
    attachHost(bridge: HostBridge): void {
      gateway.attach(bridge);
    },
    resetHostState(): void {
      // 宿主重连（客户端重启插件、开发时热重载）后清掉通知去重窗口，
      // 否则新会话的第一批告警会因为「上一条相同 key 刚弹过」被静默丢弃。
      gateway.resetDedupe();
    },
    ingest(payload, ingestOptions) {
      return clientHost.transport.inject(payload, ingestOptions ?? {});
    },
    ingestBatch(payloads) {
      return clientHost.transport.injectBatch(payloads);
    },
    async focus(route?: string) {
      const opened = await gateway.openPanel(route ?? panelRoute);
      // 打开面板意味着用户已经在看，角标必须清掉，否则下次还是要他再点一遍。
      const badge = await gateway.setBadge(0);
      return { opened, badge };
    },
    capabilities() {
      return gateway.capabilities();
    },
  };
  return clientHost;
}

/**
 * 客户端宿主插件壳的参考实现（供注入方案直接参考/复制）。
 *
 * 之所以放在仓库里而不是只写文档：注入壳是最容易写错的一层，
 * 一个可运行的参考实现比十页说明更能说明「契约长什么样」。
 */
export interface ClientShellApi {
  /** 客户端提供的原生通知。 */
  notifyNative?(options: { title: string; body: string; onClick?: () => void }): void;
  /** 客户端设置任务栏/会话列表角标。 */
  setBadgeNative?(count: number): void;
  /** 客户端设置插件入口角标文本。 */
  setTitleBadgeNative?(text: string): void;
  /** 客户端展示内嵌面板。 */
  showPanelNative?(route?: string): void;
  /** 客户端轻提示。 */
  toastNative?(message: string, level?: string): void;
  /** 客户端打开外链。 */
  openExternalNative?(url: string): boolean;
  /** 客户端原生发送。 */
  sendNative?(request: { conversationId: string; kind: string; text?: string }): boolean;
  /** 客户端读通讯录 / 群成员。 */
  contactsNative?(conversationId?: string): Promise<Array<{ id: string; displayName: string; conversationId?: string }>>;
  /** 客户端文件选择 / 保存。 */
  pickFileNative?(): Promise<string | null>;
  saveFileNative?(filename: string, content: string): Promise<string | null>;
}

/**
 * 把客户端原生 API 适配成 `HostBridge`。
 *
 * 每个方法都显式返回 `undefined` 而不是实现成空函数：`HostGateway.has()` 靠
 * 「是不是函数」判断能力，空函数会让引擎误以为能力可用，然后静默失效——
 * 这是注入壳里最典型也最难查的一类 bug。
 */
export function bridgeFromShell(shell: ClientShellApi, meta: { host?: string; hostVersion?: string; pluginVersion?: string } = {}): HostBridge {
  const bridge: HostBridge = {
    host: meta.host ?? 'wechat-pc',
    ...(meta.hostVersion ? { hostVersion: meta.hostVersion } : {}),
    ...(meta.pluginVersion ? { pluginVersion: meta.pluginVersion } : {}),
  };

  if (shell.notifyNative) {
    bridge.notify = (options) => {
      shell.notifyNative?.({
        title: options.title,
        body: options.body,
        ...(options.route ? { onClick: () => shell.showPanelNative?.(options.route) } : {}),
      });
    };
  }
  if (shell.setBadgeNative) bridge.setBadge = (count) => shell.setBadgeNative?.(count);
  if (shell.setTitleBadgeNative) bridge.setTitleBadge = (text) => shell.setTitleBadgeNative?.(text);
  if (shell.showPanelNative) bridge.openPanel = (route) => shell.showPanelNative?.(route);
  if (shell.toastNative) bridge.toast = (message, level) => shell.toastNative?.(message, level);
  if (shell.openExternalNative) bridge.openExternal = (url) => shell.openExternalNative?.(url) ?? false;
  if (shell.sendNative) bridge.nativeSend = async (request) => shell.sendNative?.(request) ?? false;
  if (shell.contactsNative) bridge.contacts = async (conversationId) => (await shell.contactsNative?.(conversationId)) ?? [];
  if (shell.pickFileNative) bridge.pickFile = async () => (await shell.pickFileNative?.()) ?? null;
  if (shell.saveFileNative) {
    bridge.exportFile = async (options) => (await shell.saveFileNative?.(options.filename, options.content)) ?? null;
  }
  return bridge;
}
