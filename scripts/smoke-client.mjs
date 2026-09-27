/**
 * 客户端形态端到端冒烟。
 *
 * 在 CI 里跑，作为「在微信里能不能真的用」的最小可信证据：
 * 起客户端形态 → 注入一条微信原生字段的广告消息 → 断言入库 + 风控命中。
 *
 * 之所以不写成 vitest 用例：这里刻意走**编译产物**（`dist/`）而不是源码，
 * 能顺带发现「编译后路径/导出变了但测试还是绿的」这类只在发布后才炸的问题。
 */

import { bootstrap } from '../dist/runtime/bootstrap.js';
import { parseConfig } from '../dist/core/config.js';

const config = parseConfig({
  logLevel: 'error',
  storage: { sqlitePath: ':memory:' },
  client: { enabled: true },
  guard: {
    alertThreshold: 30,
    rules: [{ id: 'keyword-blocklist', enabled: true, weight: 40, options: { words: ['刷单'] } }],
  },
});

const { engine, client, stop } = await bootstrap({ clientMode: true, config });

try {
  await engine.start();

  const result = await client.ingest({
    MsgSvrID: 'smoke1',
    StrTalker: 'smoke@chatroom',
    RoomName: '冒烟群',
    StrSender: 'wxid_smoke',
    SenderNick: '冒烟员',
    StrContent: '招人刷单日结，加我私聊',
    Type: 1,
    CreateTime: 1_790_000_000,
  });

  if (!result.accepted) fail(`注入失败：${result.reason}`);
  if (result.message?.kind !== 'text') fail(`消息类型映射错误：${result.message?.kind}`);
  if (result.message?.timestamp !== 1_790_000_000_000) fail('时间戳未转换为毫秒');

  const conversation = engine.store.getConversation('smoke@chatroom');
  if (!conversation || conversation.message_count !== 1) fail(`落库异常：${JSON.stringify(conversation)}`);
  if (conversation.name !== '冒烟群') fail('群名未入库');

  const events = engine.store.recentEvents('smoke@chatroom', 10);
  if (events.length === 0) fail('风控未命中');

  // 宿主能力缺失必须降级而不是抛错——真实客户端的 API 集合不可控。
  const toast = await client.gateway.toast('测试');
  if (toast !== false) fail('无宿主桥时 toast 应返回 false');

  process.stdout.write(
    `客户端形态冒烟通过：入库 1 条，风控命中 ${events.length} 条，能力降级正常\n`,
  );
} finally {
  await stop();
}

function fail(message) {
  process.stderr.write(`冒烟失败：${message}\n`);
  process.exit(1);
}
