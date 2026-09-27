import { pino, type Logger } from 'pino';
import { EventBus } from '../core/events.js';
import { Store } from '../core/store.js';
import { pick, toMillis } from '../core/registry.js';
import { getAdapterFactory } from '../core/registry.js';
import { filterTokens, normalizeText, summarize, tokenize } from '../core/text.js';
import type { AppConfig } from '../core/config.js';
import type { EngineContext } from '../core/context.js';
import type { NormalizedMessage, ProtocolAdapter, RawEvent, SenderInfo } from '../core/types.js';
import { resolvePluginOrder, type Plugin } from '../core/plugin.js';
import type { AdapterDeps } from '../core/registry.js';

/**
 * 引擎运行时。
 *
 * 数据流：适配器 → `#onRawEvent`（归一化 + 去重）→ `Store.insertMessage`（落库 + 预聚合）
 * → `EventBus.emit('message')` → 插件订阅者（统计、风控、AI、面板）。
 *
 * 关键设计：归一化与落库在引擎内完成，插件不接触原始协议数据。
 * 这样「消息计数口径」只有一处实现在改，报表与风控不会算出不同数字。
 */

export interface EngineOptions {
  config: AppConfig;
  plugins?: Plugin[];
  logger?: Logger;
  /** 注入 store（测试用内存库）。 */
  store?: Store;
  /** 注入客户端宿主句柄；客户端形态下插件靠它做原生通知/角标/导出。 */
  client?: unknown;
}

export interface EngineStats {
  received: number;
  accepted: number;
  duplicates: number;
  failed: number;
  startedAt: number;
  adapters: string[];
  listeners: number;
}

/**
 * 判定会话类型。
 *
 * 显式声明优先（`group`/`chatroom`/`private`/`single`），否则看群 ID 特征：
 * 微信群的 ID 以 `@chatroom` 结尾，企业微信群以 `@` 或 `R:` 开头。
 */
export function resolveConversationKind(payload: unknown, conversationId: string): 'group' | 'private' | 'official' {
  const declared = String(pick<string>(payload, 'conversationKind', 'chatType', 'roomType') ?? '').toLowerCase();
  if (declared.includes('group') || declared.includes('chatroom') || declared === 'room') return 'group';
  if (declared.includes('private') || declared.includes('single') || declared.includes('contact')) return 'private';
  if (declared.includes('official') || declared.includes('gh_')) return 'official';

  if (conversationId.endsWith('@chatroom')) return 'group';
  if (/^R:|@im\.biz/.test(conversationId)) return 'group';
  return 'group';
}

export class Engine {
  readonly bus: EventBus;
  readonly store: Store;
  readonly logger: Logger;
  readonly config: AppConfig;

  #adapters = new Map<string, ProtocolAdapter>();
  #plugins: Plugin[];
  #context: EngineContext;
  #stats: EngineStats;
  #started = false;
  /** 幂等去重窗口：协议重连/重投会重复推送同一消息。 */
  #dedupe = new Set<string>();
  #dedupeOrder: string[] = [];
  #dedupeLimit = 20_000;

  constructor(options: EngineOptions) {
    this.config = options.config;
    this.logger = options.logger ?? pino({ level: options.config.logLevel });
    this.store =
      options.store ??
      new Store({ path: options.config.storage.sqlitePath, wal: options.config.storage.wal });
    this.#plugins = options.plugins ?? [];
    this.#stats = {
      received: 0,
      accepted: 0,
      duplicates: 0,
      failed: 0,
      startedAt: Date.now(),
      adapters: [],
      listeners: 0,
    };

    this.bus = new EventBus((error) => {
      this.#stats.failed += 1;
      this.logger.error(
        { subscriber: error.subscriber, event: error.event.name, err: error.error },
        '订阅者处理事件失败',
      );
      // 转发给 engine.error，让运维插件（如告警）能感知，同时不打破当前派发。
      this.bus.emit('engine.error', error);
    });

