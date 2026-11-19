# MCP Server（v0.3.0）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `figma-bridge mcp` —— MCP stdio server，把中继协议的 16 个能力暴露为自描述工具（图片内联返回、本地图片路径输入、中继自动拉起），中继与插件零逻辑改动。

**Architecture:** 客户端拉起的 stdio JSON-RPC 2.0 进程（手写协议，零新依赖），内部持一条长驻 WS 连接（命令串行化 + 指数退避重连）连本地中继；启动时探测端口，中继不在线则 spawn 子进程并在退出时回收。工具层做三件事：action↔tool 翻译、`file` 选择器解析、图片 base64↔本地路径转换。

**Tech Stack:** Node.js ≥18（无新增运行时依赖）、`ws`（已有）、`node:test`。

**Spec:** [docs/superpowers/specs/2026-11-19-mcp-server-design.md](../specs/2026-11-19-mcp-server-design.md)

## Global Constraints

- 零新增运行时依赖（deps 保持 `ws`，optionalDependencies 保持 `sharp`）；测试用 `node --test test/` 运行。
- **stdout 只允许写协议 JSON 行**；一切日志走 `console.error`（stderr）。
- 默认端口 9741、环境变量 `FLB_PORT` 语义不变（CLI 与 MCP 同一套）。
- MCP 命令级超时 75s（中继命令超时 60s / CLI 侧 70s，取其上做兜底）。
- 错误文案逐字锁定（测试按正则断言，跨任务不得改写）：
  - `没有匹配的在线文件：${selector}（用 figma-bridge list-files 查看）`
  - `「${selector}」匹配到多个文件：…，请改用 fileKey`
  - `无法读取图片文件：${path}（…）`
  - `importSvg 需要可选依赖 sharp（npm i sharp）`
  - `命令超时（${commandTimeoutMs / 1000}s）`
  - `中继离线：…`
- 分支：`feat/mcp-server`（spec 已提交于 f726b11）。
- 提交信息用中文 conventional commits（feat:/test:/docs:/chore:），每个 Task 末尾提交一次。

## 实现注记（对 spec 的三处细化，行为不变）

1. **命令串行化的根因**：中继协议的命令 id 由中继分配、客户端消息不携带 id（`server.js` 里 `const id = nextId++`），单连接并发命令无法做客户端侧配对——连接层用 promise 链把命令串行化。中继自身 60s 命令超时先于本层 75s 触发，因此不会出现"上一条迟到回复被下一条误配"的窗口。
2. **`PLUGIN_VERSION` 随包同升 0.3.0**：中继 `/hello` 做"插件版本 vs 包版本"一致性校验，只升 package.json 会让 doctor 永远告警。插件代码逻辑零改动，仅 `code.js:6` 的版本常量同步（与 0.2.0 发布同例）。
3. **`file` 参数在 MCP 层解析**：工具收到 `args.file` 后先发 `__status` 解析出唯一 fileKey 再注入 `command.target`——语义与 CLI `--file` 完全一致，共享同一 `resolveFileKey`。

---

### Task 1: 共享层抽取——`src/relay-client.js`（选择器 + SVG 栅格化）

CLI 与 MCP 要共用同一套 `file` 选择器语义和 SVG 栅格化；先把它们从 `bin/cli.js` 抽成可注入依赖的纯模块，CLI 行为不变。

**Files:**
- Create: `src/relay-client.js`
- Modify: `bin/cli.js`（删除本地 `resolveFileKey`/`rasterizeSvgCommand`，改用共享模块）
- Test: `test/relay-client.test.js`（新建）

**Interfaces:**
- Consumes: 无（自包含模块）。
- Produces（后续任务依赖的确切签名）:
  - `resolveFileKey(fetchStatus, selector) → Promise<string>`；`fetchStatus: async () => __status 的 result`（含 `sessions: [{ fileKey, fileName, alive, lastSeenAt }]`）；精确 fileKey → 唯一子串（大小写不敏感）→ 歧义/无匹配抛 `Error`
  - `rasterizeSvgToPlaceImage({ svg, width?, height?, name?, parentNodeId?, x?, y? }) → Promise<{ action: 'placeImage', params: { imageBase64, width, height, name, parentNodeId, x, y, scaleMode: 'FIT' } }>`

- [ ] **Step 1: 写失败测试**

创建 `test/relay-client.test.js`：

```js
// 共享中继客户端工具测试：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { resolveFileKey, rasterizeSvgToPlaceImage } = require('../src/relay-client');

const statusOf = (sessions) => async () => ({ sessions });

test('resolveFileKey：fileKey 精确匹配优先，多会话取最近活跃', async () => {
  const fetch = statusOf([
    { fileKey: 'fkA', fileName: '文件A', alive: true, lastSeenAt: '2026-11-19T10:00:00Z' },
    { fileKey: 'fkB', fileName: 'fkA同名的文件', alive: true, lastSeenAt: '2026-11-19T09:00:00Z' },
  ]);
  assert.equal(await resolveFileKey(fetch, 'fkA'), 'fkA');
});

test('resolveFileKey：文件名唯一子串（大小写不敏感）', async () => {
  const fetch = statusOf([{ fileKey: 'fkA', fileName: 'Home Page', alive: true }]);
  assert.equal(await resolveFileKey(fetch, 'home page'), 'fkA');
});

test('resolveFileKey：子串歧义报错并附候选', async () => {
  const fetch = statusOf([
    { fileKey: 'fkA', fileName: '首页草稿', alive: true },
    { fileKey: 'fkB', fileName: '首页终稿', alive: true },
  ]);
  await assert.rejects(resolveFileKey(fetch, '首页'), /首页.*fkA.*fkB.*fileKey/s);
});

test('resolveFileKey：无匹配报错', async () => {
  const fetch = statusOf([{ fileKey: 'fkA', fileName: '文件A', alive: true }]);
  await assert.rejects(resolveFileKey(fetch, '不存在'), /没有匹配的在线文件/);
});

test('resolveFileKey：失联会话不参与匹配', async () => {
  const fetch = statusOf([
    { fileKey: 'fkDead', fileName: '文件X', alive: false },
    { fileKey: 'fkLive', fileName: '文件Y', alive: true },
  ]);
  await assert.rejects(resolveFileKey(fetch, '文件X'), /没有匹配的在线文件/);
  assert.equal(await resolveFileKey(fetch, '文件Y'), 'fkLive');
});

test('rasterizeSvgToPlaceImage：产出 placeImage 命令（PNG magic + 尺寸透传）', { skip: !hasSharp() }, async () => {
  const cmd = await rasterizeSvgToPlaceImage({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>',
    width: 24, height: 24, name: 'icon', x: 1, y: 2,
  });
  assert.equal(cmd.action, 'placeImage');
  assert.equal(cmd.params.width, 24);
  assert.equal(cmd.params.height, 24);
  assert.equal(cmd.params.name, 'icon');
  assert.equal(cmd.params.scaleMode, 'FIT');
  const png = Buffer.from(cmd.params.imageBase64, 'base64');
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], '应为 PNG 数据');
});

test('rasterizeSvgToPlaceImage：缺 svg 参数报错', async () => {
  await assert.rejects(rasterizeSvgToPlaceImage({}), /缺少 svg 参数/);
});

function hasSharp() {
  try { require.resolve('sharp'); return true; } catch { return false; }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/relay-client.test.js`
Expected: FAIL（`Cannot find module '../src/relay-client'`）

- [ ] **Step 3: 实现 `src/relay-client.js`**

