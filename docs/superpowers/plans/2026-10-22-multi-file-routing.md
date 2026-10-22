# 多文件路由（v0.2.0）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让中继把命令按 `target.fileKey` 路由到指定的 Figma 文件（多插件会话），并保持 v0.1.1 以来的全部内存防护。

**Architecture:** 单中继 + 会话路由表。插件 hello 携带 `fileKey/instanceId`，中继下发 `sessionId`（`${fileKey}:${instanceId}`），poll/result 携带之；中继内 `sessions: Map` 每会话独立 queue/waitingPoll，命令按 target 或"单在线自动路由"语义投递。

**Tech Stack:** Node.js（无新增运行时依赖）、`ws`、`node:test`。

**Spec:** [docs/superpowers/specs/2026-10-22-multi-file-routing-design.md](../specs/2026-10-22-multi-file-routing-design.md)

## Global Constraints

- 零新增运行时依赖；测试用 `node --test test/` 运行。
- 协议为破坏性变更：`plugin/code.js` 的 `PLUGIN_VERSION`、`package.json` 的 `version` 在 Task 7 同升 **0.2.0**；`plugin/manifest.json` 不变。
- 默认端口 9741 不变；插件 `SERVER` 不变。
- 既有内存防护全部保留：WS `error` 监听、30s 心跳、queue TTL 扫描、`close()` 全量清 timer。
- 错误文案逐字锁定（各 Task 测试按正则断言，跨任务不得改文案）：
  - `协议过旧：请升级插件到 0.2.0（重新 install-plugin 并在 Figma 中重启插件）`
  - `Figma 插件未连接：请先在 Figma 中运行「Figma Local Bridge」插件并保持打开`
  - `目标文件不在线（fileKey: ${fileKey}）。在线文件：${describeSessions(alive)}`
  - `多个文件在线（${describeSessions(alive)}），请在命令中携带 target: { fileKey } 指定目标`
  - `该文件命令队列已满（${sessionQueueMax}）`
  - `插件会话已失效（插件失联）`
- 提交信息用中文 conventional commits（feat:/fix:/test:/docs:/chore:），每个 Task 末尾提交一次。
- 分支：`feat/multi-file-routing`（spec 已提交于 d68709b）。

## 实现注记（对 spec 的两处细化，行为不变）

1. spec 说 `--file` 解析"在同一条 WS 上先发 `__status`"——实现用**两次独立 `sendOne`**（复用现有函数，行为等价，省去客户端 FIFO 配对逻辑）。
2. 同 fileKey 多实例路由，spec 说"最近活跃"——实现改为按 `registeredAt`（hello 时刻）降序取最近注册者。poll 会持续刷新 `seenAt`，按 seenAt 排序是竞态；registeredAt 是确定性的，语义等同"后启动的实例优先"。

---

### Task 1: 协议支点——中继会话化 + 测试 harness 迁移

这是原子任务：sessions Map、hello/poll/result 新协议、按会话投递、`__status` sessions 数组必须一起落地，否则既有 11 个测试无法转绿。本任务**不含**会话驱逐与队列上限（Task 4 做，那里有自己的红-绿循环）。

**Files:**
- Modify: `src/server.js`（createBridgeServer 内部全面改造）
- Test: `test/server.test.js`（helper 升级 + 既有测试迁移 + 3 个新协议测试）

**Interfaces:**
- Consumes: 现有 `createBridgeServer(options)` 工厂与 FAST 定时器注入模式。
- Produces（后续任务依赖的确切形状）:
  - session 对象：`{ sessionId, fileKey, fileName, instanceId, version, seenAt, registeredAt, waitingPoll: null|{res,timer}, queue: [] }`
  - `sessionId` 格式：`${fileKey}:${instanceId}`（缺省 instanceId 为 `anon`；缺省 fileKey 退化为 `name:<fileName>`）
  - `__status` 结果：`{ serverVersion, port, pluginAlive, sessions: [{ sessionId, fileKey, fileName, pluginVersion, lastSeenAt, alive, queuedCommands }] }`
  - 测试 helper：`hello(base, opts?) → sessionId`、`hangPoll(base, sessionId)`、`autoPoller(base, sessionId)`
  - 中继函数：`aliveSessions()`、`describeSessions(list)`、`pickTargetSession(command) → { session } | { error }`、`deliverToPlugin(res, item)`

- [ ] **Step 1: 升级测试 helper（hello/hangPoll/autoPoller 带 sessionId）**

`test/server.test.js` 顶部 helper 替换为：

```js
async function hello(base, { fileKey = 'testFileKey', fileName = '测试文件', instanceId = 'inst1', version = '0.0.0-test' } = {}) {
  const r = await fetch(`${base}/hello?fileKey=${encodeURIComponent(fileKey)}&fileName=${encodeURIComponent(fileName)}&version=${version}&instanceId=${instanceId}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.sessionId, 'hello 响应缺 sessionId');
  return body.sessionId;
}

function hangPoll(base, sessionId) {
  const ac = new AbortController();
  const done = fetch(`${base}/poll?sessionId=${encodeURIComponent(sessionId)}`, { signal: ac.signal })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  return { done, abort: () => ac.abort() };
}

