/**
 * 宿主反向调用桥。
 *
 * 背景：WeChatPro 默认是「引擎主动、协议被动」——引擎监听 HTTP，等协议中间件推消息。
 * 但 PC 端插件是反过来：宿主（微信 PC 客户端 / 企业微信 / Electron 壳）进程内嵌引擎，
 * **宿主本身才是数据源**，它按自己的节奏把消息递进来，同时要求引擎能反向调用宿主能力
 * （在微信里弹原生通知、把面板投到客户端窗口、读客户端通讯录、执行客户端级动作）。
 *
 * 这套「反向调用」如果直接用 `import` 或事件总线做，会带来两个问题：
 *
 * 1. 引擎的领域层会反向依赖宿主实现，离线跑不起来，也没法单测；
 * 2. 宿主版本千差万别（不同微信版本 API 不同），把差异写进领域层等于把维护成本乘上版本数。
 *
 * 所以这里定义一份**能力契约**（`HostBridge`），引擎只按能力名调用，宿主按能力名注册。
 * 缺能力时必须降级而不是抛错：宿主没提供 `notify` 就只落库告警，没提供 `setBadge`
 * 就不显示角标。任何「缺了某个宿主 API 就让整条链路失败」的设计在 PC 插件场景都是事故。
 */

/** 宿主可提供的能力名。新增能力只加这里 + 类型映射，不动调用点。 */
export const HOST_CAPABILITIES = [
  'notify',
  'setBadge',
  'setTitleBadge',
  'openPanel',
  'toast',
  'openExternal',
  'pickFile',
  'exportFile',
  'readClipboard',
  'writeClipboard',
  'contacts',
  'nativeSend',
  'shutdown',
] as const;

export type HostCapability = (typeof HOST_CAPABILITIES)[number];

export interface HostNotifyOptions {
  title: string;
  body: string;
  level?: 'info' | 'warn' | 'error';
  /** 点击通知后要跳转的面板路由，如 `#/guard`。 */
  route?: string;
  /** 去重键：同一 key 在窗口期内只弹一次，避免刷屏告警把宿主通知队列打爆。 */
  dedupeKey?: string;
}

export interface HostContact {
  id: string;
  displayName: string;
  /** 所属群 ID，通讯录来自群成员列表时填充。 */
  conversationId?: string;
  alias?: string;
}

export interface HostSendRequest {
  conversationId: string;
  kind: 'text' | 'image' | 'file';
  text?: string;
  mediaUrl?: string;
  mentions?: string[];
}

/**
 * 宿主桥接口。
 *
 * 所有方法可选：`undefined` 表示宿主不提供该能力，调用方必须自己降级。
 * 用 `Partial` 而不是把能力拆成多个接口，是为了让宿主只写一个对象字面量。
 */
export interface HostBridge {
  /** 宿主标识，如 `wechat-pc`、`wecom-pc`、`electron`。 */
  readonly host: string;
  /** 宿主版本，用于排障与能力探测。 */
  readonly hostVersion?: string;
  /** 插件版本。 */
  readonly pluginVersion?: string;
  notify?(options: HostNotifyOptions): void | Promise<void>;
  /** 在客户端会话列表/头像上显示未读角标数量。 */
  setBadge?(count: number): void | Promise<void>;
  /** 在客户端标题或插件入口上显示角标文本，如 `12`、`!`。 */
  setTitleBadge?(text: string): void | Promise<void>;
  /** 让宿主把内置面板展示到客户端窗口（右侧栏 / 独立窗口 / 侧边浏览器）。 */
  openPanel?(route?: string): void | Promise<void>;
  /** 轻提示，不打断操作。 */
  toast?(message: string, level?: 'info' | 'warn' | 'error'): void | Promise<void>;
  /** 用系统默认浏览器打开链接（群规里的文档、GitHub 等）。 */
  openExternal?(url: string): boolean | Promise<boolean>;
  /** 弹宿主原生文件选择器，返回本地路径（导入规则/词表/知识库）。 */
  pickFile?(options?: { title?: string; filters?: string[] }): Promise<string | null>;
  /** 让宿主弹出保存对话框并写入内容（导出群档案、风控报告）。 */
  exportFile?(options: { filename: string; content: string }): Promise<string | null>;
  readClipboard?(): Promise<string>;
  writeClipboard?(text: string): Promise<boolean>;
  /** 读宿主通讯录/群成员，用于把消息里的 @ 昵称映射成稳定 ID。 */
  contacts?(conversationId?: string): Promise<HostContact[]>;
  /** 走宿主原生发送通道（本地 hook / 客户端内部接口）。 */
  nativeSend?(request: HostSendRequest): Promise<boolean>;
  /** 请求宿主优雅退出插件（卸载前落盘）。 */
  shutdown?(): void | Promise<void>;
}