```js
// CLI 与 MCP server 共享的中继客户端工具：file 选择器解析、SVG 栅格化。
// v0.3.0 从 bin/cli.js 抽出，行为不变——两条入口共用同一套语义。
// fetchStatus 由调用方注入：CLI 走一次性 sendOne，MCP 走长驻连接。

// 从 __status 结果解析选择器为唯一 fileKey：先精确匹配 fileKey（多个活会话取最近活跃），
// 再大小写不敏感匹配文件名唯一子串；歧义与无匹配都抛错并列出候选。
async function resolveFileKey(fetchStatus, selector) {
  const status = await fetchStatus();
  const sessions = ((status && status.sessions) || []).filter((s) => s.alive);
  const exact = sessions.filter((s) => s.fileKey === selector);
  if (exact.length >= 1) {
    exact.sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
    return exact[0].fileKey;
  }
  const lower = String(selector).toLowerCase();
  const fuzzy = sessions.filter((s) => (s.fileName || '').toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0].fileKey;
  if (!fuzzy.length) throw new Error(`没有匹配的在线文件：${selector}（用 figma-bridge list-files 查看）`);
  throw new Error(`「${selector}」匹配到多个文件：${fuzzy.map((s) => `${s.fileName}（${s.fileKey}）`).join('、')}，请改用 fileKey`);
}

// SVG → placeImage 命令：sharp 栅格化为 4x 透明 PNG（插件沙箱无 SVG 导入 API）。
// sharp 是可选依赖，缺失时报可安装提示。
async function rasterizeSvgToPlaceImage({ svg, width, height, name, parentNodeId, x, y } = {}) {
  if (!svg) throw new Error('importSvg 缺少 svg 参数');
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    throw new Error('importSvg 需要可选依赖 sharp（npm i sharp）');
  }
  const w = width || 24;
  const h = height || 24;
  const SCALE = 4;
  const scaled = svg
    .replace(/width="[^"]*"/, `width="${w * SCALE}"`)
    .replace(/height="[^"]*"/, `height="${h * SCALE}"`);
  const png = await sharp(Buffer.from(scaled), { density: 300 }).png().toBuffer();
  return {
    action: 'placeImage',
    params: {
      imageBase64: png.toString('base64'),
      width: w, height: h, name, parentNodeId, x, y, scaleMode: 'FIT',
    },
  };
}

module.exports = { resolveFileKey, rasterizeSvgToPlaceImage };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/relay-client.test.js`
Expected: PASS（sharp 未安装时栅格化用例 skip）

- [ ] **Step 5: CLI 改用共享模块（行为不变）**

`bin/cli.js` 三处修改：

① 头部引入，删除本地 `resolveFileKey`（约 85-99 行）与 `rasterizeSvgCommand`（约 47-70 行）两个函数，替换为：

```js
const { resolveFileKey, rasterizeSvgToPlaceImage } = require('../src/relay-client');

// CLI 版 fetchStatus：一次性 sendOne 拉 __status
async function fetchStatusCli() {
  const reply = await sendOne({ action: '__status' }, { allowOffline: true });
  return reply.result;
}
```

② `cmdSend` 中两处调用点改写（语义逐字不变）：

```js
  // 原：if (command.action === 'importSvg') command = await rasterizeSvgCommand(command);
  if (command.action === 'importSvg') command = await rasterizeSvgToPlaceImage(command.params);
  // 原：command.target = { fileKey: await resolveFileKey(selector) };
  if (selector) {
    command.target = { fileKey: await resolveFileKey(fetchStatusCli, selector) };
  }
```

- [ ] **Step 6: 全量测试回归**

Run: `npm test`
Expected: 全部 PASS（CLI 无既有测试，回归靠中继/插件套件确认无意外破坏）

- [ ] **Step 7: 提交**

```bash
git add src/relay-client.js bin/cli.js test/relay-client.test.js
git commit -m "feat: 抽取共享中继客户端工具（file 选择器/SVG 栅格化），CLI 与 MCP 共用"
```

---

### Task 2: 连接层——`src/mcp/connection.js`（探测 + 长驻 WS 串行命令）

**Files:**
- Create: `src/mcp/connection.js`
- Test: `test/mcp-connection.test.js`（新建）

**Interfaces:**
- Consumes: 中继 WS 协议 `{ role: 'cli', command }` → 回复 `{ id, ok, result, error }`（Task 1 无依赖）。
- Produces:
  - `probeRelay(port, timeoutMs = 500) → Promise<boolean>`（WS 握手探测，不在线不抛错）
  - `new BridgeConnection({ port, commandTimeoutMs?, dialTimeoutMs?, backoffMaxMs?, logger? })`
  - `conn.request(command) → Promise<result>`：`ok:true` 时 resolve `result`；`ok:false`/超时/离线时 reject `Error`（文案即错误信息）。**命令串行化**（见实现注记 1），断线按 1s→2s→…→backoffMaxMs 退避重连，重试受单命令 deadline 约束
  - `conn.close()`：拒绝挂起命令并断开

- [ ] **Step 1: 写失败测试**

创建 `test/mcp-connection.test.js`：

```js
// MCP 连接层测试：对接真实 createBridgeServer 工厂（FAST 定时器注入，模式同 server.test.js）
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { WebSocket } = require('ws');

setTimeout(() => { console.error('看门狗：测试 30s 未结束'); process.exit(1); }, 30_000).unref();

const { createBridgeServer } = require('../src/server');
const { probeRelay, BridgeConnection } = require('../src/mcp/connection');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { pollHoldMs: 400, commandTimeoutMs: 2000, queueTtlMs: 5000, heartbeatMs: 200, sessionEvictMs: 10000 };

async function startBridge(opts = {}) {
  const bridge = createBridgeServer({ ...FAST, logger: () => {}, ...opts });
  await bridge.listen('127.0.0.1');
  return { bridge, port: bridge.port, base: `http://127.0.0.1:${bridge.port}` };
}

async function hello(base, { fileKey = 'fk', fileName = '文件', instanceId = 'i1' } = {}) {
  const r = await fetch(`${base}/hello?fileKey=${fileKey}&fileName=${encodeURIComponent(fileName)}&version=x&instanceId=${instanceId}`);
  return (await r.json()).sessionId;
}

// 自动应答型插件：可选自定义应答器
function autoPoller(base, sessionId, respond) {
  const commands = [];
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await fetch(`${base}/poll?sessionId=${sessionId}`);
        const body = await r.json();
        if (body && body.command) {
          commands.push(body.command);
          const out = respond ? respond(body.command) : { ok: true, result: { ack: body.command.action } };
          await fetch(`${base}/result`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: body.command.id, sessionId, ...out }),
          });
        }
      } catch { await sleep(30); }
    }
  })();
  return { commands, stop: () => { stopped = true; } };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

test('probeRelay：在线 true / 离线 false', async () => {
  const { bridge, port } = await startBridge();
  try {
    assert.equal(await probeRelay(port, 500), true);
  } finally { await bridge.close(); }
  assert.equal(await probeRelay(port, 300), false);
});

test('request：发命令收 result（ok:true → resolve result）', async () => {
  const { bridge, port, base } = await startBridge();
  const sid = await hello(base);
  const p = autoPoller(base, sid);
  const conn = new BridgeConnection({ port, logger: () => {} });
  try {
    const result = await conn.request({ action: 'ping' });
    assert.deepEqual(result, { ack: 'ping' });
    assert.equal(p.commands[0].action, 'ping');
  } finally { p.stop(); conn.close(); await bridge.close(); }
});

test('request：插件报错（ok:false）原样透传', async () => {
  const { bridge, port, base } = await startBridge();
  const sid = await hello(base);
  const p = autoPoller(base, sid, () => ({ ok: false, error: '炸了' }));
  const conn = new BridgeConnection({ port, logger: () => {} });
  try {
    await assert.rejects(conn.request({ action: 'ping' }), /炸了/);
  } finally { p.stop(); conn.close(); await bridge.close(); }
});

