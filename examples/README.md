# 示例

## 0. PC 客户端插件形态（主形态）

`config.client.json` + `host-shell.ts` 演示「在微信 APP 内直接使用与管理」：

```bash
npm run build
node dist/cli.js client --config examples/config.client.json
```

没有真实客户端时，用 curl 模拟宿主投递微信原生字段的消息：

```bash
curl -X POST http://127.0.0.1:8787/api/ingest \
  -H 'content-type: application/json' \
  -d '{"MsgSvrID":"1","StrTalker":"12345@chatroom","RoomName":"产品交流群",
       "StrSender":"wxid_a","SenderNick":"张工","StrContent":"本周进度同步","Type":1,
       "CreateTime":1790000000}'
```

然后打开 <http://127.0.0.1:8787/> 看面板（仪表盘/统计/热力/成员/风控/知识库/AI/规则/关于 九个视图）。

`host-shell.ts` 是插件壳的参考实现，展示了三件壳必须做的事：
消息投递、能力挂载、面板唤起。要点：

- **未实现的能力不要写成空函数**（会被误判为可用然后静默失效），用 `bridgeFromShell()` 自动只挂真实实现
- 消息对象**原样传给 `inject()`**，字段转换由适配器的 `mapping` 统一负责
- 回调里别让异常冒出去，否则会打断客户端的消息循环

把壳交给 CLI：

```bash
WECHATPRO_HOST_SHELL=/abs/path/host-shell.js \
  node dist/cli.js client --config examples/config.client.json
```

## 1. 离线演示（推荐先跑这个）

不接任何微信协议，用内置 `mock` 适配器回放消息，完整体验统计、风控、面板。

```bash
npm install && npm run build
node dist/cli.js start --config examples/config.mock.json
```

打开 <http://127.0.0.1:8787>，几秒后即可看到活跃度、热力图、排行与「广告号」触发的风控事件。

命令行看报表：

```bash
node dist/cli.js conversations --config examples/config.mock.json
node dist/cli.js report 'demo-group@chatroom' --days 1 --config examples/config.mock.json
node dist/cli.js members 'demo-group@chatroom' --config examples/config.mock.json
node dist/cli.js rules --config examples/config.mock.json
```

## 2. 接入 HTTP 中间件

用 `examples/config.webhook.json`，把消息 POST 到 `/webhook`：

```bash
node dist/cli.js start --config examples/config.webhook.json

curl -X POST http://127.0.0.1:8790/webhook \
  -H 'content-type: application/json' \
  -H 'x-wechatpro-token: demo-token' \
  -d '{"conversationId":"12345@chatroom","conversationName":"产品交流群",
       "senderId":"wxid_demo","senderName":"张工",
       "text":"这周的进度同步一下","MsgType":1}'
```

### 字段名不一致的协议

`examples/config.webhook.mapped.json` 演示了把另一套字段名映射到引擎模型：

```json
{
  "protocol": "http-webhook",
  "options": {
    "mapping": {
      "conversationId": ["roomId"],
      "senderId": ["fromUser"],
      "senderName": ["pushContent"],
      "text": ["Content"],
      "kind": ["MsgType"]
    }
  }
}
```

这样推送 `{"roomId":"…","fromUser":"…","Content":"…","MsgType":1}` 也能正常入库。

## 3. 自定义适配器

见 [`custom-adapter.ts`](./custom-adapter.ts) —— 对接私有微信协议，不修改引擎代码。

## 4. 其它 CLI 能力

```bash
# 导出单文件面板（离线可开，零外部依赖）
node dist/cli.js ui --out panel.html

# 环境自检：配置 / 适配器 / 数据库 / 宿主能力 / 品牌资源
node dist/cli.js doctor

# 导入聊天导出文本（回填历史，不依赖任何注入）
node dist/cli.js import chat.txt --conversation '12345@chatroom'

# 品牌信息与资源状态
node dist/cli.js brand --json
```