/**
 * 一次宿主调用的结果。
 *
 * `ok: false` 且没有 `error` 表示「宿主没提供该能力」；
 * 有 `error` 表示「提供了但调用失败」。两者对排障的含义完全不同。
 */
export interface HostCallResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

/** 宿主桥实现：记录「谁注册了什么能力」，并对调用做统一降级与错误隔离。 */
export class HostGateway {
  #bridge: HostBridge = { host: 'none' };
  #calls = new Map<HostCapability, { ok: number; failed: number }>();
  #dedupe = new Map<string, number>();
  #dedupeWindowMs: number;

  constructor(options: { dedupeWindowMs?: number } = {}) {
    this.#dedupeWindowMs = options.dedupeWindowMs ?? 60_000;
  }

  /**
   * 挂载（或替换）宿主桥。
   *
   * 替换会清空通知去重窗口：新宿主实例是新的生命周期起点，沿用旧窗口会出现
   * 「刚重载完插件，第一批告警全被静默吃掉」——这类问题只在热重载时暴露，
   * 排查成本极高，所以在源头就规避。
   */
  attach(bridge: HostBridge): void {
    if (this.#bridge.host !== bridge.host) this.#dedupe.clear();
    this.#bridge = bridge;
  }

  detach(): void {
    this.#bridge = { host: 'none' };
    this.#dedupe.clear();
  }

  /** 清空通知去重窗口。引擎重启 / 测试用例之间需要它。 */
  resetDedupe(): void {
    this.#dedupe.clear();
  }

  /**
   * 调整通知去重窗口。
   *
   * 窗口在构造时定死，而它来自配置；配置改了却要重启插件才生效，
   * 属于「改了没反应」的典型。这里允许运行时对齐，并且顺带清空窗口——
   * 新旧窗口混用会让「刚调小窗口、上一条就压住了新告警」再次出现。
   */
  setDedupeWindow(windowMs: number): void {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return;
    this.#dedupeWindowMs = windowMs;
    this.#dedupe.clear();
  }

  /** 当前去重窗口（毫秒），排障与测试用。 */
  get dedupeWindowMs(): number {
    return this.#dedupeWindowMs;
  }

  get host(): string {
    return this.#bridge.host;
  }

  get hostVersion(): string | undefined {
    return this.#bridge.hostVersion;
  }

  get pluginVersion(): string | undefined {
    return this.#bridge.pluginVersion;
  }

  /** 当前宿主实际提供的能力列表，`doctor` 与面板直接展示。 */
  capabilities(): HostCapability[] {
    return HOST_CAPABILITIES.filter((name) => this.has(name));
  }

  /**
   * 宿主是否注册了该能力。
   *
   * 判断依据是「是不是函数」而不是「有没有这个字段」：客户端插件壳常见做法是
   * 定义一堆可选方法但只实现一部分，用字段存在性判断会把空实现误判为可用能力。
   */
  has(capability: HostCapability): boolean {
    return typeof (this.#bridge as unknown as Record<string, unknown>)[capability] === 'function';
  }

  /** 调用统计，排查「宿主明明提供了能力却没生效」时看这里。 */
  callStats(): Array<{ capability: HostCapability; ok: number; failed: number }> {
    return [...this.#calls.entries()].map(([capability, stat]) => ({ capability, ...stat }));
  }

  /**
   * 统一调用入口。
   *
   * 返回值是三态，而不是 `T | undefined` 的两态：
   *
   * - `{ ok: false }`           宿主没提供这个能力
   * - `{ ok: false, error }`    宿主提供了但抛错了
   * - `{ ok: true, value }`     调用成功（`value` 允许是 `undefined`，那是合法结果）
   *
   * 之所以不能只用返回值判空：很多宿主能力（`openPanel`、`setBadge`、`notify`）
   * 本来就不返回值，返回 `undefined` 与「能力缺失」无法区分，
   * 于是「弹了通知」会被记成「没有通知能力」。这类误判不会报错，只会让功能静默失灵。
   */
  async invoke<T>(
    capability: HostCapability,
    run?: (bridge: HostBridge) => unknown,
  ): Promise<HostCallResult<T>> {
    const fn = (this.#bridge as unknown as Record<string, unknown>)[capability];
    if (typeof fn !== 'function') return { ok: false };
    const stat = this.#calls.get(capability) ?? { ok: 0, failed: 0 };
    this.#calls.set(capability, stat);
    try {
      const value: unknown = run ? await run(this.#bridge) : await (fn as () => unknown).call(this.#bridge);
      stat.ok += 1;
      return { ok: true, value: value as T };
    } catch (error) {
      stat.failed += 1;
      return { ok: false, error };
    }
  }

  async notify(options: HostNotifyOptions): Promise<boolean> {
    if (options.dedupeKey && this.#isDuplicate(options.dedupeKey)) return false;
    return (await this.invoke('notify', (bridge) => bridge.notify?.(options))).ok;
  }

  async setBadge(count: number): Promise<boolean> {
    return (await this.invoke('setBadge', (bridge) => bridge.setBadge?.(count))).ok;
  }

  async setTitleBadge(text: string): Promise<boolean> {
    return (await this.invoke('setTitleBadge', (bridge) => bridge.setTitleBadge?.(text))).ok;
  }

  async toast(message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<boolean> {
    return (await this.invoke('toast', (bridge) => bridge.toast?.(message, level))).ok;
  }

  async openPanel(route?: string): Promise<boolean> {
    return (await this.invoke('openPanel', (bridge) => bridge.openPanel?.(route))).ok;
  }

  /** 打开外链：只放行 http(s)，`file:`/`javascript:` 一律拒绝。 */
  async openExternal(url: string): Promise<boolean> {
    if (!/^https?:\/\//i.test(url)) return false;
    const result = await this.invoke<boolean>('openExternal', (bridge) => bridge.openExternal?.(url));
    return result.ok;
  }

  async pickFile(options?: { title?: string; filters?: string[] }): Promise<string | null> {
    const result = await this.invoke<string | null>('pickFile', (bridge) => bridge.pickFile?.(options));
    return result.ok ? (result.value ?? null) : null;
  }

  async exportFile(options: { filename: string; content: string }): Promise<string | null> {
    const result = await this.invoke<string | null>('exportFile', (bridge) => bridge.exportFile?.(options));
    return result.ok ? (result.value ?? null) : null;
  }

  async readClipboard(): Promise<string | null> {
    const result = await this.invoke<string>('readClipboard', (bridge) => bridge.readClipboard?.());
    return result.ok ? (result.value ?? null) : null;
  }

  async writeClipboard(text: string): Promise<boolean> {
    return (await this.invoke('writeClipboard', (bridge) => bridge.writeClipboard?.(text))).ok;
  }

  async contacts(conversationId?: string): Promise<HostContact[]> {
    const result = await this.invoke<HostContact[]>('contacts', (bridge) => bridge.contacts?.(conversationId));
    return result.ok ? (result.value ?? []) : [];
  }

  async nativeSend(request: HostSendRequest): Promise<boolean> {
    return (await this.invoke('nativeSend', (bridge) => bridge.nativeSend?.(request))).ok;
  }

  /** 同一 dedupeKey 在窗口内只放行一次。窗口外重新放行，避免永久静音。 */
  #isDuplicate(key: string): boolean {
    const now = Date.now();
    const last = this.#dedupe.get(key);
    if (last !== undefined && now - last < this.#dedupeWindowMs) return true;
    this.#dedupe.set(key, now);
    // 顺手清理过期项，长跑进程里这个 map 会无限增长。
    if (this.#dedupe.size > 5_000) {
      for (const [k, at] of this.#dedupe) if (now - at > this.#dedupeWindowMs) this.#dedupe.delete(k);
    }
    return false;
  }
}
