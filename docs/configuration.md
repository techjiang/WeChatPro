# 配置项详解

配置为 JSON，可被环境变量覆盖部分字段。完整示例见 [`../config.example.json`](../config.example.json)。

```bash
node dist/cli.js check --config config.json   # 校验配置并打印解析结果
```

## 顶层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `logLevel` | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal`\|`silent` | `info` | 日志级别 |
| `storage` | object | — | 存储配置 |
| `adapters` | array | `[]` | 协议适配器列表 |
| `analytics` | object | — | 统计配置 |
| `guard` | object | — | 风控配置 |
| `ai` | object | — | AI 配置 |
| `manage` | object | — | 信息管理配置 |
| `api` | object | — | HTTP 控制台配置 |
| `client` | object | — | **PC 客户端宿主配置**（见下） |
| `plugins` | array | `[]` | 各插件的私有配置 |

## storage

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sqlitePath` | `./data/wechatpro.db` | 数据库路径，`:memory:` 为纯内存 |
| `wal` | `true` | 开启 WAL 提升并发读写 |

## adapters

```json
{
  "protocol": "host",
  "enabled": true,
  "options": { }
}
```

`options` 由各适配器自行定义。可选协议：`host`（PC 客户端，主形态）、`http-webhook`、`mock`。

### `host` — PC 客户端进程内注入

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `wechat-pc` | 宿主标识，仅用于展示与排障 |
| `mapping` | `WECHAT_PC_MAPPING` | 字段映射覆盖值；换微信版本只改这里 |
| `transport` | `none` | `none` = 进程内直投（推荐）；`http` = 本地 IPC 回环 |
| `httpHost` / `httpPort` / `httpPath` | `127.0.0.1` / 随机 / `/host/inject` | `transport=http` 时的监听参数 |
| `token` | — | `transport=http` 的校验令牌；**绑非回环地址必填** |
| `outbound` | `host` | 出站方式：`host` 走宿主原生发送，`http` 走 `outboundUrl` |
| `outboundUrl` | — | `outbound=http` 的目标地址 |
| `dumpDir` | — | 把收到的原始载荷按天落 NDJSON，排障用；默认关闭 |

默认字段映射（微信 PC 端字段名）：

| 归一化字段 | 默认候选 |
| --- | --- |
| `id` | `MsgSvrID`, `msgSvrId`, `LocalId`, `localId`, `id`, `msgId` |
| `conversationId` | `StrTalker`, `strTalker`, `TalkerId`, `conversationId`, `roomId` |
| `conversationName` | `RoomName`, `roomName`, `NickName`, `conversationName` |
| `senderId` | `StrSender`, `strSender`, `Sender`, `senderId`, `fromUser` |
| `senderName` | `SenderNick`, `senderNick`, `PushContent`, `senderName` |
| `text` | `StrContent`, `strContent`, `Content`, `text`, `msg` |
| `kind` | `Type`, `MsgType`, `msgType`, `kind`, `SubType` |
| `timestamp` | `CreateTime`（秒级，自动转毫秒）, `createTime`, `timestamp` |
| `direction` | `IsSender`, `isSender`, `direction` |

`Type` 取值映射：`1`→text、`3`→image、`34`→voice、`37`/`42`→card、`43`→video、
`47`→sticker、`48`→location、`49`→link、`50`→video、`10000`→system、`10002`→revoke。
未知取值落到 `unknown`，不抛错。

### `http-webhook`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `0`（随机） | 监听端口 |
| `path` | `/webhook` | 接收路径 |
| `token` | — | 校验 `x-wechatpro-token` 请求头，不匹配返回 401 |
| `mapping` | 见下 | 字段映射：`{ 归一化字段: [候选路径…] }` |
| `outboundUrl` | — | 回发消息的目标地址（不配则不支持主动发送） |

默认字段映射（候选路径按序尝试）:

| 归一化字段 | 默认候选 |
| --- | --- |
| `id` | `id`, `msgId`, `MsgId`, `messageId`, `msg_id`, `newMsgId` |
| `conversationId` | `conversationId`, `roomId`, `chatId`, `groupId`, `FromUserName` |
| `conversationName` | `conversationName`, `roomName`, `chatName`, `groupName` |
| `conversationKind` | `conversationKind`, `chatType`, `roomType` |
| `senderId` | `senderId`, `sender`, `fromUser`, `from`, `sender_id`, `FromUserName` |
| `senderName` | `senderName`, `sender_nick`, `nickname`, `displayName`, `pushContent` |
| `groupAlias` | `groupAlias`, `groupNickName`, `memberNickName` |
| `ownerId` | `ownerId`, `roomOwner`, `owner` |
| `memberCount` | `memberCount`, `memberCountInRoom` |
| `kind` | `kind`, `type`, `msgType`, `MsgType`, `messageType` |
| `text` | `text`, `content`, `msg`, `Content`, `message` |
| `mentions` | `mentions`, `atList`, `atUsers`, `atuserlist` |
| `quoteId` | `quoteId`, `replyTo`, `quoteMsgId` |
| `mediaUrl` | `mediaUrl`, `url`, `fileUrl`, `cdnUrl` |
| `timestamp` | `timestamp`, `createTime`, `CreateTime`, `ts`, `sendTime` |
| `direction` | `direction`, `isSend`, `fromSelf` |

自定义 `mapping` 会与默认值**合并**（同名键覆盖）。请求体可以是单个对象或对象数组（批量）。

**消息类型兼容**：字符串枚举（`text`/`image`…）与数字（`1`→text、`3`→image、`34`→voice、
`43`→video、`49`→link、`42`→card、`47`→sticker、`10000`→system、`10002`→revoke），
以及常见别名（`pic`、`emoji`、`attachment`…）。无法识别归为 `unknown`，不丢数据。

**时间戳兼容**：10 位秒级、13 位毫秒级、数字字符串、ISO 日期字符串。

### `mock`

用于演示与测试。`script` 为回放消息数组，`intervalMs` 为间隔，`loop` 控制是否循环。

## analytics

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用 |
| `includeConversations` | `[]` | 参与统计的会话白名单，空为全部 |
| `stopWords` | `[]` | 词频统计丢弃的停用词 |
| `hourlyBuckets` | `24` | 时段桶粒度，24 表示按自然小时 |
| `digestCron` | `0 9 * * *` | **群日报推送时间**（5 段 cron，本地时区） |
| `digestDays` | `1` | 日报覆盖天数，1 表示只报昨天 |
| `digestConversationId` | `''` | 日报统一推送到该会话（如管理员群）；空则各自推回本群 |
| `digestIncludeEmpty` | `false` | 无消息的群是否也推日报 |
| `digestMaxConversations` | `50` | 单次最多推送的群数，防止首次运行刷屏 |

### 群日报

日报是引擎**唯一的主动推送**，默认每天 09:00（本地时区）把「昨天」的
活跃度、发言排行、类型分布、时段分布、热门话题、风控事件、成员变动推回群里。

几个刻意的取舍：

- **按自然日而不是「最近 24 小时」**：群主理解「昨天」就是 0 点到 0 点，
  滚动窗口会让早上的日报混入昨天傍晚与今天凌晨两段时间，读起来对不上号。
- **本地时区**：统一成 UTC 会让「昨晚 9 点高峰」在日报里显示成凌晨。
- **默认跳过空群**：不加这个开关，一个 30 群的账号每天早上会收到 30 条
  「昨日无消息」，用户第一件事就是关掉日报。
- **失败逐条记账**：某个群发送失败只记 `failed`，不影响其他群，
  也不会让整个定时任务被标记为失败。

不想等到第二天早上，可以直接看当前会产出什么：

```bash
node dist/cli.js digest                    # 全部会话的昨日日报
node dist/cli.js digest <id> --days 7      # 指定会话、最近 7 天
```

群里也可以直接问：`/统计 日报`（与定时推送用的是同一段渲染代码）。

> cron 表达式写错时会在日志里告警并**跳过**该任务，不会让引擎起不来；
> `wechatpro doctor` 的「日报调度」一项会给出校验结论。

## guard

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用检测 |
| `alertThreshold` | `30` | 风险分达到该值产生告警 |
| `windowMs` | `600000` | 滑动窗口长度（10 分钟） |
| `rules` | `[]` | 规则配置，见 [`guard-rules.md`](./guard-rules.md) |

单条规则配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `id` | 必填 | 内置规则 id；未匹配内置 id 时按「自定义词表规则」处理 |
| `description` | `''` | 展示用说明 |
| `enabled` | `true` | 是否启用 |
| `action` | `alert` | `alert`\|`warn`\|`mute-suggest`\|`revoke-suggest`\|`kick-suggest` |
| `weight` | `10` | 命中后计入的风险分 |
| `options` | `{}` | 规则私有参数 |

## ai

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用（关闭时摘要降级为统计口径） |
| `provider` | `openai-compatible` | `openai-compatible`\|`mock` |
| `baseUrl` | `https://api.openai.com/v1` | 任意兼容端点（DeepSeek、通义、Ollama…） |
| `apiKey` | `''` | 鉴权密钥 |
| `model` | `gpt-4o-mini` | 默认模型 |
| `timeoutMs` | `30000` | 单次请求超时 |
| `maxConcurrency` | `4` | 并发上限，防打爆上游限流 |
| `summaryWindow` | `200` | 摘要覆盖的消息条数 |

