# 在微信 PC 客户端内使用与管理

WeChatPro 的主形态是**微信 PC 客户端的插件**：引擎跑在客户端进程里，消息由客户端直接递进来，
面板挂在客户端窗口里打开。装好即用，不需要另外跑服务、不需要把聊天记录发到别处。

> ⚠️ **开始之前请先读**：注入微信客户端进程、读取聊天记录**违反《微信软件许可及服务协议》**，
> **可能导致账号被限制功能、限制登录或永久封禁**；安装插件的机器上登录的账号风险最高。
> 本项目由作者按「现状」免费提供，**作者不承担任何责任**，也不提供担保与技术支持。
> 完整条款见 [免责声明与风险提示](./disclaimer.md)（或 README 同名章节）。
> **若你不同意其中任何一条，请立即停止使用并删除本项目。**
>
> 建议先用**小号、测试机、测试群**验证，不要把主账号与重要数据压上去。

---

## 一、形态对比

| | 客户端形态（推荐） | 服务形态 |
|---|---|---|
| 引擎位置 | 微信 PC 客户端进程内 | 独立进程 / 容器 |
| 消息来源 | 客户端内存对象直投 | HTTP 中间件推送 |
| 使用方式 | 点插件入口，面板在客户端里打开 | 浏览器打开控制台 |
| 延迟 | 进程内直调，无网络往返 | 一次 HTTP 往返 |
| 宿主能力 | 原生通知、角标、文件对话框、原生发送 | 无 |
| 配置 | `client.enabled = true` | 默认 |

两种形态**共用同一套引擎与同一份统计口径**，可以同时开启。

---

## 二、快速开始

```bash
npm ci && npm run build
node dist/cli.js doctor          # 先自检环境
node dist/cli.js client --config examples/config.client.json
```

`client` 命令会打印宿主身份、可用能力与面板地址。看到下面这行就说明就绪了：

```
客户端宿主模式已就绪：等待宿主注入消息
```

此时可以用 curl 模拟客户端投递一条微信原生字段的消息：

```bash
curl -X POST http://127.0.0.1:8787/api/ingest \
  -H 'content-type: application/json' \
  -d '{"MsgSvrID":"1","StrTalker":"12345@chatroom","RoomName":"产品交流群",
       "StrSender":"wxid_a","SenderNick":"张工","StrContent":"本周进度同步","Type":1,
       "CreateTime":1790000000}'
```

打开 <http://127.0.0.1:8787/> 就能看到面板里已出现这个群。

---

## 三、接入真实客户端（三种注入路径）

微信 PC 端是闭源客户端，没有官方插件 SDK。可行的注入方式有三条，**核心代码一行都不用改**。

### 路径 1：进程内插件壳（推荐）

插件壳与引擎在同一个进程里，实现 `HostBridge` 提供宿主能力，然后用 `inject()` 直投消息对象。

```ts
import { bootstrap } from 'wechatpro';

// 客户端插件框架给你的全局对象（名称按实际框架替换）
const native = (globalThis as any).wechatProHost;

const bridge = {
  host: 'wechat-pc',
  hostVersion: '3.9.x',
  notify: (o) => native.notify(o),
  setBadge: (n) => native.setBadge(n),
  setTitleBadge: (t) => native.setTitleBadge(t),
  openPanel: (r) => native.showPanel(r),
  toast: (m, l) => native.toast(m, l),
  openExternal: (u) => native.openExternal(u),
  nativeSend: (r) => native.send(r),
  contacts: (id) => native.contacts(id),
  pickFile: () => native.pickFile(),
  exportFile: (o) => native.saveFile(o.filename, o.content),
  // 未实现的能力直接不写 —— 写成空函数会被误判为「能力可用」
};

const { client, engine, start } = await bootstrap({ clientMode: true, hostBridge: bridge });
await start();

// 客户端收到消息 → 投进引擎
native.onMessage((payload) => { void client!.ingest(payload); });
// 客户端点插件入口 → 打开面板并清角标
native.onActivate(() => { void client!.focus(); });
```

完整参考实现见 [`examples/host-shell.ts`](../examples/host-shell.ts)。

用环境变量把这个壳交给 CLI：

```bash
WECHATPRO_HOST_SHELL=/abs/path/host-shell.js \
  node dist/cli.js client --config examples/config.client.json
```

### 路径 2：本地 IPC

插件壳跑在辅助进程、或不是 Node 运行时（比如只提供 `fetch` 的宿主），
用本地 HTTP 回环投递。开启 `transport: "http"` 后适配器会监听一个本地端口：

