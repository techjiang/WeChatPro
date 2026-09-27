/**
 * WeChatPro 领域模型。
 *
 * 这里的类型是整套引擎的公共契约：协议适配器负责把各家微信协议（本地 hook、
 * 云托管网关、企业微信 Webhook…）归一化成这些结构，下游统计/检测/AI 模块
 * 只依赖这里，从而与具体协议解耦。
 */

/** 微信侧消息类型。未知类型统一落到 `unknown`，避免新协议类型导致适配器抛错。 */
export type MessageKind =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'link'
  | 'location'
  | 'card'
  | 'sticker'
  | 'system'
  | 'revoke'
  | 'redpacket'
  | 'transfer'
  | 'unknown';

/** 会话类型。群聊统计与风控主要作用于 `group`。 */
export type ConversationKind = 'group' | 'private' | 'official';

/** 事件来源方向，用于区分「自己发的」与「别人发的」。 */
export type MessageDirection = 'inbound' | 'outbound';

export interface SenderInfo {
  /** 协议侧稳定 ID（wxid / 企业微信 userid）。 */
  id: string;
  /** 群内展示名，可能随群昵称变化。 */
  displayName: string;
  /** 群昵称（若与 `displayName` 不同，适配器两者都给）。 */
  groupAlias?: string;
  /** 备注名。 */
  alias?: string;
}

export interface ConversationInfo {
  id: string;
  kind: ConversationKind;
  /** 群名或联系人名。 */
  name: string;
  /** 群主 ID，私聊时为空。 */
  ownerId?: string;
  memberCount?: number;
}

/**
 * 归一化后的消息。所有下游模块的输入都长这样。
 *
 * `timestamp` 统一为毫秒时间戳；协议给秒级时间戳时由适配器换算。
 * 统计口径依赖 `timestamp` 单调可信，适配器必须优先取服务端时间。
 */
export interface NormalizedMessage {
  /** 协议侧消息 ID，用于幂等去重。缺失时适配器需自行生成稳定 ID。 */
  id: string;
  conversation: ConversationInfo;
  sender: SenderInfo;
  kind: MessageKind;
  direction: MessageDirection;
  /** 毫秒时间戳。 */
  timestamp: number;
  /** 纯文本内容；非文本消息为空串，正文摘要见 `summary`。 */
  text: string;
  /** 非文本消息的可读摘要，如 `[图片]`、`[链接] 标题`。 */
  summary: string;
  /** @ 到的成员 ID 列表（含被 @ 的自己）。 */
  mentions: string[];
  /** 被回复消息的 ID。 */
  quoteId?: string;
  /** 媒体/文件 URL（若有）。 */
  mediaUrl?: string;
  /** 媒体资源的本地缓存路径，由 media 插件填充。 */
  localPath?: string;
  /** 协议原始负载，便于排障与协议特有字段兜底。 */
  raw?: unknown;
}

/** 原始事件：适配器收到的、尚未归一化的数据。 */
export interface RawEvent {
  /** 协议标识，如 `local-hook`、`gateway`。 */
  protocol: string;
  /** 事件名，如 `message`、`member.join`。 */
  type: string;
  receivedAt: number;
  payload: unknown;
}

/** 适配器向引擎投递事件的回调。 */
export type RawEventHandler = (event: RawEvent) => void | Promise<void>;

/**
 * 协议适配器接口。
 *
 * 生命周期：`start()` → 持续投递事件 → `stop()`。适配器需自行处理重连，
 * 重连期间的重复投递由引擎的去重层兜底，适配器不必保证 exactly-once。
 */
export interface ProtocolAdapter {
  readonly name: string;
  /** 该适配器支持的能力，引擎据此决定启用哪些插件。 */
  readonly capabilities: ReadonlySet<AdapterCapability>;
  start(handler: RawEventHandler): Promise<void>;
  stop(): Promise<void>;
  /** 主动发送消息。适配器不支持主动发送时返回 `false`。 */
  send?(conversationId: string, message: OutboundMessage): Promise<boolean>;
}

export type AdapterCapability =
  | 'receive'
  | 'send'
  | 'revoke'
  | 'member-events'
  | 'history'
  | 'contact';

export interface OutboundMessage {
  kind: Exclude<MessageKind, 'system' | 'revoke' | 'unknown'>;
  text: string;
  mentions?: string[];
  mediaUrl?: string;
}