    this.#context = {
      config: this.config,
      logger: this.logger,
      bus: this.bus,
      store: this.store,
      adapters: this.#adapters,
      sendMessage: (conversationId, text) => this.sendMessage(conversationId, text),
      ...(options.client ? { client: options.client } : {}),
    } as EngineContext;
  }

  get context(): EngineContext {
    return this.#context;
  }

  get stats(): EngineStats {
    return { ...this.#stats, listeners: this.bus.listenerCount() };
  }

  /** 构建适配器实例。配置里 `enabled: false` 的会被跳过。 */
  async createAdapters(): Promise<void> {
    const deps: AdapterDeps = {
      logger: this.logger,
      sendMessage: (conversationId, text) => this.sendMessage(conversationId, text),
    };
    for (const adapterConfig of this.config.adapters) {
      if (!adapterConfig.enabled) continue;
      const factory = getAdapterFactory(adapterConfig.protocol);
      if (!factory) {
        // 配置了一个不存在的协议：启动即失败，比运行时才发现收不到消息好。
        throw new Error(`未知适配器协议: ${adapterConfig.protocol}`);
      }
      const adapter = await factory(adapterConfig.options, deps);
      this.#adapters.set(adapter.name, adapter);
    }
    this.#stats.adapters = [...this.#adapters.keys()];
  }

  /** 注册插件：按依赖排序后 `setup` + 订阅 + `start`。 */
  async registerPlugins(plugins: readonly Plugin[] = this.#plugins): Promise<void> {
    const ordered = resolvePluginOrder(plugins);
    this.logger.info({ plugins: ordered.map((p) => p.manifest.name) }, '插件启动顺序');
    for (const plugin of ordered) {
      const options =
        this.config.plugins.find((item) => item.name === plugin.manifest.name)?.options ?? {};
      await plugin.setup?.(this.#context, options);
      for (const subscription of plugin.subscriptions?.(this.#context) ?? []) {
        // 订阅 key 用「插件名:事件名」：卸载插件时可一次性摘掉全部监听。
        this.bus.on(subscription.event, `${plugin.manifest.name}:${subscription.event}`, (event) =>
          subscription.handle(event.payload),
        );
      }
      await plugin.start?.(this.#context);
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#adapters.size === 0) await this.createAdapters();
    await this.registerPlugins();
    for (const adapter of this.#adapters.values()) {
      await adapter.start((event) => this.#onRawEvent(event));
      this.logger.info({ adapter: adapter.name }, '适配器已启动');
    }
    this.#started = true;
  }

  async stop(): Promise<void> {
    for (const adapter of this.#adapters.values()) {
      await adapter.stop().catch((error: unknown) => {
        this.logger.warn({ adapter: adapter.name, err: error }, '适配器停止失败');
      });
    }
    for (const plugin of resolvePluginOrder(this.#plugins).reverse()) {
      try {
        await plugin.stop?.();
      } catch (error) {
        this.logger.warn({ plugin: plugin.manifest.name, err: error }, '插件停止失败');
      }
    }
    this.#started = false;
  }

  /** 主动发送：优先用支持 send 的适配器，全部失败返回 false。 */
  async sendMessage(conversationId: string, text: string): Promise<boolean> {
    for (const adapter of this.#adapters.values()) {
      if (!adapter.capabilities.has('send') || !adapter.send) continue;
      const ok = await adapter.send(conversationId, { kind: 'text', text }).catch(() => false);
      if (ok) return true;
    }
    return false;
  }

  /**
   * 原始事件入口（公开）。
   *
   * 适配器之外还有两类调用方需要它：
   * - `HostTransport` 在进程内直接投递（跳过 HTTP，也跳过适配器的 `start` 回调绑定）
   * - 测试要构造任意原始事件，而不必启动一个真适配器
   *
   * 保持单一实现是关键：任何绕开它的旁路都会让「归一化/去重/预聚合」出现第二套口径。
   */
  async ingestRaw(event: RawEvent): Promise<void> {
    await this.#onRawEvent(event);
  }

  /** 处理原始事件：只接受 `message` 类事件，其余事件类型直接转发。 */
  async #onRawEvent(event: RawEvent): Promise<void> {
    this.#stats.received += 1;
    if (event.type !== 'message') {
      // 事件类型由适配器经 `normalizeEventType` 收敛到有限集合。已知的走专用事件，
      // 未知的走 `raw` 透传——枚举注定追不上所有协议的专属事件，
      // 直接丢弃会让「好友申请」「群公告变更」这类事件永远无法被插件处理。
      const payload = { protocol: event.protocol, payload: event.payload, at: event.receivedAt };
      if (
        event.type === 'message.revoked' ||
        event.type === 'member.join' ||
        event.type === 'member.leave'
      ) {
        this.bus.emit(event.type, payload);
      } else {
        this.bus.emit('raw', { ...payload, type: event.type });
      }
      // 自检探针到此为止：计入 `received`（说明链路通）后即返回，
      // **绝不落库**——否则每次健康检查都会给统计加一条假消息。
      return;
    }

    const message = this.normalize(event);
    if (!message) {
      this.#stats.failed += 1;
      return;
    }

    const dedupeKey = `${message.id}`;
    if (this.#dedupe.has(dedupeKey)) {
      this.#stats.duplicates += 1;
      return;
    }
    this.#remember(dedupeKey);

    const tokens = filterTokens(
      tokenize(normalizeText(message.text)),
      new Set(this.config.analytics.stopWords),
    );
    const inserted = this.store.insertMessage(message, tokens, this.#bucketSize());
    if (!inserted) {
      this.#stats.duplicates += 1;
      return;
    }

    this.#stats.accepted += 1;
    this.bus.emit('message', message);
  }

  /**
   * 归一化。
   *
   * `payload` 可能是适配器已映射过的字段集，也可能是裸协议负载；
   * 两条路径都在这里收口，保证插件永远看到同一种结构。
   */
  normalize(event: RawEvent): NormalizedMessage | null {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return null;

    const conversationId =
      pick<string>(payload, 'conversationId', 'conversation.id', 'roomId', 'groupId') ?? '';
    const senderId = pick<string>(payload, 'senderId', 'sender.id', 'fromUser') ?? '';
    // 缺会话或发送者的消息无法归属，丢弃并计数；静默接受会污染统计分母。
    if (!conversationId || !senderId) return null;

    const receivedAt = toMillis(pick(payload, 'timestamp'), event.receivedAt);
    const text = String(pick<string>(payload, 'text', 'content') ?? '');
    const kind = (pick<string>(payload, 'kind') ?? 'text') as NormalizedMessage['kind'];
    const id =
      pick<string>(payload, 'id', 'msgId', 'messageId') ??
      // 无消息 ID 的协议用「会话+发送者+时间+内容摘要」拼稳定 ID，
      // 保证重投时仍能去重，又不与其它消息碰撞。
      `${conversationId}:${senderId}:${receivedAt}:${text.slice(0, 32)}`;

    const sender: SenderInfo = {
      id: senderId,
      displayName: String(pick<string>(payload, 'senderName', 'sender.displayName') ?? senderId),
    };
    const groupAlias = pick<string>(payload, 'groupAlias', 'sender.groupAlias');
    if (groupAlias) sender.groupAlias = groupAlias;

    // 会话类型判定优先级：协议显式声明 > 群 ID 特征 > 默认群聊。
    // 默认取群聊：本引擎服务于群运营，把私聊误判成群聊只是多一条统计，
    // 反过来的误判会让风控与统计整体失效。
    const conversationKind = resolveConversationKind(payload, conversationId);

    const mentionsRaw = pick<unknown>(payload, 'mentions');
    const mentions = Array.isArray(mentionsRaw)
      ? mentionsRaw.map((item) => String(item))
      : typeof mentionsRaw === 'string'
        ? mentionsRaw.split(',').filter(Boolean)
        : [];

    const message: NormalizedMessage = {
      id,
      conversation: {
        id: conversationId,
        kind: conversationKind as NormalizedMessage['conversation']['kind'],
        name: String(pick<string>(payload, 'conversationName') ?? conversationId),
      },
      sender,
      kind,
      direction: pick<string>(payload, 'direction') === 'outbound' ? 'outbound' : 'inbound',
      timestamp: receivedAt,
      text,
      summary: text ? summarize(text) : `[${kind}]`,
      mentions,
    };

    const ownerId = pick<string>(payload, 'ownerId');
    if (ownerId) message.conversation.ownerId = ownerId;
    const memberCount = pick<number>(payload, 'memberCount');
    if (typeof memberCount === 'number') message.conversation.memberCount = memberCount;
    const quoteId = pick<string>(payload, 'quoteId');
    if (quoteId) message.quoteId = quoteId;
    const mediaUrl = pick<string>(payload, 'mediaUrl');
    if (mediaUrl) message.mediaUrl = mediaUrl;
    message.raw = payload;

    return message;
  }

  /**
   * 记忆窗口大小：把小时级桶聚合到配置的粒度。
   * 抽取成方法而非内联，是因为插入与查询必须用同一口径，否则报表会与热力图对不上。
   */
  #bucketSize(): number {
    const buckets = this.config.analytics.hourlyBuckets;
    return Math.max(3_600_000, Math.floor(86_400_000 / buckets));
  }

  /** FIFO 去重集合：只保留最近 N 个 key，避免长跑内存无限增长。 */
  #remember(key: string): void {
    this.#dedupe.add(key);
    this.#dedupeOrder.push(key);
    if (this.#dedupeOrder.length > this.#dedupeLimit) {
      const oldest = this.#dedupeOrder.shift();
      if (oldest) this.#dedupe.delete(oldest);
    }
  }
}