function autoPoller(base, sessionId) {
  const commands = [];
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await fetch(`${base}/poll?sessionId=${encodeURIComponent(sessionId)}`);
        const body = await r.json();
        if (body && body.command) {
          commands.push(body.command);
          await fetch(`${base}/result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: body.command.id, sessionId, ok: true, result: { ack: body.command.action } }),
          });
        }
      } catch {
        await sleep(30);
      }
    }
  })();
  return { commands, stop: () => { stopped = true; } };
}
```

- [ ] **Step 2: 写 3 个新协议测试（此时应失败）**

追加到测试文件末尾：

```js
test('hello 注册会话：__status 的 sessions 含 fileKey/fileName/alive', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const sid = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'i1' });
    assert.equal(sid, 'fkA:i1');
    const m = await sendOne(port, { action: '__status' });
    assert.equal(m.ok, true);
    assert.equal(m.result.pluginAlive, true);
    assert.equal(m.result.sessions.length, 1);
    const s = m.result.sessions[0];
    assert.equal(s.sessionId, 'fkA:i1');
    assert.equal(s.fileKey, 'fkA');
    assert.equal(s.fileName, '文件A');
    assert.equal(s.alive, true);
    assert.equal(s.queuedCommands, 0);
  } finally {
    await bridge.close();
  }
});

test('poll 缺 sessionId 返回 400（旧协议拒绝）', async () => {
  const { bridge, base } = await startBridge();
  try {
    const r = await fetch(`${base}/poll`);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /协议过旧/);
  } finally {
    await bridge.close();
  }
});

test('未知 sessionId 的 poll 收到 sessionExpired', async () => {
  const { bridge, base } = await startBridge();
  try {
    const r = await fetch(`${base}/poll?sessionId=nope:x`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.sessionExpired, true);
    assert.equal(body.command, null);
    assert.ok(body.relayBootId);
  } finally {
    await bridge.close();
  }
});
```

- [ ] **Step 3: 运行确认新测试失败**

Run: `node --test test/`
Expected: 新 3 例 FAIL（`/hello` 尚无 sessionId；`/poll` 无 400/sessionExpired 逻辑），既有测试因 helper 变更大面积 FAIL——正常，Step 5 统一迁移。

- [ ] **Step 4: 重写 `src/server.js` 的 createBridgeServer 内部**

常量区追加：

```js
const SESSION_EVICT_MS = 90 * 1000;  // Task 4 接线，本任务先定义
const SESSION_QUEUE_MAX = 50;        // Task 4 接线
```

工厂内状态替换（删除 `state`/`queue`/`waitingPolls` 三处旧定义）：

```js
const sessions = new Map();  // sessionId -> session（形状见 Interfaces）
const inflight = new Map();  // id -> { id, command, cliSocket, enqueuedAt, sessionId, timer }
```

查询串解析 helper（模块级）：

```js
function queryOf(url) {
  const out = {};
  const i = url.indexOf('?');
  if (i < 0) return out;
  for (const pair of url.slice(i + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}
```

会话判定与路由 helper（工厂内）：

```js
const aliveSessions = () => {
  const now = Date.now();
  return [...sessions.values()].filter((s) => now - s.seenAt < pollHoldMs + 10000);
};

const describeSessions = (list) =>
  list.length ? list.map((s) => `${s.fileName}（fileKey: ${s.fileKey}）`).join('、') : '（无）';

const pickTargetSession = (command) => {
  const alive = aliveSessions();
  const fileKey = command.target && command.target.fileKey;
  if (fileKey) {
    const matches = alive
      .filter((s) => s.fileKey === fileKey)
      .sort((a, b) => b.registeredAt - a.registeredAt);
    if (!matches.length) {
      return { error: `目标文件不在线（fileKey: ${fileKey}）。在线文件：${describeSessions(alive)}` };
    }
    return { session: matches[0] };
  }
  if (alive.length === 0) {
    return { error: 'Figma 插件未连接：请先在 Figma 中运行「Figma Local Bridge」插件并保持打开' };
  }
  if (alive.length > 1) {
    return { error: `多个文件在线（${describeSessions(alive)}），请在命令中携带 target: { fileKey } 指定目标` };
  }
  return { session: alive[0] };
};
```

`/hello` handler 替换：

```js
if (req.method === 'GET' && req.url.startsWith('/hello')) {
  const q = queryOf(req.url);
  const fileName = decodeURIComponent(q.fileName || '未知');
  const fileKey = q.fileKey ? decodeURIComponent(q.fileKey) : `name:${fileName}`;
  const instanceId = q.instanceId || 'anon';
  const version = q.version || '未知';
  const sessionId = `${fileKey}:${instanceId}`;
  const now = Date.now();
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.fileName = fileName;
    existing.version = version;
    existing.seenAt = now;
    existing.registeredAt = now;
  } else {
    sessions.set(sessionId, {
      sessionId, fileKey, fileName, instanceId, version,
      seenAt: now, registeredAt: now, waitingPoll: null, queue: [],
    });
  }
  const mismatch = version !== '未知' && version !== SERVER_VERSION;
  log(`[中继] Figma 插件已上线（文件：${fileName}，fileKey: ${fileKey}，插件 v${version}）${mismatch ? ` ⚠️ 与中继 v${SERVER_VERSION} 版本不一致，请重新导入插件` : ''}`);
  return sendJson(res, 200, { ok: true, sessionId, relayBootId: bootId });
}
```

`/poll` handler 替换（注意 URL 从精确匹配改为 `startsWith`，因为带查询串）：

```js
if (req.method === 'GET' && req.url.startsWith('/poll')) {
  const q = queryOf(req.url);
  const sid = q.sessionId ? decodeURIComponent(q.sessionId) : null;
  if (!sid) {
    return sendJson(res, 400, { ok: false, error: '协议过旧：请升级插件到 0.2.0（重新 install-plugin 并在 Figma 中重启插件）' });
  }
  const session = sessions.get(sid);
  if (!session) {
    return sendJson(res, 200, { command: null, sessionExpired: true, relayBootId: bootId });
  }
  session.seenAt = Date.now();
  const item = session.queue.shift();
  if (item) return deliverToPlugin(res, item);
  // 没有命令：挂起等待。每会话至多一个挂起 poll（插件串行轮询）。
  const entry = { res };
  entry.timer = setTimeout(() => {
    if (session.waitingPoll === entry) session.waitingPoll = null;
    sendJson(res, 200, { command: null, relayBootId: bootId });
  }, pollHoldMs);
  session.waitingPoll = entry;
  req.on('close', () => {
    clearTimeout(entry.timer);
    if (session.waitingPoll === entry) session.waitingPoll = null;
  });
  return;
}
```

`/result` handler 替换（sessionId 归属校验 + 刷新 seenAt）：

```js
if (req.method === 'POST' && req.url === '/result') {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { ok: false });
    }
    const session = msg.sessionId && sessions.get(msg.sessionId);
    if (session) session.seenAt = Date.now();
    const item = inflight.get(msg.id);
    if (item && item.sessionId === msg.sessionId) {
      inflight.delete(msg.id);
      clearTimeout(item.timer);
      safeSend(item.cliSocket, { id: msg.id, ok: msg.ok, result: msg.result, error: msg.error });
    }
    sendJson(res, 200, { ok: true });
  });
  return;
}
```

`deliverToPlugin` 不变（item 上已带 sessionId），删除 `flushQueueToPoll`。队列 TTL 扫描器改为按会话（`queueSweeper` 替换）：

```js
const queueSweeper = queueTtlMs > 0
  ? setInterval(() => {
      const deadline = Date.now() - queueTtlMs;
      for (const session of sessions.values()) {
        while (session.queue.length && session.queue[0].enqueuedAt <= deadline) {
          const item = session.queue.shift();
          safeSend(item.cliSocket, { id: item.id, ok: false, error: `命令超时（${queueTtlMs / 1000}s 未被插件取走）` });
        }
      }
    }, Math.min(QUEUE_SWEEP_MS, queueTtlMs / 2))
  : null;
```

WS `message` handler 中 `msg.role === 'cli'` 分支替换：

```js
if (msg.role === 'cli' && msg.command) {
  const id = nextId++;
  if (msg.command.action === '__status') {
    const now = Date.now();
    safeSend(socket, {
      id,
      ok: true,
      result: {
        serverVersion: SERVER_VERSION,
        port: currentPort(),
        pluginAlive: aliveSessions().length > 0,
        sessions: [...sessions.values()].map((s) => ({
          sessionId: s.sessionId,
          fileKey: s.fileKey,
          fileName: s.fileName,
          pluginVersion: s.version,
          lastSeenAt: s.seenAt ? new Date(s.seenAt).toISOString() : null,
          alive: now - s.seenAt < pollHoldMs + 10000,
          queuedCommands: s.queue.length,
        })),
      },
    });
    return;
  }
  const picked = pickTargetSession(msg.command);
  if (picked.error) {
    safeSend(socket, { id, ok: false, error: picked.error });
    return;
  }
  const session = picked.session;
  const item = { id, command: msg.command, cliSocket: socket, enqueuedAt: Date.now(), sessionId: session.sessionId };
  if (session.waitingPoll) {
    const entry = session.waitingPoll;
    session.waitingPoll = null;
    clearTimeout(entry.timer);
    deliverToPlugin(entry.res, item);
  } else {
    session.queue.push(item);
  }
  return;
}
```

`close()` 替换（清 sessions 内全部 timer）：

```js
async close() {
  if (queueSweeper) clearInterval(queueSweeper);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const session of sessions.values()) {
    if (session.waitingPoll) clearTimeout(session.waitingPoll.timer);
    session.waitingPoll = null;
    session.queue.length = 0;
  }
  sessions.clear();
  for (const item of inflight.values()) clearTimeout(item.timer);
  inflight.clear();
  for (const socket of wss.clients) socket.terminate();
  await new Promise((resolve) => wss.close(() => resolve()));
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
},
```

- [ ] **Step 5: 迁移既有 11 个测试到新协议**

逐处改动（机械替换）：

- 每个测试里 `await hello(base);` → `const sid = await hello(base);`
- `hangPoll(base)` → `hangPoll(base, sid)`；`autoPoller(base)` → `autoPoller(base, sid)`
- 手写 `/result` POST 的 body 增加 `sessionId: sid`
- 「`__status`：hello 后插件在线、端口正确」：删 `pluginFileName` 断言，改断言 `m.result.sessions[0].fileName === '测试文件'` 与 `m.result.pluginAlive === true`
- 「poll 响应携带 relayBootId…」与「命令投递响应同样携带 relayBootId」：`fetch(`${base}/poll`)` → `fetch(`${base}/poll?sessionId=${sid}`)`，并先取 sid
- 「双 poller」测试：两个 autoPoller 用**同一个 sid**（同会话双 poll，语义不变）
- 「孤儿 poll」：a、b 两个 hangPoll 同 sid；断言不变
- 「close() 释放端口」测试保持原样

- [ ] **Step 6: 运行全部测试确认转绿**

Run: `node --test test/`
Expected: 14 例全部 PASS（11 迁移 + 3 新增），进程正常退出（看门狗静默）。

- [ ] **Step 7: 提交**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: 中继会话化——hello/poll 携带 sessionId，命令按 target.fileKey 路由"
```

---

### Task 2: 路由语义测试加固

Task 1 已实现 `pickTargetSession` 全部分支；本任务用多会话场景做语义验证，若暴露缺口则修补。

**Files:**
- Test: `test/server.test.js`
- Modify（仅当测试暴露缺口时）: `src/server.js` 的 `pickTargetSession`

**Interfaces:**
- Consumes: Task 1 的 `hello(base, opts)`、`autoPoller(base, sid)`、`sendOne(port, command)`；错误文案见 Global Constraints。
- Produces: 无新接口。

- [ ] **Step 1: 写 4 个路由测试**

```js
test('target 路由：发向 A 的命令不会被 B 取走', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const sidA = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    const sidB = await hello(base, { fileKey: 'fkB', fileName: '文件B', instanceId: 'iB' });
    const a = autoPoller(base, sidA);
    const b = autoPoller(base, sidB);
    const reply = await sendOne(port, { action: 'ping', target: { fileKey: 'fkA' } });
    assert.equal(reply.ok, true);
    await sleep(100);
    assert.equal(a.commands.length, 1);
    assert.equal(b.commands.length, 0, 'B 不应收到命令');
    a.stop(); b.stop();
  } finally {
    await bridge.close();
  }
});

test('无 target 且多文件在线：报错并附文件清单', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    await hello(base, { fileKey: 'fkB', fileName: '文件B', instanceId: 'iB' });
    const reply = await sendOne(port, { action: 'ping' });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /target: \{ fileKey \}/);
    assert.match(reply.error, /文件A/);
    assert.match(reply.error, /文件B/);
  } finally {
    await bridge.close();
  }
});

