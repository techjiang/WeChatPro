/**
 * 微信 PC 客户端插件壳参考实现。
 *
 * 用法：把本文件编译后设为 `WECHATPRO_HOST_SHELL=/abs/path/host-shell.js`，
 * 再用 `wechatpro client --config examples/config.client.json` 启动。
 *
 * 三条必须遵守的约定（都是踩过坑总结出来的）：
 *
 * 1. **能力要么真实现，要么不写**。`HostBridge` 靠「是不是函数」判断能力可用，
 *    写成空函数会让引擎以为能力存在然后静默失效。所以下面每个能力都用
 *    `Object.assign` 条件挂载。
 * 2. **`inject()` 要原样传客户端的消息对象**，不要在壳里做字段转换——
 *    转换规则由 `host` 适配器的 `mapping` 统一负责，否则口径会分叉。
 * 3. **壳不能让回调抛错**。引擎侧已做错误隔离，但壳抛错会打断客户端的消息循环。
 */

import { bridgeFromShell, createClientHost, type ClientShellApi } from '../src/index.js';
import type { HostIngestPayload } from '../src/index.js';

/** 客户端注入的全局对象：不同插件框架名字不同，这里按需替换。 */
interface ClientGlobal {
  /** 客户端主进程/渲染进程提供的原生 API。 */
  wechatProHost?: {
    notify(options: { title: string; body: string; onClick?: () => void }): void;
    setBadge(count: number): void;
    setTitleBadge(text: string): void;
    showPanel(route?: string): void;
    toast(message: string, level?: string): void;
    openExternal(url: string): boolean;
    send(request: { conversationId: string; kind: string; text?: string }): boolean;
    contacts(conversationId?: string): Promise<Array<{ id: string; displayName: string; conversationId?: string }>>;
    pickFile(): Promise<string | null>;
    saveFile(filename: string, content: string): Promise<string | null>;
    /** 客户端消息钩子：收到消息 / 发出消息时回调。 */
    onMessage(handler: (payload: HostIngestPayload) => void): void;
    /** 点击插件入口。 */
    onActivate(handler: () => void): void;
    /** 卸载插件前。 */
    onUnload(handler: () => void): void;
    readClipboard(): Promise<string>;
    writeClipboard(text: string): Promise<boolean>;
  };
}

const globalScope = globalThis as unknown as ClientGlobal;
const native = globalScope.wechatProHost;

if (!native) {
  throw new Error('未找到客户端原生 API（globalThis.wechatProHost），插件壳无法运行');
}

/** 把客户端原生 API 适配成 HostBridge：缺失的能力直接不挂，交给引擎降级。 */
const shell: ClientShellApi = {
  notifyNative: (options) => native.notify(options),
  setBadgeNative: (count) => native.setBadge(count),
  setTitleBadgeNative: (text) => native.setTitleBadge(text),
  showPanelNative: (route) => native.showPanel(route),
  toastNative: (message, level) => native.toast(message, level),
  openExternalNative: (url) => native.openExternal(url),
  sendNative: (request) => native.send(request),
  contactsNative: (conversationId) => native.contacts(conversationId),
  pickFileNative: () => native.pickFile(),
  saveFileNative: (filename, content) => native.saveFile(filename, content),
};

const client = createClientHost({ host: 'wechat-pc', panelRoute: '#/dashboard' });
client.attachHost(
  bridgeFromShell(shell, {
    host: 'wechat-pc',
    hostVersion: '3.9.x',
    pluginVersion: '0.2.0',
  }),
);

/* ── 启动引擎 ─────────────────────────────────────────────
 * 真实插件里应该调用自己的 bootstrap（把 client 传进去）：
 *
 *   const { engine, start, stop } = await bootstrap({ clientMode: true, hostBridge: ... });
 *   await start();
 *
 * 这里只演示「消息从哪来、面板怎么开」这两件壳必须做的事。
 * ------------------------------------------------------- */

/** 客户端收到一条消息 → 投进引擎。真实实现里这是 per-message 的热路径。 */
export async function onClientMessage(payload: HostIngestPayload): Promise<void> {
  const result = await client.ingest(payload);
  if (!result.accepted) {
    // 畸形消息只记录不重试：重试也不会变好，而重试风暴会拖慢客户端。
    console.warn('[WeChatPro] 消息未入库', result.reason);
  }
}

/** 客户端首次连接时补历史，避免「刚装好插件但报表是空的」。 */
export async function backfill(history: readonly HostIngestPayload[]): Promise<void> {
  const result = await client.ingestBatch(history);
  console.info(`[WeChatPro] 历史回填：入库 ${result.accepted}，丢弃 ${result.dropped}`);
}

/* ── 注册到客户端 ────────────────────────────────────────── */
native.onMessage((payload) => {
  void onClientMessage(payload).catch((error) => console.error('[WeChatPro] 处理失败', error));
});

native.onActivate(() => {
  // 点插件入口：打开面板并清角标，由客户端决定用右侧栏还是独立窗口渲染。
  void client.focus();
});

native.onUnload(() => {
  // 卸载前落盘由引擎的 stop() 负责；这里只提示客户端可以释放资源。
  console.info('[WeChatPro] 插件已卸载');
});

/** 插件内其它模块想拿宿主能力时，统一从这里取。 */
export { client, shell, native };
