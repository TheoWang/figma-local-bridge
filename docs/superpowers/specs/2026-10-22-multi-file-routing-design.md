# 多文件路由（Multi-File Routing）设计 — v0.2.0

日期：2026-10-22
状态：已评审（方案 A，默认路由语义经用户确认）

## 背景与目标

v0.1.x 的中继是"单插件会话"模型：`state` 只记录一个插件（单数 `pluginFileName`），命令队列全局唯一。两个文件同时运行插件时，命令会被随机投递给其中一个文件，无法指定目标。

目标：让 Agent（如双文件设计对比场景）能向**指定的 Figma 文件**投递命令，同时：

1. 现有单文件用法零变化（无 `target` 时恰好一个文件在线则自动路由）。
2. 不引入新的内存泄露面——逐条对上 v0.1.1 的三处泄露教训。
3. 长轮询架构、心跳、队列 TTL、`relayBootId` 重握手机制全部保留。

非目标（YAGNI）：不做一条命令同时发多文件；不做插件 UI；不做多端口；不做会话持久化；不做双栈协议兼容。

## 方案：单中继 + 会话路由表

插件 `/hello` 携带文件身份，中继为每个插件实例登记一条 session，命令按 `target.fileKey` 路由到对应会话的挂起 poll 或会话队列。

### 为什么不是"只认 fileKey 不要 sessionId"（方案 B）

同一文件可在两个 tab / 桌面+网页端各跑一个插件实例，fileKey 相同。无 sessionId 时只能"后注册顶替"，被踢一侧的挂起 poll 行为无法被中继识别。sessionId 成本极低（插件侧两个标量），换来多实例可区分、可诊断。

## 协议变化（插件 ↔ 中继，破坏性，双方同升 0.2.0）

### 插件侧新增状态

仅两个标量，无累积结构：

- `instanceId`：插件启动时生成的随机短串（6 位 base36），进程内不变。
- `sessionId`：hello 响应中获得，后续 poll/result 携带。

### `GET /hello?fileKey&fileName&version&instanceId`

- `fileKey` 取 `figma.fileKey`；取不到（理论上 design 文件必有）退化为 `name:<fileName>`。
- 中继生成 `sessionId = "${fileKey}:${instanceId}"`（可读，便于日志排查）。
- 响应：`{ ok: true, sessionId, relayBootId }`。
- 同一 `sessionId` 重复 hello：覆盖式刷新登记（插件重握手的正常路径）。

### `GET /poll?sessionId=…`

- 缺 `sessionId`（即 0.1.x 旧插件）→ **400** `{ ok: false, error: "协议过旧，请升级插件到 0.2.0（重新 install-plugin 并重启插件）" }`。旧插件收到无 `command` 的响应会继续轮询；发现通道是 `doctor` 的现有版本一致性检查。
- `sessionId` 未知/已被驱逐 → 200 `{ command: null, sessionExpired: true, relayBootId }`，插件立即重新 `/hello`。
- 正常：刷新 `seenAt`，沿用现有长轮询（挂起至多 25s），响应 `{ command, relayBootId }`；`relayBootId` 变化重握手逻辑不变。

### `POST /result`

body 增加 `sessionId`：`{ id, sessionId, ok, result, error }`。

- 按 `id` 查 inflight；条目不存在直接忽略（与现状一致）。
- `inflight[id].sessionId !== msg.sessionId` → 丢弃，不向 CLI 转发（防串话；仍回 200 不打断插件循环）。
- 命中：删条目、清 timer、转发 CLI，并刷新该 session 的 `seenAt`。

### CLI → 中继命令信封

`{ role: "cli", command: { action, params?, target?: { fileKey } } }`

**路由规则**（用户已确认）：

| 情形 | 行为 |
|---|---|
| 有 `target.fileKey`，该文件有活会话 | 投递到该 fileKey 最近活跃的会话（同文件多 tab 时） |
| 有 `target.fileKey`，无活会话 | 报错"目标文件不在线"，附在线文件清单 |
| 无 `target`，活会话 = 1 | 自动路由（现有单文件用法零变化） |
| 无 `target`，活会话 = 0 | 报错"Figma 插件未连接…"（现有文案） |
| 无 `target`，活会话 > 1 | 报错并附在线文件清单，要求显式指定 |

活会话判定沿用现有口径：`Date.now() - seenAt < pollHoldMs + 10000`。

### `__status` 响应（doctor / list-files 用）