test('target 文件不在线：报错并附在线清单', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    const reply = await sendOne(port, { action: 'ping', target: { fileKey: 'fkGhost' } });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /不在线/);
    assert.match(reply.error, /文件A/);
  } finally {
    await bridge.close();
  }
});

test('同 fileKey 多实例：路由到最近注册的会话', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const sid1 = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'i1' });
    await sleep(30);
    const sid2 = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'i2' });
    const p1 = autoPoller(base, sid1);
    const p2 = autoPoller(base, sid2);
    const reply = await sendOne(port, { action: 'ping', target: { fileKey: 'fkA' } });
    assert.equal(reply.ok, true);
    await sleep(100);
    assert.equal(p2.commands.length, 1, '应投递给最近注册的实例 i2');
    assert.equal(p1.commands.length, 0);
    p1.stop(); p2.stop();
  } finally {
    await bridge.close();
  }
});
```

- [ ] **Step 2: 运行确认 4 例全部通过**

Run: `node --test test/`
Expected: 18 例全部 PASS。若有 FAIL，修 `pickTargetSession` 至转绿（不得改错误文案）。

- [ ] **Step 3: 提交**

```bash
git add test/server.test.js src/server.js
git commit -m "test: 多会话路由语义——隔离/多在线报错/目标不在线/同文件多实例"
```

---

### Task 3: 结果归属校验测试加固

Task 1 已在 `/result` 实现 sessionId 校验；本任务补防串话测试。

**Files:**
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: Task 1 全部 helper。
- Produces: 无新接口。

- [ ] **Step 1: 写防串话测试**

```js
test('/result 的 sessionId 不符时被丢弃，CLI 按超时处理', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const sid = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    const p = hangPoll(base, sid);
    const t0 = Date.now();
    const replyP = sendOne(port, { action: 'ping' });
    const delivered = await p.done;
    // 伪造别的 sessionId 回结果：应被丢弃，CLI 走 commandTimeoutMs 超时
    await fetch(`${base}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: delivered.body.command.id, sessionId: 'fkA:evil', ok: true, result: { forged: true } }),
    });
    const reply = await replyP;
    assert.equal(reply.ok, false);
    assert.match(reply.error, /超时/);
    assert.ok(Date.now() - t0 >= 550, `过快返回：${Date.now() - t0}ms`);
  } finally {
    await bridge.close();
  }
});
```

- [ ] **Step 2: 运行确认通过**

Run: `node --test test/`
Expected: 19 例全部 PASS。

- [ ] **Step 3: 提交**

```bash
git add test/server.test.js
git commit -m "test: /result 归属校验——伪造 sessionId 的结果被丢弃"
```

---

### Task 4: 会话生命周期与内存防护（驱逐 + 队列上限）

本任务有真正的红-绿循环：先写测试（当前实现没有驱逐/上限，必然失败），再实现。

**Files:**
- Modify: `src/server.js`（options、扫描器、WS 入队处、新增 `evictSession`）
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: Task 1 的 sessions 结构与错误文案。
- Produces:
  - 新 options：`sessionEvictMs`（默认 `SESSION_EVICT_MS = 90000`）、`sessionQueueMax`（默认 `SESSION_QUEUE_MAX = 50`）
  - 新函数：`evictSession(session, reason)`——清挂起 poll（推 `sessionExpired`）、拒 queue 与 inflight 中该会话全部命令、从 `sessions` 删除
  - FAST 常量新增 `sessionEvictMs: 2000`（除驱逐测试外均视为"不驱逐"）

- [ ] **Step 1: FAST 加 `sessionEvictMs`**

```js
const FAST = { pollHoldMs: 400, commandTimeoutMs: 600, queueTtlMs: 400, heartbeatMs: 200, sessionEvictMs: 2000 };
```

- [ ] **Step 2: 写 4 个失败测试**

```js
test('会话驱逐：挂起的 poll 收到 sessionExpired 推送', async () => {
  const { bridge, base } = await startBridge({ sessionEvictMs: 500, queueTtlMs: 10000 });
  try {
    const sid = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    const p = hangPoll(base, sid);
    const res = await p.done; // poll 到达刷新 seenAt；500ms 后驱逐推送
    assert.equal(res.status, 200);
    assert.equal(res.body.sessionExpired, true);
    assert.equal(res.body.command, null);
  } finally {
    await bridge.close();
  }
});

test('会话驱逐：在途命令的 CLI 收到会话失效', async () => {
  const { bridge, port, base } = await startBridge({ sessionEvictMs: 500, queueTtlMs: 10000 });
  try {
    const sid = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    const p = hangPoll(base, sid);
    const replyP = sendOne(port, { action: 'ping' });
    await p.done; // 命令已投递，插件不再 poll 也不回结果
    const reply = await replyP;
    assert.equal(reply.ok, false);
    assert.match(reply.error, /会话已失效/);
  } finally {
    await bridge.close();
  }
});

test('会话驱逐：排队命令被拒，驱逐后 poll 得 sessionExpired', async () => {
  const { bridge, port, base } = await startBridge({ sessionEvictMs: 500, queueTtlMs: 10000 });
  try {
    const sid = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    // 不 poll：命令排队，seenAt 停在 hello 时刻
    const reply = await sendOne(port, { action: 'ping' });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /会话已失效/);
    const r = await fetch(`${base}/poll?sessionId=${encodeURIComponent(sid)}`);
    const body = await r.json();
    assert.equal(body.sessionExpired, true);
  } finally {
    await bridge.close();
  }
});

test('每会话队列上限：超出即拒', async () => {
  const { bridge, port, base } = await startBridge({ sessionQueueMax: 2 });
  try {
    await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    const r1 = sendOne(port, { action: 'ping' });
    const r2 = sendOne(port, { action: 'ping' });
    const r3 = await sendOne(port, { action: 'ping' }); // 第 3 条超限立即被拒
    assert.equal(r3.ok, false);
    assert.match(r3.error, /队列已满（2）/);
    await r1; await r2; // 前两条等 TTL 驱逐，避免悬置连接
  } finally {
    await bridge.close();
  }
});
```

- [ ] **Step 3: 运行确认 4 例失败**

Run: `node --test test/`
Expected: 驱逐 3 例 FAIL（无驱逐逻辑：挂起 poll 只会在 pollHoldMs 后空转、CLI 走 commandTimeoutMs 超时而非"会话已失效"）；上限 1 例 FAIL（第 3 条没有被立即拒）。

- [ ] **Step 4: 实现 options、evictSession、扫描器扩展、入队上限**

options 声明（工厂顶部，紧邻现有注入项）：

```js
const sessionEvictMs = options.sessionEvictMs ?? SESSION_EVICT_MS;
const sessionQueueMax = options.sessionQueueMax ?? SESSION_QUEUE_MAX;
```

`evictSession`（工厂内函数）：

```js
function evictSession(session, reason) {
  if (session.waitingPoll) {
    clearTimeout(session.waitingPoll.timer);
    sendJson(session.waitingPoll.res, 200, { command: null, sessionExpired: true, relayBootId: bootId });
    session.waitingPoll = null;
  }
  for (const item of session.queue.splice(0)) {
    safeSend(item.cliSocket, { id: item.id, ok: false, error: reason });
  }
  for (const [id, item] of inflight) {
    if (item.sessionId === session.sessionId) {
      inflight.delete(id);
      clearTimeout(item.timer);
      safeSend(item.cliSocket, { id, ok: false, error: reason });
    }
  }
  sessions.delete(session.sessionId);
}
```

扫描器替换（Task 1 的 queueSweeper 版本基础上加驱逐分支与新 interval 公式）：

```js
const queueSweeper = queueTtlMs > 0
  ? setInterval(() => {
      const now = Date.now();
      const deadline = now - queueTtlMs;
      for (const session of sessions.values()) {
        while (session.queue.length && session.queue[0].enqueuedAt <= deadline) {
          const item = session.queue.shift();
          safeSend(item.cliSocket, { id: item.id, ok: false, error: `命令超时（${queueTtlMs / 1000}s 未被插件取走）` });
        }
        if (sessionEvictMs > 0 && now - session.seenAt > sessionEvictMs) {
          evictSession(session, '插件会话已失效（插件失联）');
        }
      }
    }, Math.min(QUEUE_SWEEP_MS, queueTtlMs / 2, sessionEvictMs > 0 ? sessionEvictMs / 2 : QUEUE_SWEEP_MS))
  : null;
```

WS 入队处（`const session = picked.session;` 之后）加上限检查：

```js
if (session.queue.length >= sessionQueueMax) {
  safeSend(socket, { id, ok: false, error: `该文件命令队列已满（${sessionQueueMax}）` });
  return;
}
```

- [ ] **Step 5: 运行确认全部转绿**

Run: `node --test test/`
Expected: 23 例全部 PASS，进程正常退出。

- [ ] **Step 6: 提交**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: 会话 TTL 驱逐与每会话队列上限（内存防护）"
```

---

### Task 5: CLI——list-files 与多文件 doctor

CLI 无自动化测试现状（测试只覆盖中继），本任务以手动冒烟步骤验收。

**Files:**
- Modify: `bin/cli.js`（`cmdDoctor` 重写、新增 `cmdListFiles`、`main` 加 case、用法文案）
- Modify: `README.md`（命令清单加 list-files）

**Interfaces:**
- Consumes: `__status` 的 `sessions` 数组（Task 1 形状）。
- Produces: `cmdListFiles()`；`figma-bridge list-files` 子命令。

- [ ] **Step 1: 重写 cmdDoctor + 新增 cmdListFiles**

```js
async function cmdListFiles() {
  const reply = await sendOne({ action: '__status' }, { allowOffline: true });
  const sessions = (reply.result && reply.result.sessions) || [];
  if (!sessions.length) {
    console.log('当前没有已注册的文件。请在 Figma 中运行「Figma Local Bridge」插件。');
    return;
  }
  console.log(`已注册文件（${sessions.length}）：`);
  for (const s of sessions) {
    const seen = s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleTimeString() : '未知';
    console.log(`  ${s.alive ? '●' : '○'} ${s.fileName}  fileKey=${s.fileKey}  插件 v${s.pluginVersion}  最后心跳 ${seen}  排队 ${s.queuedCommands}`);
  }
}

async function cmdDoctor() {
  console.log(`Figma Local Bridge v${PKG_VERSION} 自检`);
  try {
    const reply = await sendOne({ action: '__status' }, { allowOffline: true });
    const s = reply.result;
    console.log(`✅ 中继在线（v${s.serverVersion}，端口 ${s.port}）`);
    const alive = (s.sessions || []).filter((x) => x.alive);
    if (!alive.length) {
      console.log('❌ 插件不在线：请在 Figma 中运行「Figma Local Bridge」插件');
      return;
    }
    for (const x of alive) {
      console.log(`✅ 插件在线（文件：${x.fileName}，fileKey: ${x.fileKey}，插件 v${x.pluginVersion}）`);
      if (x.pluginVersion !== '未知' && x.pluginVersion !== s.serverVersion) {
        console.log(`⚠️ 版本不一致：插件 v${x.pluginVersion} ≠ 中继 v${s.serverVersion}，请重新 install-plugin 并重启插件`);
      }
      if (x.queuedCommands > 0) console.log(`⚠️ ${x.fileName} 队列中有 ${x.queuedCommands} 条待执行命令`);
    }
  } catch (e) {
    console.log(`❌ 中继离线：${e.message}`);
    process.exit(1);
  }
}
```

`main()` 的 switch 加 case，default 用法串更新：

```js
    case 'list-files':
      await cmdListFiles();
      break;
```

```js
      console.log('用法：figma-bridge <server|send|render|export|list-files|install-plugin|doctor>');
```

- [ ] **Step 2: README 命令清单补 list-files**

`README.md` 命令清单段（`figma-bridge doctor` 行附近）插入：

```
npx figma-bridge list-files                # 列出在线文件（fileKey/文件名/版本/排队数）
```

- [ ] **Step 3: 手动冒烟**

```bash
node src/server.js &  # 或 figma-bridge server，另开终端
curl 'http://localhost:9741/hello?fileKey=fkA&fileName=%E6%96%87%E4%BB%B6A&version=0.2.0&instanceId=t1'
curl 'http://localhost:9741/hello?fileKey=fkB&fileName=%E6%96%87%E4%BB%B6B&version=0.2.0&instanceId=t2'
node bin/cli.js list-files   # 期望：两行，均 ●
node bin/cli.js doctor       # 期望：两个文件均 ✅ 在线，版本一致（0.2.0 需 Task 7 后；此处先验证多文件列举）
kill %1
```

Expected: list-files 显示两个文件；doctor 逐文件输出。

- [ ] **Step 4: 回归测试 + 提交**

Run: `node --test test/`（应仍 23 例全绿——CLI 改动不影响中继）

```bash
git add bin/cli.js README.md
git commit -m "feat: CLI 新增 list-files；doctor 逐文件检查版本一致性"
```

---

### Task 6: CLI——send/render/export 支持 --file 选择器

**Files:**
- Modify: `bin/cli.js`（新增 `takeFileArg`/`resolveFileKey`，`cmdSend`/`cmdExport`/`main` 接线）
- Modify: `README.md`（--file 用法示例）

**Interfaces:**
- Consumes: `__status` sessions；Task 5 的 `cmdListFiles` 提示文案。
- Produces: `takeFileArg(args) → { args, selector }`、`resolveFileKey(selector) → fileKey`；三个子命令支持 `--file <选择器>`。

- [ ] **Step 1: 实现 takeFileArg / resolveFileKey / cmdSend 接线**

```js
function takeFileArg(args) {
  const i = args.indexOf('--file');
  if (i < 0) return { args, selector: null };
  const selector = args[i + 1];
  if (!selector) throw new Error('--file 缺少选择器参数');
  const rest = args.slice();
  rest.splice(i, 2);
  return { args: rest, selector };
}

async function resolveFileKey(selector) {
  const reply = await sendOne({ action: '__status' }, { allowOffline: true });
  const sessions = ((reply.result && reply.result.sessions) || []).filter((s) => s.alive);
  const exact = sessions.filter((s) => s.fileKey === selector);
  if (exact.length === 1) return exact[0].fileKey;
  const lower = String(selector).toLowerCase();
  const fuzzy = sessions.filter((s) => (s.fileName || '').toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0].fileKey;
  if (!fuzzy.length) throw new Error(`没有匹配的在线文件：${selector}（用 figma-bridge list-files 查看）`);
  throw new Error(`「${selector}」匹配到多个文件：${fuzzy.map((s) => `${s.fileName}（${s.fileKey}）`).join('、')}，请改用 fileKey`);
}
```

`cmdSend` 加 selector 形参（导入 SVG 分支之后注入 target）：

```js
async function cmdSend(arg, selector) {
  let command = readCommand(arg);
  if (command.action === 'importSvg') command = await rasterizeSvgCommand(command);
  if (selector) {
    command.target = { fileKey: await resolveFileKey(selector) };
  }
  const reply = await sendOne(command);
  // …余下不变
}
```

`cmdExport` 透传：

```js
async function cmdExport(nodeId, scale, selector) {
  if (!nodeId) throw new Error('用法：figma-bridge export [--file <选择器>] <nodeId> [scale]');
  await cmdSend(JSON.stringify({ action: 'exportNode', params: { nodeId, scale: Number(scale) || 2 } }), selector);
}
```

`main()` 三个 case 接线：

```js
    case 'send': {
      const { args: rest, selector } = takeFileArg(args);
      await cmdSend(rest[0], selector);
      break;
    }
    case 'render': {
      const { args: rest, selector } = takeFileArg(args);
      if (!rest[0]) throw new Error('用法：figma-bridge render [--file <选择器>] <file.json>');
      await cmdSend('@' + rest[0], selector);
      break;
    }
    case 'export': {
      const { args: rest, selector } = takeFileArg(args);
      await cmdExport(rest[0], rest[1], selector);
      break;
    }
```

- [ ] **Step 2: README 加 --file 示例**

命令清单后补一行：

```
npx figma-bridge send --file 首页 '{"action":"ping"}'   # 向指定文件发命令（选择器为 fileKey 或文件名唯一子串）
```

- [ ] **Step 3: 手动冒烟**

```bash
node src/server.js &
curl 'http://localhost:9741/hello?fileKey=fkA&fileName=%E9%A6%96%E9%A1%B5%E8%AE%BE%E8%AE%A1&version=0.2.0&instanceId=t1'
node bin/cli.js send --file 首页 '{"action":"ping"}'      # 期望：报"命令超时（60s 未被插件取走）"——说明已路由进 fkA 队列
node bin/cli.js send --file 不存在 '{"action":"ping"}'    # 期望：没有匹配的在线文件
node bin/cli.js send '{"action":"ping"}'                  # 单在线：自动路由，同第一条
kill %1
```

Expected: 选择器解析、注入 target、报错路径均符合注释。

- [ ] **Step 4: 回归 + 提交**

Run: `node --test test/`

```bash
git add bin/cli.js README.md
git commit -m "feat: CLI send/render/export 支持 --file 选择器（fileKey 或文件名唯一子串）"
```

---

### Task 7: 插件侧 0.2.0 + 版本 bump + CHANGELOG + 实机验收

**Files:**
- Modify: `plugin/code.js`（PLUGIN_VERSION、instanceId/sessionId、hello()、pollLoop、runCommand）
- Modify: `package.json`（version → 0.2.0）
- Modify: `CHANGELOG.md`
- Modify: `README.md`（多文件说明一句）

**Interfaces:**
- Consumes: 中继协议（Task 1）；`figma.fileKey`（取不到退化为 `name:<figma.root.name>`）。
- Produces: 插件 0.2.0；升级动作：`figma-bridge install-plugin` + Figma 内重启插件。

- [ ] **Step 1: 改写 plugin/code.js 头部与握手循环**

头部常量区：

```js
var SERVER = 'http://localhost:9741';
var PLUGIN_VERSION = '0.2.0';
var instanceId = Math.random().toString(36).slice(2, 8);
var sessionId = null;
var fileKey = (typeof figma.fileKey === 'string' && figma.fileKey) || ('name:' + figma.root.name);
var notifiedFailure = false;
var notifiedSuccess = false;
var lastBootId = null;
```

`hello` 函数：

```js
async function hello() {
  var res = await fetch(
    SERVER + '/hello?fileKey=' + encodeURIComponent(fileKey) +
      '&fileName=' + encodeURIComponent(figma.root.name) +
      '&version=' + PLUGIN_VERSION +
      '&instanceId=' + instanceId,
  );
  var data = await res.json();
  if (data && data.sessionId) sessionId = data.sessionId;
}
```

`pollLoop` 替换：

```js
async function pollLoop() {
  for (;;) {
    try {
      if (!sessionId) await hello();
      var res = await fetch(SERVER + '/poll?sessionId=' + encodeURIComponent(sessionId));
      var data = await res.json();
      if (!notifiedSuccess) {
        notifiedSuccess = true;
        notifiedFailure = false;
        figma.notify('Figma Local Bridge 已连接本地中继，可以接收命令了');
      }
      if (data && data.sessionExpired) {
        sessionId = null; // 下一轮重新 hello
      } else if (data && data.relayBootId !== lastBootId) {
        sessionId = null; // 中继换实例：重新握手
        lastBootId = data.relayBootId;
      } else if (data && data.command) {
        await runCommand(data.command);
      }
    } catch (e) {
      if (!notifiedFailure) {
        notifiedFailure = true;
        figma.notify('未连上本地中继（请先运行 figma-bridge server），持续重试中…', {
          error: true,
          timeout: 3000,
        });
      }
      notifiedSuccess = false;
      await sleep(2000);
    }
  }
}
```

`runCommand` 的 `/result` body 加 sessionId：

```js
body: JSON.stringify({ id: cmd.id, sessionId: sessionId, ok: ok, result: result, error: error }),
```

- [ ] **Step 2: 版本与变更日志**

`package.json`：`"version": "0.2.0"`。

`CHANGELOG.md` 顶部插入：

```markdown
## 0.2.0（2026-10-22）

多文件路由（破坏性协议变更，插件与中继需一起升级）：

- 中继：插件会话化（hello 携带 fileKey/instanceId，下发 sessionId），命令按 `target.fileKey` 路由；无 target 时恰好一个文件在线自动路由、多个在线报错并附清单
- 中继：session TTL 驱逐（默认 90s）与每会话队列上限（默认 50），失联会话的排队/在途命令即时释放
- 中继：/result 按 sessionId 校验归属，防跨会话串话；无 sessionId 的 poll 返回 400
- CLI：新增 list-files；send/render/export 支持 --file <fileKey 或文件名唯一子串>；doctor 逐文件检查版本一致性
- 插件：hello/poll/result 携带会话标识，sessionExpired 或 relayBootId 变化自动重握手
- 升级动作：`figma-bridge install-plugin` 后重启插件；doctor 可验证
```

`README.md` 简介处补一句：

```
中继支持多文件：在多个 Figma 文件中各自运行插件，`list-files` 查看在线文件，命令用 `--file` 指定目标（单文件用法不变）。
```

- [ ] **Step 3: 全量回归**

Run: `node --test test/`
Expected: 23 例全部 PASS。

- [ ] **Step 4: 实机验收（Figma 桌面端）**

```bash
npm pkg get version          # 期望 0.2.0
node bin/cli.js install-plugin
node bin/cli.js server       # 保持运行
```

1. Figma 文件 A：Plugins → Development → 重新导入/重启「Figma Local Bridge」→ `node bin/cli.js doctor` 显示文件 A 在线
2. Figma 文件 B（另一 tab）同样运行插件 → `node bin/cli.js list-files` 显示两个文件
3. `node bin/cli.js send --file <A文件名> '{"action":"ping"}'` → 返回 A 的 pageName
4. `node bin/cli.js send --file <B的fileKey> '{"action":"getStructure","params":{"depth":1}}'` → 返回 B 的结构
5. 无 target `send '{"action":"ping"}'` → 报错并列出两个文件
6. 关掉 A 的插件约 2 分钟 → `list-files` 中 A 消失（90s 驱逐）→ 重开 A 插件自动重握手恢复

- [ ] **Step 5: 提交**

```bash
git add plugin/code.js package.json CHANGELOG.md README.md
git commit -m "feat: 插件侧 0.2.0 会话握手；版本 bump 与 CHANGELOG"
```

---

## Self-Review 结论

- **Spec 覆盖**：协议三门（hello/poll 400/sessionExpired）→T1；路由规则表→T1 实现+T2 加固；result 归属→T1+T3；四条内存防护→T1（结构/close）+T4（驱逐/上限）；`__status` sessions→T1；list-files→T5；--file→T6；doctor→T5；版本/CHANGELOG→T7；插件侧→T7。spec 测试清单 9 项全部落位。
- **占位符**：无；所有代码步骤含完整代码。
- **类型一致**：`sessionId`/`fileKey`/`instanceId`/`registeredAt`/`seenAt`/`waitingPoll`/`queue`、`aliveSessions`/`describeSessions`/`pickTargetSession`/`evictSession`/`deliverToPlugin`、`takeFileArg`/`resolveFileKey`/`cmdListFiles` 跨任务一致；错误文案逐字锁定于 Global Constraints。
