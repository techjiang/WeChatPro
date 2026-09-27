# 部署与运维

## 最小部署

```bash
git clone <repo> && cd WeChatPro
npm ci --omit=dev          # 或 npm ci && npm run build
npm run build
cp config.example.json config.json
# 编辑 config.json
node dist/cli.js start --config config.json
```

生产环境建议用进程管理器（systemd / pm2 / 容器编排）拉起 `node dist/cli.js start`，
它会在收到 `SIGINT`/`SIGTERM` 时优雅停止（关闭适配器与插件，关闭数据库）。

## 容器

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
ENV WECHATPRO_SQLITE_PATH=/data/wechatpro.db
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/cli.js", "start", "--config", "/app/config.json"]
```

`better-sqlite3` 是原生模块：若目标镜像没有预编译产物（Alpine 的 musl 通常没有），
构建阶段需要 python3 / make / g++。稳妥做法是构建用 `node:24-slim`、
运行用 `node:24-alpine` 并保留从构建阶段拷来的 `node_modules`。

## 安全清单

- [ ] `api.host` 为 `0.0.0.0` 时**必须**设置 `api.token`（否则引擎拒绝启动）
- [ ] 控制台建议放在反向代理后并启用 HTTPS
- [ ] `adapters[].options.token` 与 `api.token` 不要复用同一个值
- [ ] AI 的 `apiKey` 用环境变量 `WECHATPRO_AI_API_KEY` 注入，不要写进配置文件
- [ ] 客户端形态下 `api.host` 保持 `127.0.0.1`：面板与宿主同机，没必要对外监听
- [ ] `transport: "http"` 时必配 `token`（引擎会拒绝无 token 的非回环绑定）
- [ ] 排查完记得关掉 `host.options.dumpDir`，它会落盘原始聊天内容
- [ ] 数据目录权限收紧（含群成员与聊天内容）
- [ ] `corsOrigins` 只填需要的来源，不要用 `*`

## 数据与备份

单文件 SQLite（WAL 模式）。安全性最高的备份是停服复制，或在线执行：

```bash
sqlite3 data/wechatpro.db ".backup '/backup/wechatpro-$(date +%F).db'"
```

导出单个群的档案（会话 + 成员 + 群知识）：

```bash
node dist/cli.js export <conversationId> --out g1.json
```

## 容量规划

| 项 | 参考值 |
| --- | --- |
| 单条消息存储 | 约 200–500 字节（含索引） |
| 10 万条消息的报表查询 | 约 20ms |
| 建议单实例消息量 | 千万级以内 |

控制增长用 `manage.retainMessagesPerConversation`（如 `200000`）。
裁剪只影响原始消息表，统计预聚合与会话累计计数保留。

## 可观测性

- **日志**：结构化 JSON（pino）。调整 `logLevel` 控制详细度
- **健康检查**：`GET /health` 返回接收/接受/去重/失败计数、适配器列表、订阅者数量
- **引擎统计**：`GET /api/stats`
- **关键日志字段**：风控告警带 `rule`、`conversation`、`risk`；引擎错误带 `subscriber`

接入监控时重点看：

| 指标 | 异常含义 |
| --- | --- |
| `stats.duplicates` 持续增长 | 协议在重投，检查适配器时间戳/ID 稳定性 |
| `stats.failed` 增长 | 归一化失败（缺会话/发送者）或订阅者抛错，看 `engine.error` 日志 |
| `stats.received` 为 0 | 适配器未收到事件，检查中间件推送与 token |
| `listeners` 异常增长 | 插件被反复注册，检查是否重复调用 `start()` |

## 常见问题

**收不到消息** — 检查 `stats.received`。为 0 说明适配器没收到：核对中间件推送地址、
`x-wechatpro-token`、以及 `path` 配置。非 0 但 `accepted` 低，看 `failed` 与日志。

**消息数对不上** — `messages` 表已被 `retainMessagesPerConversation` 裁剪，
但会话计数是历史累计口径。核对原始消息请查 `messages` 表而非会话计数。

**群类型判成 private** — 适配器未提供 `conversationKind`，且群 ID 不含 `@chatroom`。
在 `mapping` 里补上 `conversationKind`，或让中间件推送该字段。

**告警太多/太少** — 调 `guard.alertThreshold`（总分门槛）或单条规则的 `weight`；
规则过密可用 `enabled: false` 单独关掉。

**AI 响应慢拖累链路** — AI 调用不在消息主链路上（插件内异步排队）。
若整体延迟高，调小 `ai.maxConcurrency` 或 `ai.timeoutMs`。