test('request：并发命令被串行化，各拿各的结果', async () => {
  const { bridge, port, base } = await startBridge();
  const sid = await hello(base);
  const p = autoPoller(base, sid);
  const conn = new BridgeConnection({ port, logger: () => {} });
  try {
    const [a, b] = await Promise.all([
      conn.request({ action: 'ping', tag: 'A' }),
      conn.request({ action: 'ping', tag: 'B' }),
    ]);
    assert.deepEqual(a, { ack: 'ping' });
    assert.deepEqual(b, { ack: 'ping' });
    await sleep(150);
    assert.equal(p.commands.length, 2, '两条命令都送达');
    assert.deepEqual(p.commands.map((c) => c.tag).sort(), ['A', 'B']);
  } finally { p.stop(); conn.close(); await bridge.close(); }
});

test('request：中继离线时在命令 deadline 内报"中继离线"', async () => {
  const port = await getFreePort(); // 没有中继
  const conn = new BridgeConnection({ port, commandTimeoutMs: 700, dialTimeoutMs: 120, backoffMaxMs: 150, logger: () => {} });
  const t0 = Date.now();
  try {
    await assert.rejects(conn.request({ action: 'ping' }), /中继离线/);
    assert.ok(Date.now() - t0 < 3000, `应在 deadline 附近失败而非无限重试`);
  } finally { conn.close(); }
});

test('request：插件不回结果时本层超时', async () => {
  const { bridge, port, base } = await startBridge({ commandTimeoutMs: 10000 }); // 中继侧超时放宽，让本层先触发
  const sid = await hello(base);
  const conn = new BridgeConnection({ port, commandTimeoutMs: 400, logger: () => {} });
  try {
    const r = fetch(`${base}/poll?sessionId=${sid}`); // 插件取走命令但永不回结果
    await r; await assert.rejects(conn.request({ action: 'ping' }), /命令超时/);
  } finally { conn.close(); await bridge.close(); }
});

test('断线重连：中继换实例（同端口新 bridge）后下一条命令自动恢复', async () => {
  const { bridge, port, base } = await startBridge();
  const sid = await hello(base);
  const p1 = autoPoller(base, sid);
  const conn = new BridgeConnection({ port, logger: () => {} });
  const first = await conn.request({ action: 'ping' });
  assert.deepEqual(first, { ack: 'ping' });
  p1.stop();
  await bridge.close(); // 旧中继死亡（连接断开）
  await sleep(150);
  const second = createBridgeServer({ ...FAST, logger: () => {}, port }); // 同端口换新实例
  await second.listen('127.0.0.1');
  const sid2 = await hello(`http://127.0.0.1:${port}`);
  const p2 = autoPoller(`http://127.0.0.1:${port}`, sid2);
  try {
    const result = await conn.request({ action: 'ping' });
    assert.deepEqual(result, { ack: 'ping' });
  } finally { p2.stop(); conn.close(); await second.close(); }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/mcp-connection.test.js`
Expected: FAIL（`Cannot find module '../src/mcp/connection'`）

- [ ] **Step 3: 实现 `src/mcp/connection.js`**

```js
// MCP server 的中继连接层：一条长驻 WebSocket。
// 串行化的根因：中继协议的命令 id 由中继分配、客户端消息不携带 id（server.js nextId++），
// 单连接并发命令无法做客户端侧配对——用 promise 链把命令排队，一次一条。
// 断线按指数退避重连（1s→30s 封顶）；重试受单命令 deadline 约束，超时即报"中继离线"。
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 探测中继是否在线：发起 WS 握手，timeoutMs 内 open 即在线。任何失败都不抛错。
function probeRelay(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    ws.on('open', () => settle(true));
    ws.on('error', () => settle(false));
  });
}

class BridgeConnection {
  constructor({ port, commandTimeoutMs = 75000, dialTimeoutMs = 3000, backoffMaxMs = 30000, logger = () => {} } = {}) {
    this.port = port;
    this.commandTimeoutMs = commandTimeoutMs;
    this.dialTimeoutMs = dialTimeoutMs;
    this.backoffMaxMs = backoffMaxMs;
    this.log = logger;
    this.ws = null;
    this._pending = null;      // 串行化 ⇒ 同一时刻至多一个挂起命令
    this._chain = Promise.resolve();
    this._backoffMs = 1000;
  }

