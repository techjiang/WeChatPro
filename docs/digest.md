# 群日报

日报是引擎**唯一的主动推送**能力：默认每天早上 09:00（本地时区）把「昨天」
群里发生了什么推回群里，不必有人去翻面板。

```
定时触发（analytics.digestCron）
      ↓
逐个群构建日报（buildDigest，纯函数）
      ↓
跳过无消息的群 → 有内容的走发送通道
      ↓
记录 sent / skipped / failed，逐条记账互不影响
```

## 一、内容长什么样

```
📅 产品交流群 · 2026-09-26 日报

总消息 128 条｜活跃成员 17 人｜人均 7.53 条｜趋势 ↑ 升温

发言排行：
  🥇 张工 — 24 条（18.8%）
  🥈 李设计 — 19 条（14.8%）
  🥉 王产品 — 15 条（11.7%）

类型分布：text 112，image 9，link 7
时段分布：▁▁▁·▁▂▃▅█▆▄▃▂▄▆▅▄▃▂▁▁▁··（高峰 15:00）

热门话题：接口(18)、排期(11)、设计稿(9)、灰度(7)

⚠️ 风控事件 3 起：keyword-blocklist×2、contact-solicitation×1
  · 命中敏感词: 刷单（wxid_spam｜风险分 40）
  · 疑似导流话术: 加我微信（wxid_ads｜风险分 35）

👋 近三天新增 2 人
💤 沉默超两周 4 人（可考虑回访）
```

用纯文本而不是 Markdown 表格：日报要能直接发进微信群，而群聊里表格会因
字体比例错位；排行 + 条形图在手机上一眼就能读完。

## 二、口径

| 维度 | 口径 |
| --- | --- |
| 时间区间 | **自然日**：昨天 00:00 → 今天 00:00（本地时区） |
| 统计来源 | 预聚合表（`activity_buckets` / `word_stats`），不扫消息全表 |
| 风控事件 | 只统计落在区间内的事件，含命中规则与证据摘要 |
| 成员变动 | 近三天新增、沉默超两周（来自群档案，属实时口径） |

为什么用自然日而不是「最近 24 小时」：群主理解「昨天」就是 0 点到 0 点。
滚动窗口会让早上九点发出的日报混入昨天下午与今天凌晨两段时间，
与「昨天群里聊了什么」的直觉对不上，久而久之就没人看了。

为什么用本地时区：统一成 UTC 会让「昨晚 9 点高峰」在日报里显示成凌晨 3 点。

## 三、配置

```jsonc
{
  "analytics": {
    "enabled": true,
    "digestCron": "0 9 * * *",      // 5 段标准 cron，本地时区
    "digestDays": 1,                 // 1 = 只报昨天
    "digestConversationId": "",      // 留空 = 各自推回本群
    "digestIncludeEmpty": false,     // 无消息的群不推（否则每天早上收一堆空日报）
    "digestMaxConversations": 50     // 单次最多推几个群
  }
}
```

也可以用插件私有 options 覆盖（适合按环境区分）：

```jsonc
{
  "plugins": [
    { "name": "analytics", "enabled": true,
      "options": { "digestCron": "0 9 * * *", "digestConversationId": "admin@chatroom" } }
  ]
}
```

优先级：插件 `options` > 顶层 `analytics` > 内置默认。

环境变量：`WECHATPRO_DIGEST_CRON`。

## 四、发送通道

日报走 `Engine.sendMessage()`，也就是**适配器的 `send` 能力**：

| 形态 | 走哪条通道 | 前提 |
| --- | --- | --- |
| PC 客户端插件 | 宿主原生发送 `nativeSend` | 插件壳注册了该能力 |
| HTTP 中间件 | `outboundUrl` 回调 | 适配器配了 `outboundUrl` |
| 仅接收（不配出站） | 无 | 发送返回 `false`，日志记 warning |

**没有发送通道时日报不会报错，只是发不出去**（`failed` 计数 + 日志）。
这是刻意的：日报失败不该影响统计、风控与面板。

## 五、排障

某天早上没收到日报，按顺序看三处：

```bash
node dist/cli.js doctor                    # 「日报调度」一项：cron 是否合法、覆盖天数
node dist/cli.js digest                    # 现在应该产出什么内容（同一段渲染代码）
grep analytics-daily-digest app.log         # 调度日志：sent / skipped / failed
```

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 完全没触发 | cron 表达式非法（启动时只有一条 warning） | `doctor` 看「日报调度」，改成 5 段标准 cron |
| 触发了但 `sent: 0, skipped: N` | 昨天这些群都没消息 | 预期行为；想每天都收到可开 `digestIncludeEmpty` |
| `failed: N` | 没有发送通道 / 发送报错 | 检查适配器 `send` 能力或 `outboundUrl` |
| 内容里数字明显偏少 | 昨天消息被留存策略裁掉了原始行 | 日报读的是预聚合表，与 `messages` 裁剪无关；核对是否调过 `hourlyBuckets` |
| 日报时间是凌晨 | `digestCron` 按 UTC 写了 | 表达式按**本地时区**解释，写成 `0 17 * * *` 才是 UTC 9 点 |
