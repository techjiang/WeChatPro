/**
 * 日报端到端校验。
 *
 * 日报是这套系统里**唯一主动推**的功能，也是最难发现故障的一处：
 * 它出错时不会有人立刻报错，只是「某天早上日报没来」，用户多半以为是自己没看到。
 * 所以把它纳入 CI：固定一个时间点，走真实存储与统计链路，断言正文里
 * 真的有当天的数字（而不是一句「昨日无消息」掩盖了聚合失败）。
 *
 * 与其他冒烟脚本一样，刻意走**编译产物**（`dist/`）而不是源码。
 */

import { Store } from '../dist/core/store.js';
import { HOUR_MS } from '../dist/analytics/index.js';
import { buildDigest, previousDayWindow } from '../dist/analytics/digest.js';

const store = new Store({ path: ':memory:' });

/** 构造一条能直接落库的归一化消息。 */
const message = (id, { senderId, name, text, ts, kind = 'text' }) => ({
  id,
  conversation: { id: 'digest@chatroom', kind: 'group', name: '日报验证群' },
  sender: { id: senderId, displayName: name },
  kind,
  direction: 'inbound',
  timestamp: ts,
  text,
  summary: text.slice(0, 80),
  mentions: [],
});

// 造「昨天」与「今天」两批数据：日报必须**只**覆盖昨天，
// 否则「日报里出现今天的消息」这种区间算错的问题会被漏过去。
const today = new Date();
today.setHours(12, 0, 0, 0);
const yesterday = today.getTime() - 24 * HOUR_MS;
const dayBefore = yesterday - 24 * HOUR_MS;

const rows = [
  message('y1', { senderId: 'u1', name: '张工', text: '昨天的项目进度同步', ts: yesterday }),
  message('y2', { senderId: 'u1', name: '张工', text: '昨天又要开个会讨论接口', ts: yesterday + HOUR_MS }),
  message('y3', { senderId: 'u2', name: '李设计', text: '昨天设计稿已经交付了', ts: yesterday + 2 * HOUR_MS }),
  message('t1', { senderId: 'u3', name: '今天的人', text: '今天的消息不该出现在日报里', ts: today.getTime() }),
  message('b1', { senderId: 'u4', name: '前天的人', text: '前天的消息也不该出现', ts: dayBefore }),
];
for (const row of rows) store.insertMessage(row, [], HOUR_MS);
store.insertEvent({
  conversation_id: 'digest@chatroom',
  member_id: 'u1',
  type: 'guard',
  severity: 'high',
  score: 40,
  detail: JSON.stringify({ ruleId: 'keyword-blocklist', reason: '命中敏感词: 刷单' }),
  ts: yesterday + HOUR_MS,
});

const window = previousDayWindow(today.getTime());
const report = buildDigest(store, 'digest@chatroom', window, { includeEmpty: false });
store.close();

if (!report) fail('日报为空：未找到会话');
if (report.totalMessages !== 3) fail(`日报区间含 ${report.totalMessages} 条，期望 3 条（只覆盖昨天）`);
if (!report.text.includes('日报')) fail('日报缺少标题');
if (!report.text.includes('张工')) fail('日报缺少发言排行');
if (!report.text.includes('keyword-blocklist')) fail('日报缺少风控事件摘要');
if (report.text.includes('今天的人')) fail('日报混入了今天的消息');
if (report.text.includes('前天的人')) fail('日报混入了前天的消息');
if (!report.label) fail('日报缺少日期标签');

process.stdout.write(`日报校验通过：区间 ${report.label}，覆盖 ${report.totalMessages} 条，含排行与风控摘要\n`);

function fail(message) {
  process.stderr.write(`日报校验失败：${message}\n`);
  process.exit(1);
}
