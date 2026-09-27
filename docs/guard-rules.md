# 检测规则

## 判定模型

```
单条消息 → 逐条规则求值 → 每条命中给「权重」
                              ↓
              按成员在滑动窗口内累计风险分
                              ↓
        风险分 ≥ alertThreshold → 产生告警 + 落库事件
```

这样设计的原因：单条可疑消息直接处罚误伤率过高。累计打分让
「偶尔发一次链接」与「十分钟内发五次链接」得到不同处置。

规则是**纯函数** `(消息, 配置, 历史窗口) → 判定`，可单测、可复现、可热插拔。

## 内置规则

| id | 说明 | 默认动作 | 默认权重 | 关键 options |
| --- | --- | --- | --- | --- |
| `keyword-blocklist` | 命中敏感词表 | alert | 40 | `words: string[]`、`weight` |
| `link-flood` | 短时间重复发链接 | warn | 25 | `windowMs`(300000)、`threshold`(3) |
| `burst-spam` | 刷屏：短时间高频发言 | mute-suggest | 20 | `windowMs`(60000)、`threshold`(10) |
| `duplicate-content` | 同一条内容反复发送 | warn | 15 | `windowMs`(600000)、`threshold`(3)、内容需 ≥4 字 |
| `silent-hours` | 静默时段发言 | alert | 10 | `startHour`(23)、`endHour`(6)、`minChars`(5) |
| `mention-storm` | 单条消息 @ 大量成员 | warn | 30 | `threshold`(5) |
| `media-flood` | 短时间大量图片/视频/文件 | warn | 20 | `windowMs`(180000)、`threshold`(8) |
| `contact-solicitation` | 导流话术 | alert | 35 | `patterns: string[]`（留空用内置词表） |

> `threshold` 语义是「窗口内已存在 N 条时，第 N+1 条触发」。
> 例如 `link-flood.threshold = 3`：发第 4 条链接时命中。

> `silent-hours` 支持跨零点区间（`startHour=23, endHour=6` 判断为 `hour>=23 || hour<6`）。

## 覆盖内置规则的配置

同 id 的配置会覆盖内置默认值：

```json
{
  "id": "keyword-blocklist",
  "enabled": true,
  "action": "alert",
  "weight": 50,
  "description": "行业敏感词",
  "options": { "words": ["刷单", "博彩", "赌球", "代开发票"] }
}
```

`enabled: false` 可单独关闭某条内置规则。

## 自定义词表规则（无需写代码）

配置里出现内置不存在的 `id` 且带 `options.words` 时，自动按词表规则处理：

```json
{
  "id": "my-industry-words",
  "description": "本行业违规词",
  "action": "warn",
  "weight": 25,
  "options": { "words": ["竞品A", "竞品B"] }
}
```

匹配为**大小写不敏感的子串包含**。

## 处置动作

| 动作 | 语义 |
| --- | --- |
| `alert` | 记录并通知管理员（默认） |
| `warn` | 记录，提示程度较低 |
| `mute-suggest` | 建议禁言 |
| `revoke-suggest` | 建议撤回消息 |
| `kick-suggest` | 建议移除成员 |

**引擎默认不执行自动处罚**。原因：群聊里一次错误禁言会让群主失去信任，
漏报只是晚一步发现。开启 `plugins.guard.options.autoActions` 后也只执行
「发提醒」这一可撤销动作；禁言/踢人需要接入你自己的协议能力。

```json
{
  "name": "guard",
  "options": {
    "autoActions": true,
    "actionTargets": { "alert": ["群ID或管理员会话ID"] }
  }
}
```

## 严重度分档

| 累计风险分 | severity |
| --- | --- |
| ≥ 80 | `high` |
| ≥ 50 | `medium` |
| < 50 | `low` |

## 查看与排查

```bash
node dist/cli.js rules --config config.json            # 配置里的规则
curl -s localhost:8787/api/rules                       # 阈值与规则
curl -s 'localhost:8787/api/conversations/g1/events'    # 近期事件（含命中原因与证据）
```

事件的 `detail` 字段保存了 `ruleId`、`reason`、`evidence` 与 `messageId`，
可据此复现判定过程。
