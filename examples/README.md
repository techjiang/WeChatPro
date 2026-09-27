# 示例

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