  // 拨号一次（带超时）。已有健康连接时直接复用。
  dial() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`连接超时（ws://127.0.0.1:${this.port}）`));
      }, this.dialTimeoutMs);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.on('message', (raw) => this._onMessage(raw));
        ws.on('close', () => {
          if (this.ws === ws) {
            this.ws = null;
            this.log('[mcp] 中继连接断开，下一条命令时自动重连');
          }
        });
        ws.on('error', () => {}); // 断连细节在 close 统一处理，防 uncaughtException
        this.ws = ws;
        this._backoffMs = 1000; // 拨号成功，退避归位
        resolve(ws);
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`无法连接中继（ws://127.0.0.1:${this.port}）：${e.message}`));
      });
    });
  }

  // 对外入口：排队串行执行
  request(command) {
    const run = () => this._sendOne(command);
    const p = this._chain.then(run, run);
    this._chain = p.then(() => {}, () => {});
    return p;
  }

  async _sendOne(command) {
    const deadline = Date.now() + this.commandTimeoutMs;
    // 拨号（离线时按退避重试，直到本命令的 deadline）
    let ws = null;
    for (;;) {
      try {
        ws = await this.dial();
        break;
      } catch (e) {
        if (Date.now() >= deadline) throw new Error(`中继离线：${e.message}`);
        this.log(`[mcp] ${e.message}，${this._backoffMs / 1000}s 后重试`);
        await sleep(Math.min(this._backoffMs, deadline - Date.now()));
        this._backoffMs = Math.min(this._backoffMs * 2, this._backoffMaxMs);
      }
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve, reject,
        timer: setTimeout(() => {
          if (this._pending === entry) this._pending = null;
          reject(new Error(`命令超时（${this.commandTimeoutMs / 1000}s）`));
        }, Math.max(1, deadline - Date.now())),
      };
      this._pending = entry;
      try {
        ws.send(JSON.stringify({ role: 'cli', command }));
      } catch (e) {
        if (this._pending === entry) this._pending = null;
        clearTimeout(entry.timer);
        reject(new Error(`发送失败：${e.message}`));
      }
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const p = this._pending;
    if (!p) return; // 串行化下无挂起即迟到/无关消息，丢弃
    this._pending = null;
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || '中继返回失败'));
  }

  close() {
    if (this._pending) {
      clearTimeout(this._pending.timer);
      this._pending.reject(new Error('连接已关闭'));
      this._pending = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

module.exports = { probeRelay, BridgeConnection };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/mcp-connection.test.js`
Expected: PASS（7 例）

- [ ] **Step 5: 提交**

```bash
git add src/mcp/connection.js test/mcp-connection.test.js
git commit -m "feat: MCP 连接层（中继探测 + 长驻 WS 串行命令 + 指数退避重连）"
```

---

### Task 3: 工具层——`src/mcp/tools.js`（16 个工具定义表）

**Files:**
- Create: `src/mcp/tools.js`
- Test: `test/mcp-tools.test.js`（新建）

**Interfaces:**
- Consumes: `resolveFileKey`/`rasterizeSvgToPlaceImage`（Task 1）、`conn.request(command)`（Task 2）。
- Produces:
  - `TOOLS: Array<{ name, description, inputSchema, handler(args, ctx) → Promise<content[]> }>`；`ctx = { conn, saveDir? }`（`saveDir` 缺省 `<cwd>/exports`，测试可注入）；handler 抛 `Error` 由协议层包成 `isError`
  - content 形状：JSON 结果 → `[{ type: 'text', text }]`；PNG 导出 → `[{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text }]`；SVG 导出 → `[{ type: 'text', text: <svg源码> }, { type: 'text', text: <落盘路径> }]`
  - 16 个工具名（Task 4/5 断言用）：`list_files, ping, list_pages, create_page, goto_page, get_structure, inspect_node, render, update, remove, export_node, place_image, import_svg, set_image_fill, make_component, link`

- [ ] **Step 1: 写失败测试**

创建 `test/mcp-tools.test.js`：

```js
// MCP 工具层测试：mock conn（记录命令、按 action 返回罐头结果），不碰真实中继
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TOOLS } = require('../src/mcp/tools');

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// mock 连接：记录命令；__status 返回会话表；其余返回 { ack: action }
function mockConn({ sessions = [], results = {} } = {}) {
  const commands = [];
  return {
    commands,
    async request(command) {
      commands.push(command);
      if (command.action === '__status') {
        return { serverVersion: '0.0.0-test', port: 9741, pluginAlive: sessions.length > 0, sessions };
      }
      if (command.action in results) {
        const r = results[command.action];
        if (r instanceof Error) throw r;
        return typeof r === 'function' ? r(command) : r;
      }
      return { ack: command.action };
    },
  };
}

const ctxOf = (conn, saveDir) => ({ conn, ...(saveDir ? { saveDir } : {}) });
const toolByName = (name) => TOOLS.find((t) => t.name === name);

test('tools/list：16 个工具，schema 与描述齐备', () => {
  assert.equal(TOOLS.length, 16);
  for (const t of TOOLS) {
    assert.ok(t.name, '缺 name');
    assert.ok(t.description, `${t.name} 缺 description`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema 根应为 object`);
    assert.equal(typeof t.handler, 'function');
  }
  const names = TOOLS.map((t) => t.name);
  for (const n of ['list_files', 'ping', 'list_pages', 'create_page', 'goto_page', 'get_structure', 'inspect_node',
    'render', 'update', 'remove', 'export_node', 'place_image', 'import_svg', 'set_image_fill', 'make_component', 'link']) {
    assert.ok(names.includes(n), `缺工具 ${n}`);
  }
});

test('render：tree 递归 schema 可描述嵌套子节点（children $ref 存在）', () => {
  const render = toolByName('render');
  assert.ok(render.inputSchema.$defs && render.inputSchema.$defs.node, '缺 $defs.node');
  const node = render.inputSchema.$defs.node;
  assert.deepEqual(node.properties.type.enum, ['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'INSTANCE']);
  assert.equal(node.properties.children.items.$ref, '#/$defs/node');
  assert.deepEqual(node.properties.layout.properties.mode.enum, ['VERTICAL', 'HORIZONTAL', 'NONE']);
  assert.equal(render.inputSchema.properties.tree.$ref, '#/$defs/node');
});

test('render：tree 原样透传，file 选择器解析为 target', async () => {
  const conn = mockConn({ sessions: [{ fileKey: 'fkA', fileName: '设计稿', alive: true }] });
  const tree = { type: 'FRAME', name: '卡片', children: [{ type: 'TEXT', text: { characters: 'hi' } }] };
  const content = await toolByName('render').handler(
    { tree, file: '设计稿' }, ctxOf(conn),
  );
  const cmd = conn.commands.find((c) => c.action === 'render');
  assert.deepEqual(cmd.params.tree, tree, 'tree 不应被改写');
  assert.deepEqual(cmd.target, { fileKey: 'fkA' });
  assert.equal(conn.commands[0].action, '__status', '先解析选择器');
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /"ack":\s*"render"/);
});

test('不传 file 且单文件语义：命令不带 target（交给中继自动路由）', async () => {
  const conn = mockConn();
  await toolByName('ping').handler({}, ctxOf(conn));
  const cmd = conn.commands.find((c) => c.action === 'ping');
  assert.equal(cmd.target, undefined);
  assert.equal(conn.commands.length, 1, '不触发 __status');
});

test('export_node PNG：image content + 落盘 + 路径文本', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-export-'));
  const conn = mockConn({ results: { exportNode: { base64: TINY_PNG, format: 'PNG', byteLength: 70 } } });
  const content = await toolByName('export_node').handler({ nodeId: '1:2' }, ctxOf(conn, saveDir));
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].mimeType, 'image/png');
  assert.equal(content[0].data, TINY_PNG);
  const cmd = conn.commands.find((c) => c.action === 'exportNode');
  assert.deepEqual(cmd.params, { nodeId: '1:2', format: 'PNG', scale: 2 });
  const saved = content[1].text.match(/已保存：(.+\.png)/);
  assert.ok(saved, '应报告落盘路径');
  assert.deepEqual([...fs.readFileSync(saved[1]).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('export_node SVG：文本 content（SVG 源码）+ 落盘 .svg', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-export-'));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const b64 = Buffer.from(svg).toString('base64');
  const conn = mockConn({ results: { exportNode: { base64: b64, format: 'SVG', byteLength: b64.length } } });
  const content = await toolByName('export_node').handler({ nodeId: '1:2' }, ctxOf(conn, saveDir));
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, svg);
  assert.match(content[1].text, /已保存：.+\.svg/);
});
```

> 注：`export_node` 的"落盘失败不致命"分支是防御性兜底（try/catch + "未落盘"文案），不属于可测契约，不设专项用例，代码评审把关。

```test
test('update：nodeId 以外的参数全数进入 params（宽松透传）', async () => {
  const conn = mockConn();
  await toolByName('update').handler(
    { nodeId: '1:2', fills: ['#FF0000'], width: 100, file: undefined }, ctxOf(conn),
  );
  const cmd = conn.commands.find((c) => c.action === 'update');
  assert.deepEqual(cmd.params, { nodeId: '1:2', fills: ['#FF0000'], width: 100 });
});

test('place_image：读本地路径转 base64，path 不透传给中继', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-img-'));
  const img = path.join(dir, 'a.png');
  fs.writeFileSync(img, Buffer.from(TINY_PNG, 'base64'));
  const conn = mockConn();
  await toolByName('place_image').handler(
    { image_path: img, width: 40, height: 20, name: '头像' }, ctxOf(conn),
  );
  const cmd = conn.commands.find((c) => c.action === 'placeImage');
  assert.equal(cmd.params.width, 40);
  assert.equal(cmd.params.height, 20);
  assert.equal(cmd.params.name, '头像');
  assert.deepEqual([...Buffer.from(cmd.params.imageBase64, 'base64').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(cmd.params.image_path, undefined, '路径不应透传');
});

test('place_image：路径不可读报中文错误', async () => {
  await assert.rejects(
    toolByName('place_image').handler({ image_path: '/no/such/file.png' }, ctxOf(mockConn())),
    /无法读取图片文件：\/no\/such\/file\.png/,
  );
});

test('set_image_fill：nodeId + 本地路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-img-'));
  const img = path.join(dir, 'b.png');
  fs.writeFileSync(img, Buffer.from(TINY_PNG, 'base64'));
  const conn = mockConn();
  await toolByName('set_image_fill').handler({ nodeId: '9:9', image_path: img }, ctxOf(conn));
  const cmd = conn.commands.find((c) => c.action === 'setImageFill');
  assert.equal(cmd.params.nodeId, '9:9');
  assert.equal(cmd.params.scaleMode, undefined, '缺省 scaleMode 交给插件默认 FILL');
  assert.ok(cmd.params.imageBase64.length > 0);
});

test('import_svg：走栅格化产出 placeImage（sharp 缺失则整例 skip）', { skip: !hasSharp() }, async () => {
  const conn = mockConn();
  await toolByName('import_svg').handler(
    { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', width: 16, height: 16 }, ctxOf(conn),
  );
  const cmd = conn.commands.find((c) => c.action === 'placeImage');
  assert.equal(cmd.action, 'placeImage');
  assert.equal(cmd.params.width, 16);
});

test('list_files：__status 精简输出', async () => {
  const conn = mockConn({ sessions: [{ fileKey: 'fkA', fileName: '文件A', pluginVersion: '0.3.0', alive: true, queuedCommands: 0 }] });
  const content = await toolByName('list_files').handler({}, ctxOf(conn));
  const parsed = JSON.parse(content[0].text);
  assert.equal(parsed.pluginAlive, true);
  assert.deepEqual(parsed.sessions[0], { fileName: '文件A', fileKey: 'fkA', pluginVersion: '0.3.0', alive: true, queuedCommands: 0 });
});

test('handler 抛错直接冒泡（协议层负责包 isError）', async () => {
  const conn = mockConn({ sessions: [], results: { ping: new Error('插件不在线') } });
  await assert.rejects(toolByName('ping').handler({}, ctxOf(conn)), /插件不在线/);
});

function hasSharp() {
  try { require.resolve('sharp'); return true; } catch { return false; }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/mcp-tools.test.js`
Expected: FAIL（`Cannot find module '../src/mcp/tools'`）

- [ ] **Step 3: 实现 `src/mcp/tools.js`**

```js
// MCP 工具定义表：16 个 tools ↔ 中继 action 的翻译层。
// handler(args, ctx) 收 AI 参数与 { conn, saveDir? }，返回 MCP content 数组；
// 抛错由协议层（main.js createRpcHandler）包成 isError: true 的文本响应。
// file 选择器语义与 CLI --file 一致（src/relay-client.js resolveFileKey）。
const fs = require('fs');
const path = require('path');
const { resolveFileKey, rasterizeSvgToPlaceImage } = require('../relay-client');

const FILE_PARAM = {
  type: 'string',
  description: '目标文件：fileKey 或文件名唯一子串（大小写不敏感）。多文件在线时建议携带（先用 list_files 查看）；不传且恰好一个文件在线时自动路由。',
};

// 解析 file 选择器 → 注入 target；返回完整命令
async function withTarget(ctx, file, action, params) {
  const command = { action, params };
  if (file) {
    command.target = { fileKey: await resolveFileKey(() => ctx.conn.request({ action: '__status' }), file) };
  }
  return command;
}

// 通用形态：发命令，result 作为 JSON 文本返回
async function sendAction(ctx, file, action, params) {
  const result = await ctx.conn.request(await withTarget(ctx, file, action, params));
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}

function readImageBase64(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    throw new Error(`无法读取图片文件：${p}（${e.message}）`);
  }
  return buf.toString('base64');
}

// render 节点树的递归 schema：type/name/尺寸/坐标/填充/圆角/描边/自动布局/文本/组件实例/children
const NODE_SCHEMA = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { enum: ['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'INSTANCE'] },
    name: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    x: { type: 'number', description: '父级非自动布局时生效；不传自动向右排开' },
    y: { type: 'number' },
    fills: { type: 'array', items: { type: 'string' }, description: '#RRGGBB 或 #RRGGBBAA' },
    cornerRadius: { type: 'number' },
    topLeftRadius: { type: 'number', description: '逐角圆角（topRight/bottomLeft/bottomRight 同名）' },
    topRightRadius: { type: 'number' },
    bottomLeftRadius: { type: 'number' },
    bottomRightRadius: { type: 'number' },
    stroke: { type: 'object', properties: { color: { type: 'string' }, weight: { type: 'number' } } },
    layout: {
      type: 'object',
      description: '自动布局（仅 FRAME）',
      properties: {
        mode: { enum: ['VERTICAL', 'HORIZONTAL', 'NONE'] },
        gap: { type: 'number' },
        padding: { type: 'array', items: { type: 'number' }, description: '[上,右,下,左]' },
        primaryAlign: { enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] },
        counterAlign: { enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] },
        primarySizing: { enum: ['AUTO', 'FIXED'] },
        counterSizing: { enum: ['AUTO', 'FIXED'], description: '含文本的容器建议 AUTO，否则文字裁切' },
      },
    },
    text: {
      anyOf: [
        { type: 'string', description: 'INSTANCE：覆盖组件实例的文字' },
        {
          type: 'object',
          description: 'TEXT：文字内容与样式',
          required: ['characters'],
          properties: {
            characters: { type: 'string' },
            fontSize: { type: 'number' },
            fontWeight: { type: 'number', description: '100-900' },
            fontFamily: { type: 'string' },
            color: { type: 'string' },
            align: { enum: ['LEFT', 'CENTER', 'RIGHT'] },
            lineHeightPercent: { type: 'number' },
            width: { type: 'number', description: '长文本必须给 width（定宽换行），否则被裁切' },
          },
        },
      ],
    },
    component: { type: 'string', description: 'INSTANCE 必填：本文件中的主组件名，如 "按钮/主要/中"' },
    textColor: { type: 'string', description: 'INSTANCE：覆盖文字颜色 #RRGGBB' },
    children: { type: 'array', items: { $ref: '#/$defs/node' } },
  },
};

const TOOLS = [
  {
    name: 'list_files',
    description: '列出当前在线的 Figma 文件（文件名/fileKey/插件版本/排队数）。多文件操作前先调用它确定 file 参数。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const s = await ctx.conn.request({ action: '__status' });
      const sessions = (s.sessions || []).map((x) => ({
        fileName: x.fileName, fileKey: x.fileKey, pluginVersion: x.pluginVersion,
        alive: x.alive, queuedCommands: x.queuedCommands,
      }));
      return [{ type: 'text', text: JSON.stringify({ serverVersion: s.serverVersion, port: s.port, pluginAlive: s.pluginAlive, sessions }, null, 2) }];
    },
  },
  {
    name: 'ping',
    description: '端到端连通性验证：返回目标文件名、当前页名与页 id。',
    inputSchema: { type: 'object', properties: { file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'ping', {}),
  },
  {
    name: 'list_pages',
    description: '列出文件的所有页面（id/名称）。',
    inputSchema: { type: 'object', properties: { file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'listPages', {}),
  },
  {
    name: 'create_page',
    description: '新建页面。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '页面名，缺省"未命名页面"' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'createPage', { name: args.name }),
  },
  {
    name: 'goto_page',
    description: '切换当前页面（pageId 或 pageName 二选一）。get_structure/渲染坐标都作用于当前页。',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, pageName: { type: 'string' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'gotoPage', { pageId: args.pageId, pageName: args.pageName }),
  },
  {
    name: 'get_structure',
    description: '读取当前页面的节点树（id/name/type/尺寸/坐标）。depth 越大越深，默认 2。',
    inputSchema: { type: 'object', properties: { depth: { type: 'number', description: '层级深度，默认 2' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'getStructure', { depth: args.depth }),
  },
  {
    name: 'inspect_node',
    description: '读取单个节点的完整样式细节（填充/描边/阴影/圆角/文本/自动布局），design-to-code 的核心读取工具。depth 默认 3。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, depth: { type: 'number' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'inspectNode', { nodeId: args.nodeId, depth: args.depth }),
  },
  {
    name: 'render',
    description: '在当前页渲染一棵声明式节点树（FRAME/RECTANGLE/ELLIPSE/TEXT/INSTANCE，支持自动布局与组件实例）。返回根节点 id。',
    inputSchema: {
      type: 'object',
      $defs: { node: NODE_SCHEMA },
      required: ['tree'],
      properties: {
        tree: { $ref: '#/$defs/node', description: '节点树根' },
        parentNodeId: { type: 'string', description: '挂载到的父节点；不传挂到当前页' },
        x: { type: 'number' },
        y: { type: 'number' },
        file: FILE_PARAM,
      },
    },
    handler: (args, ctx) => sendAction(ctx, args.file, 'render', { tree: args.tree, parentNodeId: args.parentNodeId, x: args.x, y: args.y }),
  },
  {
    name: 'update',
    description: '修改已有节点属性。常用键：name/x/y/width/height/fills/cornerRadius（或逐角 topLeftRadius 等）/visible/stroke/layout/text。未知属性被插件忽略。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, file: FILE_PARAM }, additionalProperties: true },
    handler: (args, ctx) => {
      const { file, ...props } = args;
      return sendAction(ctx, file, 'update', props);
    },
  },
  {
    name: 'remove',
    description: '删除节点。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'remove', { nodeId: args.nodeId }),
  },
  {
    name: 'export_node',
    description: '导出节点为 PNG（默认，图片直接内联返回）或 SVG（文本返回），同时落盘 exports/ 目录。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, format: { enum: ['PNG', 'SVG'], description: '默认 PNG' }, scale: { type: 'number', description: 'PNG 缩放倍数，默认 2' }, file: FILE_PARAM } },
    handler: async (args, ctx) => {
      const result = await ctx.conn.request(await withTarget(ctx, args.file, 'exportNode', {
        nodeId: args.nodeId, format: args.format || 'PNG', scale: args.scale || 2,
      }));
      const content = [];
      if (result.format === 'SVG') {
        content.push({ type: 'text', text: Buffer.from(result.base64, 'base64').toString('utf8') });
      } else {
        content.push({ type: 'image', data: result.base64, mimeType: 'image/png' });
      }
      let saved = '';
      try {
        const outDir = ctx.saveDir || path.join(process.cwd(), 'exports');
        fs.mkdirSync(outDir, { recursive: true });
        saved = path.join(outDir, `${Date.now()}.${result.format === 'SVG' ? 'svg' : 'png'}`);
        fs.writeFileSync(saved, Buffer.from(result.base64, 'base64'));
      } catch {
        saved = '';
      }
      content.push({
        type: 'text',
        text: saved ? `已保存：${saved}（${result.byteLength} 字节）` : `未落盘（目录不可写？），已直接返回内容（${result.byteLength} 字节）`,
      });
      return content;
    },
  },
  {
    name: 'place_image',
    description: '把本地图片文件放置到画布（矩形节点 + 图片填充）。',
    inputSchema: {
      type: 'object', required: ['image_path'],
      properties: {
        image_path: { type: 'string', description: '本地图片文件路径' },
        width: { type: 'number', description: '默认 24' },
        height: { type: 'number', description: '默认 24' },
        name: { type: 'string' },
        parentNodeId: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' },
        scaleMode: { enum: ['FIT', 'FILL', 'CROP', 'TILE'], description: '默认 FIT' },
        file: FILE_PARAM,
      },
    },
    handler: (args, ctx) => sendAction(ctx, args.file, 'placeImage', {
      imageBase64: readImageBase64(args.image_path),
      width: args.width, height: args.height, name: args.name,
      parentNodeId: args.parentNodeId, x: args.x, y: args.y, scaleMode: args.scaleMode,
    }),
  },
  {
    name: 'import_svg',
    description: '导入 SVG 字符串：本地栅格化为透明 PNG 后走 placeImage（插件沙箱无 SVG 导入 API）。需要可选依赖 sharp。',
    inputSchema: {
      type: 'object', required: ['svg'],
      properties: {
        svg: { type: 'string' },
        width: { type: 'number', description: '默认 24' },
        height: { type: 'number', description: '默认 24' },
        name: { type: 'string' },
        parentNodeId: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' },
        file: FILE_PARAM,
      },
    },
    handler: async (args, ctx) => {
      const command = await rasterizeSvgToPlaceImage({
        svg: args.svg, width: args.width, height: args.height,
        name: args.name, parentNodeId: args.parentNodeId, x: args.x, y: args.y,
      });
      const result = await ctx.conn.request(await withTarget(ctx, args.file, command.action, command.params));
      return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    },
  },
  {
    name: 'set_image_fill',
    description: '把本地图片设为已有节点的填充（默认 FILL 模式）。',
    inputSchema: {
      type: 'object', required: ['nodeId', 'image_path'],
      properties: {
        nodeId: { type: 'string' },
        image_path: { type: 'string', description: '本地图片文件路径' },
        scaleMode: { enum: ['FILL', 'FIT', 'CROP', 'TILE'], description: '默认 FILL' },
        file: FILE_PARAM,
      },
    },
    handler: (args, ctx) => sendAction(ctx, args.file, 'setImageFill', {
      nodeId: args.nodeId, imageBase64: readImageBase64(args.image_path), scaleMode: args.scaleMode,
    }),
  },
  {
    name: 'make_component',
    description: '把节点转为主组件（TEXT 节点不可转）。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'makeComponent', { nodeId: args.nodeId }),
  },
  {
    name: 'link',
    description: '创建原型连线：点击 from 节点跳转到 to 节点。',
    inputSchema: { type: 'object', required: ['fromNodeId', 'toNodeId'], properties: { fromNodeId: { type: 'string' }, toNodeId: { type: 'string' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'link', { fromNodeId: args.fromNodeId, toNodeId: args.toNodeId }),
  },
];

module.exports = { TOOLS };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/mcp-tools.test.js`
Expected: PASS（sharp 未安装时 import_svg 用例 skip）

- [ ] **Step 5: 提交**

```bash
git add src/mcp/tools.js test/mcp-tools.test.js
git commit -m "feat: MCP 工具层（16 个工具定义：schema、file 选择器、图片路径转换、导出内联返回）"
```

---

### Task 4: 协议与生命周期——`src/mcp/main.js`

**Files:**
- Create: `src/mcp/main.js`
- Test: `test/mcp-main.test.js`（新建）

**Interfaces:**
- Consumes: `probeRelay`（Task 2）、`BridgeConnection`（Task 2）、`TOOLS`（Task 3）、`bin/cli.js server`（已有入口）。
- Produces:
  - `ensureRelay(port, logger?) → Promise<{ child: ChildProcess|null }>`：在线复用（child null）；离线 spawn `node <pkg>/bin/cli.js server`（`FLB_PORT` 透传、stdio ignore），200ms 间隔探测就绪、5s 上限
  - `createRpcHandler({ tools, conn, logger? }) → async (msg) => response|null`：`initialize`（版本回显 + `serverInfo`）、`tools/list`、`tools/call`（业务失败 → `isError: true` + 文本；未知工具 → `-32602`）、协议级 `ping` → `{}`、未知方法（带 id）→ `-32601`、通知 → `null`
  - `start()`：stdio 循环（readline），stdin end / SIGINT / exit 时回收自己 spawn 的中继子进程

- [ ] **Step 1: 写失败测试**

创建 `test/mcp-main.test.js`：

```js
// MCP 协议与生命周期测试：ensureRelay 对接真实端口/子进程；createRpcHandler 纯函数单测
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { once } = require('node:events');

setTimeout(() => { console.error('看门狗：测试 30s 未结束'); process.exit(1); }, 30_000).unref();

const { createBridgeServer } = require('../src/server');
const { ensureRelay, createRpcHandler } = require('../src/mcp/main');
const { TOOLS } = require('../src/mcp/tools');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}

async function waitExit(child) {
  await Promise.race([once(child, 'exit'), sleep(5000)]);
}

test('ensureRelay：中继在线时复用（不 spawn）', async () => {
  const { bridge, port } = await startBridge();
  try {
    const { child } = await ensureRelay(port, () => {});
    assert.equal(child, null, '应复用已有中继');
  } finally { await bridge.close(); }
});

test('ensureRelay：中继离线时 spawn 子进程并等待就绪', async () => {
  const port = await getFreePort();
  const { child } = await ensureRelay(port, () => {});
  try {
    assert.ok(child, '应 spawn 中继子进程');
    await sleep(400); // 就绪探测已在 ensureRelay 内完成，稍候确认端口活着
    const r = await fetch(`http://127.0.0.1:${port}/hello?fileKey=probe&fileName=p&version=x&instanceId=i`);
    assert.equal(r.status, 200);
  } finally {
    child.kill('SIGTERM');
    await waitExit(child);
  }
});

// ---------- createRpcHandler 纯函数单测 ----------

function fakeConn(overrides = {}) {
  return {
    async request(command) {
      if (command.action in overrides) {
        const r = overrides[command.action];
        if (r instanceof Error) throw r;
        return r;
      }
      return { ack: command.action };
    },
    close() {},
  };
}

function handlerOf(conn) {
  return createRpcHandler({ tools: TOOLS, conn, logger: () => {} });
}

test('initialize：回显 protocolVersion，带 capabilities 与 serverInfo', async () => {
  const resp = await handlerOf(fakeConn())({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(resp.result.protocolVersion, '2025-06-18');
  assert.deepEqual(resp.result.capabilities, { tools: {} });
  assert.equal(resp.result.serverInfo.name, 'figma-local-bridge');
  assert.ok(resp.result.serverInfo.version, '应有包版本');
});

test('tools/list：16 个工具，仅含 name/description/inputSchema', async () => {
  const resp = await handlerOf(fakeConn())({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(resp.result.tools.length, 16);
  for (const t of resp.result.tools) {
    assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name']);
  }
});

test('tools/call：成功返回 content', async () => {
  const resp = await handlerOf(fakeConn())({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } });
  assert.equal(resp.result.isError, undefined);
  assert.equal(resp.result.content[0].type, 'text');
  assert.match(resp.result.content[0].text, /"ack":\s*"ping"/);
});

test('tools/call：业务失败 → isError true + 中文文本', async () => {
  const resp = await handlerOf(fakeConn({ ping: new Error('Figma 插件未连接：请先在 Figma 中运行「Figma Local Bridge」插件并保持打开') }))({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ping', arguments: {} } });
  assert.equal(resp.result.isError, true);
  assert.match(resp.result.content[0].text, /插件未连接/);
});

test('tools/call：未知工具 → -32602', async () => {
  const resp = await handlerOf(fakeConn())({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(resp.error.code, -32602);
});

test('协议级 ping → {}；notifications → null；未知方法（带 id）→ -32601；未知通知不响应', async () => {
  const h = handlerOf(fakeConn());
  assert.deepEqual((await h({ jsonrpc: '2.0', id: 6, method: 'ping' })).result, {});
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  const err = await h({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.equal(err.error.code, -32601);
  assert.equal(await h({ jsonrpc: '2.0', method: 'resources/list' }), null);
});

async function startBridge(opts = {}) {
  const bridge = createBridgeServer({ pollHoldMs: 400, commandTimeoutMs: 2000, queueTtlMs: 5000, heartbeatMs: 200, sessionEvictMs: 10000, logger: () => {}, ...opts });
  await bridge.listen('127.0.0.1');
  return { bridge, port: bridge.port };
}
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/mcp-main.test.js`
Expected: FAIL（`Cannot find module '../src/mcp/main'`）

- [ ] **Step 3: 实现 `src/mcp/main.js`**

```js
// MCP stdio server 入口：换行分隔的 JSON-RPC 2.0 过 stdin/stdout（手写协议，零新依赖）。
// 生命周期：启动探测中继端口 → 不在线 spawn `figma-bridge server` 子进程 → 退出时回收自己拉起的。
// stdout 只写协议 JSON 行；一切日志走 stderr。
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const { probeRelay, BridgeConnection } = require('./connection');
const { TOOLS } = require('./tools');

const PKG_VERSION = require(path.join(__dirname, '..', '..', 'package.json')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 探测 → 不在线则拉起并等待就绪（200ms 间隔，5s 上限）。
// child 为 null 表示复用了外部中继（退出时不动它）。
async function ensureRelay(port, logger = () => {}) {
  if (await probeRelay(port, 500)) {
    logger(`[mcp] 复用已有中继（端口 ${port}）`);
    return { child: null };
  }
  logger(`[mcp] 端口 ${port} 无中继，自动拉起 figma-bridge server…`);
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'cli.js'), 'server'], {
    stdio: 'ignore',
    env: { ...process.env, FLB_PORT: String(port) },
  });
  child.on('error', (e) => logger(`[mcp] 中继子进程异常：${e.message}`));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (await probeRelay(port, 300)) {
      logger(`[mcp] 中继已就绪（端口 ${port}）`);
      return { child };
    }
  }
  logger('[mcp] 中继拉起后仍未就绪（端口被占用？），工具调用时将报中继离线');
  return { child };
}

// JSON-RPC 分发器：返回响应对象（通知返回 null，不写 stdout）
function createRpcHandler({ tools, conn, logger = () => {} }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || !msg.method) return null;
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      if (msg.method === 'initialize') {
        return {
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: msg.params && msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'figma-local-bridge', version: PKG_VERSION },
          },
        };
      }
      if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return null;
      if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
      if (msg.method === 'tools/list') {
        return {
          jsonrpc: '2.0', id: msg.id,
          result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
        };
      }
      if (msg.method === 'tools/call') {
        const name = msg.params && msg.params.name;
        const tool = byName.get(name);
        if (!tool) {
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `未知工具：${name}` } };
        }
        try {
          const content = await tool.handler((msg.params && msg.params.arguments) || {}, { conn });
          return { jsonrpc: '2.0', id: msg.id, result: { content } };
        } catch (e) {
          return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: e.message }], isError: true } };
        }
      }
      if (isRequest) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
      return null;
    } catch (e) {
      logger(`[mcp] 处理异常：${e.message}`);
      return isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } } : null;
    }
  };
}