```json
{
  "serverVersion": "0.2.0",
  "port": 9741,
  "pluginAlive": true,
  "sessions": [
    {
      "sessionId": "abc123:x7k2p9",
      "fileKey": "abc123",
      "fileName": "设计稿 A",
      "pluginVersion": "0.2.0",
      "lastSeenAt": "2026-10-22T10:00:00.000Z",
      "queuedCommands": 0
    }
  ]
}
```

`pluginAlive` = 存在任一活会话。旧的单数字段（`pluginFileName`/`pluginVersion`/`pluginLastSeenAt`）移除，doctor 同步改造。

## 中继内部结构与生命周期（内存防护核心）

```js
sessions = Map<sessionId, {
  fileKey, fileName, instanceId, version, seenAt,
  waitingPoll: null | { res, timer },  // 每会话至多一个挂起 poll
  queue: [],                           // 该会话待投递命令 [{ id, command, cliSocket, enqueuedAt }]
}>
inflight = Map<id, { cliSocket, timer, sessionId }>  // 保持全局，id 路由 + sessionId 校验
```

四条防护逐条对应 v0.1.1 教训：

1. **Session TTL 驱逐扫描器**（对应"失联命令连 cliSocket 滞留"）：15s 周期（复用 `QUEUE_SWEEP_MS` 节奏）。每会话先按 FIFO 逐出 60s 过期 queue 条目并向 CLI 报错（现有逻辑的按会话版）；`seenAt` 超 **90s** 的 session 整体驱逐——清 `waitingPoll.timer`、给挂起 poll 回 `{ command: null, sessionExpired: true, relayBootId }`（与 poll 时的失效响应同形）、拒绝其 queue 与 inflight 中全部命令（CLI 收"插件会话已失效"）、从 Map 删除。插件下一轮 poll 发现失效自动重握手，无感恢复。
2. **每会话队列上限 50 条**（新增）：超出直接拒绝，CLI 收"该文件命令队列已满（50）"；任何队列不无界增长。
3. **每会话单 poll 槽位 + `close` 清理**（对应"并发 poll 互覆盖"）：插件本就串行轮询，新 poll 到达时旧引用已被 `req.on('close')` 清理；`close` 里清 timer 并摘掉 `session.waitingPoll`。
4. **工厂 `close()` 全量清 timer**（测试防挂起）：驱逐扫描器、心跳、各 session 的 poll timer、全部 inflight timer，一个不漏。

`sessions` 规模被人手打开的文件 tab 数天然封顶（个位数），加驱逐扫描，Map 不单调增长。

## CLI / Agent 接口

- `figma-bridge list-files`（新）：发 `__status`，打印在线会话表（fileKey / fileName / 版本 / lastSeen / 排队数）。
- `figma-bridge send '<json>'`：JSON 里可带 `target: { fileKey }`。
- `figma-bridge send --file <选择器> '<json>'`：选择器为 fileKey 精确值或文件名唯一子串（大小写不敏感）。CLI 在同一条 WS 上先发 `__status` 解析出唯一 fileKey 注入 `target`，再发命令；子串匹配到多个则报错并列候选。**模糊匹配只在 CLI 这层，中继协议只认 fileKey。**
- `render` / `export` 同样支持 `--file`（同一套解析管道，对比场景需要）。
- `doctor`：列出全部在线会话，逐个检查插件/中继版本一致性。

`src/client.js` 的 `sendOne(command)` 签名不变，调用方在 command 里带 `target` 即可。

## 版本与升级

- `plugin/code.js`、`src/server.js`、`package.json` 同升 **0.2.0**；CHANGELOG 标注破坏性变更与升级动作（`install-plugin` + 重启插件）。
- manifest 不变（无 UI、`devAllowedDomains` 仍只需 9741）。

## 测试计划（node:test，现有 9 例基础上扩展）

新增用例：

1. hello 注册会话，`__status`/`sessions` 正确列出。
2. 同 fileKey 两个实例 hello，target 路由取最近活跃会话。
3. target 路由隔离：发向 A 的命令不会被 B 的 poll 取走。
4. 无 target 三分支：单在线自动路由；零在线报错；多在线报错且含文件清单。
5. 无 `sessionId` 的 poll 返回 400。
6. session 驱逐：失联 session 的 queue 命令被拒释放、挂起 poll 收到 `sessionExpired`、其 inflight 命令被拒；驱逐后该 sessionId 的 poll 得到 `sessionExpired`。
7. 每会话队列上限 50，第 51 条被拒。
8. `/result` 的 sessionId 与 inflight 不符时被丢弃（CLI 收到超时而非错误结果）。
9. `close()` 后无残留 timer（沿用现有断言模式）。
