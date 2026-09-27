# WeChatPro

专业微信社群智能引擎：**AI 助手 · 群聊统计 · 自动化检测 · 群聊信息管理**。

面向群主与运营团队，把「今天群里聊了什么、谁在活跃、有没有人在打广告、要不要留档」
这几件事做成可查询、可告警、可自动化的能力，而不是靠人工翻聊天记录。

## 能力概览

| 模块 | 能力 |
| --- | --- |
| **群聊统计** | 活跃度报表、24×7 时段热力图、活跃度趋势（升降判定）、词频话题、成员画像与生命周期分层 |
| **自动化检测** | 敏感词、广告导流、刷屏、重复内容、@ 轰炸、媒体刷屏、深夜扰民、自定义词表；滑动窗口风险分累计 |
| **AI 助手** | 群聊摘要（分段+归并）、群内检索问答（RAG）、语义审核、群知识自动沉淀 |
| **信息管理** | 群档案、成员台账、群知识库、数据留存策略、档案导出迁移 |
| **控制台** | 自包含 Web 看板 + REST API + CLI |

## 快速开始

```bash
npm install
npm run build

# 启动（默认读取 ./config.json，不存在则用内置默认值）
cp config.example.json config.json
node dist/cli.js start --config config.json
```

打开 <http://127.0.0.1:8787> 即为控制台。

### 零依赖体验（内置演示数据源）

不接真实微信协议也能跑通全链路：

```bash
cat > demo.json <<'EOF'
{
  "logLevel": "info",
  "storage": { "sqlitePath": "./data/demo.db" },
  "adapters": [{
    "protocol": "mock",
    "options": { "intervalMs": 800, "loop": true, "script": [
      { "conversationId": "g1", "conversationName": "测试群", "senderId": "u1", "senderName": "张三", "text": "本周项目进度同步一下", "MsgType": 1 },
      { "conversationId": "g1", "conversationName": "测试群", "senderId": "u2", "senderName": "李四", "text": "团建定在周五下午三点", "MsgType": 1 },
      { "conversationId": "g1", "conversationName": "测试群", "senderId": "u3", "senderName": "广告号", "text": "招人刷单，需要的加我微信私聊", "MsgType": 1 }
    ] }
  }]
}
EOF
node dist/cli.js start --config demo.json
```

## 接入真实微信协议

引擎不绑定某一家协议。两个通用底座已内置：

### 1. `http-webhook`（推荐先用这个）

任何能把事件推到 HTTP 的微信中间件都能接：本地 hook 程序、协议网关、企业微信应用。

```bash
curl -X POST http://127.0.0.1:8790/webhook \
  -H 'content-type: application/json' \
  -H 'x-wechatpro-token: change-me' \
  -d '{"conversationId":"12345@chatroom","conversationName":"产品交流群",
       "senderId":"wxid_abc","senderName":"张三",
       "text":"这周的进度同步一下","MsgType":1}'
```

字段名不一致时用 `mapping` 配置映射，无需改代码：

```json
{
  "protocol": "http-webhook",
  "options": {
    "port": 8790,
    "token": "change-me",
    "mapping": {
      "conversationId": ["roomId", "chat.id"],
      "senderId": ["fromUser"],
      "text": ["Content"]
    }
  }
}
```

时间戳兼容秒/毫秒/ISO 字符串，消息类型兼容字符串与数字（`1`→text、`3`→image…）。

### 2. 自定义适配器

对接私有协议只需实现 `ProtocolAdapter` 并注册，**不修改引擎代码**：

```ts
import { registerAdapter } from 'wechatpro';

registerAdapter('my-protocol', async (options, deps) => ({
  name: 'my-protocol',
  capabilities: new Set(['receive', 'send']),
  async start(handler) {
    mySdk.onMessage((raw) => handler({
      protocol: 'my-protocol',
      type: 'message',
      receivedAt: Date.now(),
      payload: raw,
    }));
  },
  async stop() { await mySdk.close(); },
  async send(conversationId, message) {
    return mySdk.send(conversationId, message.text);
  },
}));
```

## 群内指令

在群里 @ 或使用 `/` 前缀：

```
/统计 [今天|昨天|本周|最近3天]   群活跃度概览
/热力图                          活跃时段分布
/排行                            发言排行 Top10
/总结 [今天|本周]                 AI 群聊摘要
/ask <问题>                       基于群内记录问答
/规则                            查看生效的检测规则
help / 帮助                        指令菜单
```

