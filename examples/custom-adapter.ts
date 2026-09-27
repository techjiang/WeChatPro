/**
 * 自定义协议适配器示例。
 *
 * 场景：已有的微信中间件通过长连接（WebSocket / MQTT / 私有 SDK）推送事件，
 * 而不是 HTTP。此时不必改引擎代码，实现 `ProtocolAdapter` 并注册即可。
 *
 * 运行方式（先 `npm run build`）：
 *   npx tsx examples/custom-adapter.ts
 */

import { bootstrap, registerAdapter } from '../src/index.js';
import { parseConfig } from '../src/core/config.js';
import type { ProtocolAdapter, RawEventHandler } from '../src/core/types.js';

/**
 * 假的「中间件 SDK」。真实场景替换成你的客户端库。
 * 这里用定时器模拟推送，让示例可以独立运行。
 */
const fakeMiddlewareSdk = {
  connect(onEvent: (payload: unknown) => void): void {
    let counter = 0;
    setInterval(() => {
      counter += 1;
      const senders = [
        { id: 'wxid_zhang', name: '张工' },
        { id: 'wxid_li', name: '李设计' },
      ];
      const sender = senders[counter % senders.length] as { id: string; name: string };
      onEvent({
        // 中间件自己的字段命名，与引擎模型无关
        roomId: 'demo-group@chatroom',
        roomTopic: '产品交流群',
        fromUser: sender.id,
        pushContent: sender.name,
        Content: `第 ${counter} 条来自自定义协议的消息`,
        MsgType: 1,
        CreateTime: Math.floor(Date.now() / 1000),
      });
    }, 700);
  },
  disconnect(): void {
    // 真实实现里关闭连接
  },
};

let connectRef: ((payload: unknown) => void) | null = null;

/** 适配器实现：把中间件事件转成 `RawEvent` 投递给引擎。 */
const myAdapter: ProtocolAdapter = {
  name: 'my-middleware',
  capabilities: new Set(['receive', 'send']),

  async start(handler: RawEventHandler): Promise<void> {
    connectRef = (payload) => {
      void handler({
        protocol: 'my-middleware',
        type: 'message',
        receivedAt: Date.now(),
        // 直接把中间件 payload 交给引擎；字段映射由 mapping 或归一化兜底
        payload: normalizeMiddlewarePayload(payload),
      });
    };
    fakeMiddlewareSdk.connect(connectRef);
  },

  async stop(): Promise<void> {
    fakeMiddlewareSdk.disconnect();
    connectRef = null;
  },

  async send(conversationId: string, message): Promise<boolean> {
    // 真实实现里调用中间件的发送接口
    console.log(`[发送] ${conversationId}: ${message.text}`);
    return true;
  },
};

/**
 * 把中间件字段映射到引擎模型。
 *
 * 也可以完全不做这一步 —— 在配置里写 `mapping` 让 http-webhook 适配器处理。
 * 这里用代码映射，是为了展示「映射逻辑可以放在适配器内部」这条路径。
 */
function normalizeMiddlewarePayload(payload: unknown): Record<string, unknown> {
  const raw = payload as Record<string, unknown>;
  return {
    conversationId: raw.roomId,
    conversationName: raw.roomTopic,
    senderId: raw.fromUser,
    senderName: raw.pushContent,
    text: raw.Content,
    kind: raw.MsgType,
    timestamp: raw.CreateTime,
    raw,
  };
}

// 注册后即可在配置里用 `"protocol": "my-middleware"`
registerAdapter('my-middleware', async () => myAdapter);

const { engine, start, stop } = await bootstrap({
  config: parseConfig({
    logLevel: 'info',
    storage: { sqlitePath: ':memory:' },
    adapters: [{ protocol: 'my-middleware' }],
    api: { enabled: false },
    guard: {
      enabled: true,
      alertThreshold: 30,
      windowMs: 600_000,
      rules: [{ id: 'keyword-blocklist', enabled: true, weight: 40, options: { words: ['违规'] } }],
    },
  }),
});

engine.bus.on('message', 'demo-logger', (event) => {
  const message = event.payload as { sender: { displayName: string }; text: string };
  console.log(`[收到] ${message.sender.displayName}: ${message.text}`);
});

await start();
console.log('示例运行中，Ctrl+C 退出。统计结果可直接通过 engine.store 查询。\n');

setTimeout(async () => {
  const conversations = engine.store.listConversations();
  console.log('\n=== 统计结果 ===');
  for (const conversation of conversations) {
    console.log(`${conversation.name}: ${conversation.message_count} 条消息`);
  }
  await stop();
  process.exit(0);
}, 3500);