async function start() {
  const port = Number(process.env.FLB_PORT || 9741);
  const logger = console.error.bind(console);
  const { child } = await ensureRelay(port, logger);
  const conn = new BridgeConnection({ port, logger });
  const handle = createRpcHandler({ tools: TOOLS, conn, logger });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非协议行忽略（不能写 stdout）
    }
    handle(msg).then((resp) => {
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
    });
  });

  const cleanup = () => {
    try { conn.close(); } catch {}
    if (child) {
      try { child.kill(); } catch {}
    }
  };
  rl.on('close', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', () => {
    if (child) {
      try { child.kill(); } catch {}
    }
  });
  logger(`[mcp] figma-local-bridge MCP server v${PKG_VERSION} 就绪（中继端口 ${port}${child ? '，已自动拉起' : ''}）`);
}

module.exports = { start, ensureRelay, createRpcHandler };

if (require.main === module) start();
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/mcp-main.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/mcp/main.js test/mcp-main.test.js
git commit -m "feat: MCP 协议层与中继生命周期（JSON-RPC 分发 + 探测/拉起/回收）"
```

---

### Task 5: CLI 入口 + 端到端测试

**Files:**
- Modify: `bin/cli.js`（`mcp` 子命令 + 用法文本）
- Test: `test/mcp-e2e.test.js`（新建）

**Interfaces:**
- Consumes: `src/mcp/main.js` 的 `start()`（Task 4）、真实 `createBridgeServer` + fetch 假插件（server.test.js 模式）。
- Produces: `figma-bridge mcp` 可被 MCP 客户端以 `npx figma-bridge mcp` 拉起。

- [ ] **Step 1: 写失败的端到端测试**

创建 `test/mcp-e2e.test.js`：

```js
// 端到端：spawn 真实 `bin/cli.js mcp` 子进程（stdin/stdout）+ 真实中继 + fetch 假插件。
// 验证：握手 → tools/list → tools/call（render / export_node 的 image content）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('child_process');