自然语言也能路由：「@机器人 这周大家都聊了什么」「@机器人 昨天有人提到团建吗」。

## 配置

完整示例见 [`config.example.json`](./config.example.json)，逐项说明见 [`docs/configuration.md`](./docs/configuration.md)。

常用环境变量覆盖（容器部署免挂载配置文件）：

| 变量 | 说明 |
| --- | --- |
| `WECHATPRO_LOG_LEVEL` | 日志级别 |
| `WECHATPRO_SQLITE_PATH` | 数据文件路径 |
| `WECHATPRO_API_HOST` / `WECHATPRO_API_PORT` / `WECHATPRO_API_TOKEN` | 控制台监听与鉴权 |
| `WECHATPRO_AI_ENABLED` / `WECHATPRO_AI_API_KEY` / `WECHATPRO_AI_BASE_URL` / `WECHATPRO_AI_MODEL` | AI 接入 |

> **安全**：`api.host` 为非回环地址时必须配置 `api.token`，否则引擎拒绝启动 —— 看板含群成员与聊天内容，不可无鉴权暴露。

## REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与运行统计 |
| GET | `/api/conversations` | 会话列表 |
| GET | `/api/conversations/:id/activity?days=7` | 活跃度报表 |
| GET | `/api/conversations/:id/heatmap?days=7` | 时段热力图 |
| GET | `/api/conversations/:id/trend?days=7` | 活跃度趋势 |
| GET | `/api/conversations/:id/topics?limit=50` | 词频话题 |
| GET | `/api/conversations/:id/report?days=7&intent=stats` | 纯文本报表 |
| GET | `/api/conversations/:id/members` | 成员台账（含生命周期阶段） |
| GET | `/api/conversations/:id/members/:mid/profile` | 成员画像 |
| GET | `/api/conversations/:id/messages?limit=50` | 最近消息 |
| GET | `/api/conversations/:id/events?limit=50` | 风控事件 |
| GET/POST/DELETE | `/api/conversations/:id/knowledge` | 群知识库增删查 |
| POST | `/api/conversations/:id/summary` | 生成群聊摘要 |
| POST | `/api/conversations/:id/ask` | 群内问答 |
| GET | `/api/rules` | 生效的检测规则 |
| GET | `/api/stats` | 引擎统计 |

配置了 `api.token` 时，请求需带 `Authorization: Bearer <token>` 或 `x-wechatpro-token`。

## CLI

```bash
node dist/cli.js start [--config <path>]           启动引擎与控制台
node dist/cli.js report <conversationId> [--days 7] 统计报表
node dist/cli.js conversations                      会话列表
node dist/cli.js members <conversationId>           成员台账
node dist/cli.js knowledge <conversationId>         群知识库
node dist/cli.js rules                              检测规则
node dist/cli.js export <conversationId> [--out f]  导出群档案
node dist/cli.js check [--config <path>]            校验配置
node dist/cli.js adapters | plugins                 已注册的适配器 / 插件
```

## 架构

```
适配器 (ProtocolAdapter)          协议差异只在这一层
        │  RawEvent
        ▼
引擎 Engine                       归一化 + 幂等去重 + 落库
        │  NormalizedMessage
        ▼
事件总线 EventBus                 同步派发，订阅者互不影响
        ├── analytics   统计预聚合与报表
        ├── guard       规则引擎与风险累计
        ├── ai          LLM 网关 / 检索 / 摘要
        ├── manage      群档案 / 知识库 / 留存
        └── command     指令路由
        ▼
SQLite (WAL)                      窄表 + 覆盖索引 + 预聚合
        ▼
HTTP API / 控制台 / CLI
```

设计要点与取舍见 [`docs/architecture.md`](./docs/architecture.md)。

## 开发

```bash
npm run typecheck   # 类型检查
npm test            # 144 个测试
npm run build       # 编译到 dist/
npm run dev         # tsx watch 热重载
```

## 文档

- [`docs/architecture.md`](./docs/architecture.md) — 架构与关键设计取舍
- [`docs/configuration.md`](./docs/configuration.md) — 配置项详解
- [`docs/guard-rules.md`](./docs/guard-rules.md) — 检测规则与自定义方式
- [`docs/deployment.md`](./docs/deployment.md) — 部署与运维
- [`examples/`](./examples) — 可直接运行的示例

## 许可

MIT
