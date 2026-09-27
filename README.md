<div align="center">
  <img src="brand/logo-256.png" width="128" alt="WeChatPro Logo">
  <h1>WeChatPro</h1>
  <p><b>微信 PC 客户端插件</b> · 群聊统计 · 自动化检测 · 群聊信息管理 · AI 助手</p>
  <p>装在微信里，打开面板即用 —— 不用另起服务，不用把聊天记录搬到别处</p>
</div>

---

## 形态：跑在微信 PC 客户端里

WeChatPro 是一个**微信 PC 客户端插件**。引擎嵌在客户端进程内，消息由客户端直接递进来，
面板挂在客户端窗口里打开；打开插件面板就能看统计、查风控、管成员、导档案。

```
微信 PC 客户端
  └── WeChatPro 插件壳      ← 实现宿主能力（通知、角标、原生发送、文件对话框）
        └── 引擎 · 面板       ← 本仓库
```

没有插件壳也能跑：引擎支持 HTTP 中间件推送与离线导入，
同一份代码、同一套统计口径，三种形态可以同时开（见 [接入方式](#接入方式)）。

## 能力概览

| 模块 | 能力 |
| --- | --- |
| **群聊统计** | 活跃度报表、24×7 时段热力图、活跃度趋势（升降判定）、词频话题、成员画像与生命周期分层 |
| **自动化检测** | 敏感词、广告导流、刷屏、重复内容、@ 轰炸、媒体刷屏、深夜扰民、自定义词表；滑动窗口风险分累计 |
| **AI 助手** | 群聊摘要（分段+归并）、群内检索问答（RAG）、语义审核、群知识自动沉淀 |
| **信息管理** | 群档案、成员台账、群知识库、数据留存策略、档案导出迁移 |
| **客户端集成** | 原生通知、入口角标、面板唤起、文件对话框、剪贴板、原生发送 |
| **控制台** | 客户端内嵌面板（9 个视图，单文件零依赖）+ REST API + CLI |

## 快速开始

```bash
npm install
npm run build

node dist/cli.js doctor          # 环境自检：配置 / 数据 / 宿主能力 / 品牌资源
node dist/cli.js client --config examples/config.client.json
```

打开 <http://127.0.0.1:8787> 就是面板。模拟客户端投递一条微信原生字段的消息：

```bash
curl -X POST http://127.0.0.1:8787/api/ingest \
  -H 'content-type: application/json' \
  -d '{"MsgSvrID":"1","StrTalker":"12345@chatroom","RoomName":"产品交流群",
       "StrSender":"wxid_a","SenderNick":"张工","StrContent":"本周进度同步","Type":1,
       "CreateTime":1790000000}'
```

接真实客户端（写插件壳、或用本地 IPC）见 [`docs/pc-client.md`](./docs/pc-client.md)。

### 不接客户端也能用

```bash
node dist/cli.js start --config examples/config.mock.json   # 回放演示数据
node dist/cli.js import chat.txt --conversation 'g@chatroom' # 导入聊天导出文本
```

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

## 接入方式

引擎不绑定某一家协议，三条路径共用同一套归一化与统计口径：

### 1. `host` — PC 客户端进程内注入（主形态）

宿主直接投递微信原生字段的消息对象，零网络往返：

```ts
const { client, engine, start } = await bootstrap({ clientMode: true, hostBridge: nativBridge });
await start();
native.onMessage((payload) => void client!.ingest(payload));   // StrTalker/StrContent/MsgSvrID…
native.onActivate(() => void client!.focus());                  // 打开面板 + 清角标
```

内置 `WECHAT_PC_MAPPING` 已覆盖微信字段名与消息类型（`1`→text、`3`→image…），
换版本只改 `mapping`，不动代码。详见 [`docs/pc-client.md`](./docs/pc-client.md)。

### 2. `http-webhook` — HTTP 中间件推送

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

### 3. 自定义适配器

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
/面板                             在微信客户端里打开 WeChatPro 面板   ← 客户端形态
/导出                             导出群档案（宿主弹保存框）          ← 客户端形态
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
| `WECHATPRO_CLIENT_ENABLED` / `WECHATPRO_CLIENT_HOST` | 开启 PC 客户端形态 |
| `WECHATPRO_HOST_SHELL` | 客户端插件壳模块路径（`client` 命令据此加载宿主能力） |
| `WECHATPRO_HOST_NAME` / `WECHATPRO_HOST_VERSION` / `WECHATPRO_PLUGIN_VERSION` | 宿主标识，写进 `/api/client` |

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
| POST | `/api/ingest` | **宿主注入消息**（接受微信原生字段，支持单条与批量） |
| GET | `/api/client` | **宿主状态**：身份、可用能力、调用统计、品牌信息 |
| POST | `/api/client/focus` | **让宿主拉起面板**并清角标 |
| GET | `/api/conversations/:id/export` | **导出群档案**（宿主能弹保存框就交给宿主） |
| GET | `/panel.html` | 导出单文件面板 |

配置了 `api.token` 时，请求需带 `Authorization: Bearer <token>` 或 `x-wechatpro-token`。

## CLI

```bash
node dist/cli.js start [--config <path>]           启动引擎与面板
node dist/cli.js client [--config <path>]          PC 客户端插件形态启动
node dist/cli.js ui [--out panel.html]             导出单文件面板（离线可开）
node dist/cli.js doctor [--json]                   环境自检
node dist/cli.js import <file|-> [options]         导入聊天导出文本 / 宿主 JSON
node dist/cli.js brand [--json]                    品牌信息与资源状态
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
宿主 (微信 PC 客户端 / HTTP 中间件 / 导入)
        │  HostTransport.inject()      ← 进程内直投，无网络
        │       或 ProtocolAdapter      ← HTTP / 自定义协议
        ▼
引擎 Engine                              归一化 + 幂等去重 + 落库
        │  NormalizedMessage
        ▼
事件总线 EventBus                        同步派发，订阅者互不影响
        ├── analytics   统计预聚合与报表
        ├── guard       规则引擎与风险累计
        ├── ai          LLM 网关 / 检索 / 摘要
        ├── manage      群档案 / 知识库 / 留存
        ├── command     指令路由
        └── client      原生通知 / 角标 / 面板唤起   ← 客户端形态
        ▼
SQLite (WAL)                             窄表 + 覆盖索引 + 预聚合
        ▼
客户端内嵌面板 / HTTP API / CLI
```

设计要点与取舍见 [`docs/architecture.md`](./docs/architecture.md)。
客户端形态的可注入点与降级策略见 [`docs/pc-client.md`](./docs/pc-client.md)。

## 开发

```bash
npm run typecheck   # 类型检查
npm test            # 189 个测试
npm run build       # 编译到 dist/
npm run dev         # tsx watch 热重载

# 面板可视化验证（可选，需要 playwright）
node dist/cli.js ui --out /tmp/panel.html   # 导出后用浏览器打开
```

重新生成品牌图标（可选，需要 sharp）：

```bash
npm i -D sharp && npx tsx scripts/brand-assets.ts brand/logo.png
```

## 文档

- [`docs/pc-client.md`](./docs/pc-client.md) — **在微信 PC 客户端内使用与管理**（注入路径、字段映射、降级、排障）
- [`docs/architecture.md`](./docs/architecture.md) — 架构与关键设计取舍
- [`docs/configuration.md`](./docs/configuration.md) — 配置项详解
- [`docs/guard-rules.md`](./docs/guard-rules.md) — 检测规则与自定义方式
- [`docs/deployment.md`](./docs/deployment.md) — 部署与运维
- [`brand/README.md`](./brand/README.md) — 品牌资源与图标生成
- [`examples/`](./examples) — 可直接运行的示例

## 作者

**科技酱**

- 网站：<https://docs.asoe.cn>
- GitHub：<https://github.com/techjiang/>
- 哔哩哔哩：<https://space.bilibili.com/1768832152>
- 玲珑论坛：<https://forums.asoe.cn/>
- QQ 群：291974598 ｜ 474819022

## 许可

MIT