setTimeout(() => { console.error('看门狗：测试 45s 未结束'); process.exit(1); }, 45_000).unref();

const { createBridgeServer } = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const FAST = { pollHoldMs: 400, commandTimeoutMs: 8000, queueTtlMs: 8000, heartbeatMs: 200, sessionEvictMs: 20000 };

// 按应答器自动执行的假插件
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
          const result = body.command.action === 'exportNode'
            ? { base64: TINY_PNG, format: 'PNG', byteLength: 70 }
            : { ack: body.command.action };
          await fetch(`${base}/result`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: body.command.id, sessionId, ok: true, result }),
          });
        }
      } catch { await sleep(30); }
    }
  })();
  return { commands, stop: () => { stopped = true; } };
}

// 逐行读取子进程 stdout
function lineReader(child) {
  const ready = [];
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line); else ready.push(line);
    }
  });
  return { next: () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((res) => waiters.push(res))) };
}

test('端到端：握手 → 工具清单 → render → export_node 图片内联', async () => {
  const bridge = createBridgeServer({ ...FAST, logger: () => {} });
  await bridge.listen('127.0.0.1');
  const base = `http://127.0.0.1:${bridge.port}`;
  // 插件 hello（fileKey 与后续 file 选择器一致）
  await fetch(`${base}/hello?fileKey=e2eKey&fileName=${encodeURIComponent('端到端文件')}&version=x&instanceId=i1`);
  const poller = autoPoller(base, 'e2eKey:i1');

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-e2e-'));
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, FLB_PORT: String(bridge.port) },
    cwd: workdir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const reader = lineReader(child);
  const write = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const call = async (id, method, params) => {
    write({ jsonrpc: '2.0', id, method, params });
    for (;;) {
      const msg = JSON.parse(await reader.next());
      if (msg.id === id) return msg;
    }
  };

  try {
    // 子进程复用测试中继（而非拉起自己的）
    const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    await sleep(300);
    assert.match(stderr, /复用已有中继/, '应复用测试中继而非 spawn');

    const list = await call(2, 'tools/list');
    assert.equal(list.result.tools.length, 16);

    const render = await call(3, 'tools/call', { name: 'render', arguments: { tree: { type: 'FRAME', name: 'e2e 卡片' }, file: '端到端文件' } });
    assert.equal(render.result.isError, undefined);
    assert.match(render.result.content[0].text, /"ack":\s*"render"/);
    const renderCmd = poller.commands.find((c) => c.action === 'render');
    assert.deepEqual(renderCmd.target, { fileKey: 'e2eKey' }, '选择器解析为 target');

    const exp = await call(4, 'tools/call', { name: 'export_node', arguments: { nodeId: '1:2' } });
    assert.equal(exp.result.content[0].type, 'image');
    assert.equal(exp.result.content[0].data, TINY_PNG);
    assert.match(exp.result.content[1].text, /已保存：.+\.png/, '落盘到 workdir/exports');
    assert.ok(fs.existsSync(path.join(workdir, 'exports')));
  } finally {
    poller.stop();
    child.kill('SIGTERM');
    await new Promise((res) => child.on('exit', res));
    await bridge.close();
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/mcp-e2e.test.js`
Expected: FAIL（`bin/cli.js mcp` 未知子命令 → 默认分支打印用法退出，读行永不返回，最终看门狗/断言失败）

- [ ] **Step 3: `bin/cli.js` 加 `mcp` 子命令**

`main()` 的 switch 增加分支（放在 `server` case 之后）：

```js
    case 'mcp':
      require(path.join(__dirname, '..', 'src', 'mcp', 'main.js')).start();
      break;
```

default 分支的用法文本更新为：

```js
      console.log('用法：figma-bridge <server|mcp|send|render|export|list-files|install-plugin|doctor>');
```

文件头注释的子命令清单同步加一行 `//   mcp                           启动 MCP stdio server（供 AI 代理接入）`。

- [ ] **Step 4: 运行端到端测试确认通过**

Run: `node --test test/mcp-e2e.test.js`
Expected: PASS

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 全部 PASS（server/plugin/relay-client/connection/tools/main/e2e）

- [ ] **Step 6: 提交**

```bash
git add bin/cli.js test/mcp-e2e.test.js
git commit -m "feat: figma-bridge mcp 子命令 + 端到端测试（握手/工具清单/render/export 内联）"
```

---

### Task 6: 版本 0.3.0 + README MCP 章节 + CHANGELOG

**Files:**
- Modify: `package.json`（version → 0.3.0）
- Modify: `plugin/code.js:6`（PLUGIN_VERSION → '0.3.0'，见实现注记 2）
- Modify: `README.md`（新增 MCP 章节）
- Modify: `CHANGELOG.md`（0.3.0 条目）

**Interfaces:** 无代码接口；`server.js` 的 SERVER_VERSION 随包版本变为 0.3.0，与插件版本保持一致（doctor 校验语义不变）。

- [ ] **Step 1: 升版本**

`package.json`：`"version": "0.3.0"`。
`plugin/code.js` 第 6 行：`var PLUGIN_VERSION = '0.3.0';`

- [ ] **Step 2: README 新增「MCP 接入」章节**

插入在「每次使用（三步）」与「命令」之间：

```markdown
## MCP 接入（AI 代理）

`figma-bridge mcp` 是标准 MCP stdio server：把插件命令暴露为 16 个自描述工具（渲染/读取/导出/组件/原型连线），AI 无需读文档即可拼对参数。特色：

- **图片内联**：`export_node` 直接返回 PNG 图片内容（AI 立即看到画布），同时落盘 `exports/`
- **本地路径输入**：`place_image`/`set_image_fill`/`import_svg` 直接收本地图片路径，无需 base64
- **自动拉起中继**：启动时探测 9741 端口，中继不在线则自动拉起；MCP 客户端退出时回收自己拉起的中继
- **多文件**：所有工具支持 `file` 参数（fileKey 或文件名唯一子串），语义与 CLI `--file` 一致

MCP 客户端配置示例（ZCode / Claude Desktop / Cursor 同格式）：

```json
{ "mcpServers": { "figma": { "command": "npx", "args": ["figma-bridge", "mcp"] } } }
```

> 插件侧仍需按 [插件安装与配置指南](docs/plugin-setup.md) 装好并在目标文件中运行（中继与插件不变）。

MCP 与 CLI 的分工：**MCP 给 AI 代理**（schema 自描述、图片直接可见、工具级权限）；**CLI 给人**调试与脚本（`doctor`/`send`/`install-plugin`）。
```

- [ ] **Step 3: CHANGELOG 条目**

`CHANGELOG.md` 顶部新增：

```markdown
## 0.3.0

- 新增 `figma-bridge mcp`：MCP stdio server，16 个自描述工具（list_files / ping / list_pages / create_page / goto_page / get_structure / inspect_node / render / update / remove / export_node / place_image / import_svg / set_image_fill / make_component / link）
- 中继自动拉起：MCP server 启动探测 9741，不在线自动 spawn 中继子进程，退出时回收
- `export_node` 返回 MCP 图片内容并落盘 exports/；`place_image`/`set_image_fill` 收本地图片路径；`import_svg` 复用 sharp 栅格化
- CLI 与 MCP 共享 file 选择器与 SVG 栅格化（新增 `src/relay-client.js`），CLI 行为不变
- 升级动作：`install-plugin` 并重启插件（插件仅版本常量同步至 0.3.0）
```

- [ ] **Step 4: 全量回归 + 手工冒烟**

Run: `npm test`
Expected: 全部 PASS

冒烟（可选但建议）：

```bash
node bin/cli.js mcp &   # 观察 stderr 应出现"自动拉起/复用中继"日志；Ctrl-C 退出
node bin/cli.js doctor
```

- [ ] **Step 5: 提交**

```bash
git add package.json plugin/code.js README.md CHANGELOG.md
git commit -m "chore: 发布 0.3.0（MCP server 入口 + README 接入指南 + CHANGELOG）"
```