```json
{ "protocol": "host", "options": { "transport": "http", "httpPort": 8791, "token": "本机令牌" } }
```

宿主侧：

```js
await fetch('http://127.0.0.1:8791/host/inject', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-wechatpro-token': '本机令牌' },
  body: JSON.stringify([msg1, msg2]),   // 支持单条与批量
});
```

**绑定非回环地址必须配 `token`**，否则适配器拒绝启动——和 HTTP API 同一条安全准则。

### 路径 3：离线导入

不依赖任何注入，直接吃聊天导出文本，用于历史回填与效果验证：

```bash
node dist/cli.js import chat.txt --conversation '12345@chatroom'
```

支持的文本格式（无法解析的行会跳过，不会让整批失败）：

```
2026-09-27 09:12:30 张工: 本周进度同步
[2026/09/27 09:13] 李设计：设计稿已交付
```

也可以吃宿主直出的 JSON 数组。三条路径最终都走同一个归一化管线，
因此导入数据与实时数据不会算出两套数字。

---

## 四、宿主要实现的字段映射

`host` 适配器内置了微信 PC 端的字段映射（`WECHAT_PC_MAPPING`），无需额外配置：

| 引擎字段 | 微信 PC 字段 |
|---|---|
| `conversationId` | `StrTalker` |
| `conversationName` | `RoomName` |
| `senderId` | `StrSender` |
| `senderName` | `SenderNick` |
| `text` | `StrContent` |
| `kind` | `Type` / `MsgType` |
| `timestamp` | `CreateTime`（**秒级**，引擎自动转毫秒） |
| `id` | `MsgSvrID` |

换微信版本或换企业微信时，只改 `mapping`，引擎代码不动：

```json
{
  "protocol": "host",
  "options": {
    "mapping": { "conversationId": ["roomId"], "text": ["Content"], "kind": ["msgType"] }
  }
}
```

`Type` 字段的常见取值已内置映射：`1`→text、`3`→image、`34`→voice、`43`→video、
`47`→sticker、`48`→location、`49`→link、`10000`→system、`10002`→revoke。
未知取值落到 `unknown`，**不会抛错**——一条畸形消息不该让插件崩掉。

---

## 五、宿主能力与降级

引擎只按能力名调用宿主，缺能力就降级，绝不因为「客户端没提供某个 API」而让链路失败。

| 能力 | 作用 | 缺失时的行为 |
|---|---|---|
| `notify` | 风控告警弹原生通知 | 只落库与记录日志 |
| `setBadge` | 会话列表未读角标 | 不显示角标 |
| `setTitleBadge` | 插件入口角标文本 | 不显示角标 |
| `openPanel` | 打开内置面板 | `/面板` 指令回复「当前环境不支持」 |
| `toast` | 轻提示（如新成员加入） | 静默 |
| `openExternal` | 打开文档站等外链 | 静默（仅放行 http/https） |
| `pickFile` | 选文件导入知识库 | 提示改为粘贴文本 |
| `exportFile` | 弹保存框导出群档案 | 改由 API 回传内容 |
| `readClipboard` / `writeClipboard` | 剪贴板读写 | 提示当前环境不支持 |
| `contacts` | 读通讯录 / 群成员 | 返回空列表 |
| `nativeSend` | 走客户端原生通道发消息 | 退回 HTTP 上报 |

查看当前宿主实际提供了哪些能力：

```bash
node dist/cli.js doctor
curl -s localhost:8787/api/client | jq .capabilities
```

> ⚠️ **写插件壳时最容易踩的坑**：把未实现的能力写成空函数。
> `HostGateway` 靠「是不是函数」判断能力，空函数会被当成「可用」，然后静默失效。
> 正确做法是**不写**——用 `bridgeFromShell()` 会自动只为真实实现挂载能力。

---

## 六、内置面板

面板是单文件 HTML，零外部依赖，在客户端嵌入式 WebView 里也能正常打开。

| 视图 | 能做什么 |
|---|---|
| 📊 仪表盘 | 总消息、活跃成员、人均、日均、趋势升降、最近风控事件、引擎状态 |
| 📈 活跃统计 | 消息类型分布、发言排行、成员明细表，可复制报表 |
| 🕒 时段热力 | 星期 × 小时热力图、高峰/冷清时段、按小时分布 |
| 👥 成员台账 | 分层运营（核心/活跃/新人/潜水/流失）、成员明细 |
| 🛡 风控中心 | 命中规则 TOP、事件明细（含原因与风险分）、清理角标 |
| 📚 群知识库 | 新增/删除知识条目、从文件导入，长期记忆不随消息清理丢失 |
| 🧠 AI 助手 | 群内问答、生成摘要、从剪贴板读问题 |
| ⚙️ 规则配置 | 当前生效规则、阈值、滑动窗口、内置规则一览 |
| 🩺 运行自检 | **注入链路实测**（探针真实走一遍宿主 → 引擎）、适配器计数、数据落地、宿主能力 |
| ℹ️ 关于 | 版本、作者与社区、宿主能力清单 |