## manage

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用 |
| `dataDir` | `./data` | 数据目录 |
| `retainMessagesPerConversation` | `0` | 单会话保留消息上限，`0` 为不限制 |

> 留存裁剪只影响 `messages` 表；会话与成员的累计计数是历史口径，不随之回退。

## api

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启动控制台 |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `8787` | 监听端口 |
| `token` | `''` | 访问令牌；为空则不鉴权 |
| `corsOrigins` | `[]` | 允许的跨域来源 |

> `host` 非回环地址且 `token` 为空时**引擎拒绝启动**。

## plugins

```json
{ "name": "command", "enabled": true, "options": { } }
```

| 插件 | 关键 options |
| --- | --- |
| `command` | `prefix`（默认 `/`）、`aliases`（默认 `["机器人","bot","小助手"]`）、`bareCommands`（默认 `["help","帮助","菜单","指令"]`）、`replyOnUnknown`（默认 `true`） |
| `guard` | `autoActions`（默认 `false`）、`actionTargets`、`useAi`（默认 `false`）、`aiPolicy` |
| `analytics` | `digestCron`、`digestDays`、`reportConversationId`、`digestIncludeEmpty`、`digestMaxConversations`、`digestEnabled` |
| `ai` | `triggers`、`autoKnowledge`、`knowledgeMinChars` |

## 环境变量覆盖

| 变量 | 覆盖字段 |
| --- | --- |
| `WECHATPRO_LOG_LEVEL` | `logLevel` |
| `WECHATPRO_SQLITE_PATH` | `storage.sqlitePath` |
| `WECHATPRO_API_HOST` / `WECHATPRO_API_PORT` / `WECHATPRO_API_TOKEN` | `api.*` |
| `WECHATPRO_AI_ENABLED` | `ai.enabled`（`true` 才开启） |
| `WECHATPRO_AI_API_KEY` / `WECHATPRO_AI_BASE_URL` / `WECHATPRO_AI_MODEL` | `ai.*` |
| `WECHATPRO_DIGEST_CRON` | `analytics.digestCron` |

只覆盖「部署强相关」字段；业务规则仍走配置文件，避免配置散落两处。
