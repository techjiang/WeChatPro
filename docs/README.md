# 文档索引

| 文档 | 读它来解决什么 |
|---|---|
| [pc-client.md](./pc-client.md) | **在微信 PC 客户端内使用与管理**：快速开始、三种注入路径、字段映射、宿主能力降级、排障 |
| [architecture.md](./architecture.md) | 架构分层与关键设计取舍：为什么用预聚合、为什么默认不自动处罚、为什么不上向量库 |
| [configuration.md](./configuration.md) | 配置项逐条说明与默认值 |
| [guard-rules.md](./guard-rules.md) | 8 条内置检测规则的行为、阈值调优、自定义词表 |
| [digest.md](./digest.md) | **群日报**：推送时间、覆盖口径、推送目标、排障 |
| [deployment.md](./deployment.md) | 部署形态、数据备份、留存策略、安全注意 |

其它：

- [`../brand/README.md`](../brand/README.md) — 品牌资源与图标生成
- [`../examples/README.md`](../examples/README.md) — 可直接运行的示例

## 按场景找

| 我想… | 看这里 |
|---|---|
| 让插件在微信里跑起来 | [pc-client.md § 快速开始](./pc-client.md#二快速开始) |
| 写客户端插件壳 | [pc-client.md § 接入真实客户端](./pc-client.md#三接入真实客户端三种注入路径) + [`examples/host-shell.ts`](../examples/host-shell.ts) |
| 换个微信版本，字段名不一样 | [pc-client.md § 字段映射](./pc-client.md#四宿主要实现的字段映射) |
| 客户端没提供某个 API | [pc-client.md § 宿主能力与降级](./pc-client.md#五宿主能力与降级) |
| 插件装了但没反应 | [pc-client.md § 排障](./pc-client.md#九排障) → 先跑 `wechatpro doctor` |
| 调风控阈值 | [guard-rules.md](./guard-rules.md) |
| 日报几点发、发给谁、某天没收到 | [digest.md](./digest.md) |
| 数据放哪、怎么备份 | [deployment.md](./deployment.md) |