### 运行自检：把「消息到底进没进来」一次看清

插件最常见的故障是「宿主注入了消息、面板却没变化」，而
「没投进来」「投进来但字段名对不上」「投进来也入库了只是没选群」
在界面上长得一模一样。面板的**🩺 运行自检**视图（对应接口
`GET /api/health/deep`）用一条真实探针把这条链路走一遍，直接给出结论：

```
注入链路正常，但还没有消息入库：让客户端投一条真实消息再刷新
注入链路正常，但有 3 条载荷无法映射：核对字段名（StrTalker/StrSender）或配置 mapping
注入链路不通（transport-off）：确认引擎已 start()，且适配器列表里有 host
```

探针带 `eventType: selftest`，引擎只计数**不落库**——所以每次自检都不会
给「昨天消息数」加一条假消息。命令行里看同一个结论：

```bash
curl -s localhost:8787/api/health/deep | jq
```

导出成离线单文件（塞进插件资源目录、或本地预览）：

```bash
node dist/cli.js ui --out panel.html
```

导出后的 HTML 里数据来自同源 `/api/*`，因此：

- 由引擎提供时（`http://127.0.0.1:8787/panel.html`）→ 显示真实数据
- 独立用浏览器打开文件 → 显示「还没有数据」，这是预期行为

---

## 七、群内可用指令

在群里 @ 机器人，或在客户端面板里操作。

| 指令 | 作用 |
|---|---|
| `/统计 [今天\|本周]` | 活跃度概览 |
| `/热力图` | 活跃时段分布 |
| `/排行` | 发言排行 Top10 |
| `/总结 [今天\|本周]` | 群聊摘要（AI 关闭时退化为统计口径） |
| `/ask <问题>` | 基于群内记录问答 |
| `/规则` | 查看生效的检测规则 |
| **`/面板`** | **在微信客户端里打开 WeChatPro 面板** |
| **`/导出`** | **导出群档案（宿主弹保存框）** |
| `help` / `帮助` | 指令一览 |

`/面板` 与 `/导出` 是客户端形态特有指令，由 `client` 插件解析——
它们不会抢 `/帮助` 的路由。

---

## 八、配置项

```jsonc
{
  "client": {
    "enabled": true,               // 开启客户端形态
    "host": "wechat-pc",           // 宿主标识，仅用于展示与排障
    "hostVersion": "3.9.x",
    "panelRoute": "#/dashboard",   // 打开面板的默认路由
    "clearBadgeOnFocus": true,     // 打开面板时清角标
    "notifyOnAlert": true,         // 风控告警弹原生通知
    "notifyDedupeMs": 60000,       // 同一告警的去重窗口
    "badgeMax": 99,                // 角标上限，超过显示 99+
    "dataDir": ""                  // 客户端数据目录（插件壳可用）
  }
}
```

环境变量覆盖：`WECHATPRO_CLIENT_ENABLED`、`WECHATPRO_CLIENT_HOST`。

---

## 九、排障

先跑自检：

```bash
node dist/cli.js doctor
```

| 现象 | 原因 | 处理 |
|---|---|---|
| 消息入库 0 条，日志正常 | 宿主注入到了另一个 transport 实例 | 用 `bootstrap()` 装配，别自己 `new` 引擎；`doctor` 会核对绑定 |
| `reason: "transport-off"` | 引擎还没启动，或适配器未启用 | 先 `await start()`；确认 `adapters` 里有 `host` |
| `reason: "unmapped"` | 载荷缺会话或发送者 | 补 `StrTalker` / `StrSender`，或改 `mapping` |
| 报表时间落在 1970 年 | 时间戳单位没转 | 引擎已处理秒→毫秒；若自定义适配器需自己保证毫秒 |
| 微信群识别成私聊 | 群 ID 不以 `@chatroom` 结尾 | 显式传 `conversationKind: "group"` |
| 面板空白 | 客户端 WebView 缺 Logo 资源 | 面板会自动降级为纯文字标题；重跑 `npm run build` 带上 `brand/` |
| 弹不出通知 | 宿主没注册 `notify` | `curl /api/client` 看 `capabilities` |
| 告警通知只弹一次 | 去重生效（预期行为） | 调小 `notifyDedupeMs` 或换 `dedupeKey` |
