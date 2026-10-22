// 中继服务测试：node --test test/
// 依赖 src/server.js 暴露 createBridgeServer(options) 工厂：
//   - 可注入 pollHoldMs / commandTimeoutMs / queueTtlMs / heartbeatMs / sessionEvictMs（默认值同生产）
//   - listen() 后 bridge.port 为实际端口；close() 释放端口并清理全部定时器
// 定时器注入是为了让 TTL/心跳类行为在毫秒级可测。
const test = require('node:test');
const assert = require('node:assert');
const { WebSocket } = require('ws');

// 看门狗：任何句柄泄漏（如挂起的轮询）导致事件循环不退出时，强制失败退出。
// unref：测试正常结束时它不应阻止进程退出。
setTimeout(() => {
  console.error('看门狗：测试 30s 未结束，存在未清理的句柄');
  process.exit(1);
}, 30_000).unref();

const { createBridgeServer } = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAST = { pollHoldMs: 400, commandTimeoutMs: 600, queueTtlMs: 400, heartbeatMs: 200, sessionEvictMs: 2000 };

async function startBridge(opts = {}) {
  const bridge = createBridgeServer({ ...FAST, logger: () => {}, ...opts });
  await bridge.listen('127.0.0.1');
  return { bridge, port: bridge.port, base: `http://127.0.0.1:${bridge.port}` };
}

async function hello(base, { fileKey = 'testFileKey', fileName = '测试文件', instanceId = 'inst1', version = '0.0.0-test' } = {}) {
  const r = await fetch(`${base}/hello?fileKey=${encodeURIComponent(fileKey)}&fileName=${encodeURIComponent(fileName)}&version=${version}&instanceId=${instanceId}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.sessionId, 'hello 响应缺 sessionId');
  return body.sessionId;
}

// 与 src/client.js 相同模式的一条 WS 命令
function sendOne(port, command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS 回复超时')); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ role: 'cli', command })));
    ws.on('message', (raw) => {
      clearTimeout(timer); ws.close();
      try { resolve(JSON.parse(raw.toString())); } catch (e) { reject(e); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// 单次挂起的 /poll（不自动应答），abort() 模拟插件侧连接中断
function hangPoll(base, sessionId) {
  const ac = new AbortController();
  const done = fetch(`${base}/poll?sessionId=${encodeURIComponent(sessionId)}`, { signal: ac.signal })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  return { done, abort: () => ac.abort() };
}

// 自动应答型 poller（模拟插件循环）：收到命令就 POST 一个小结果
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

function opened(ws) {
  return new Promise((res) => ws.on('open', res));
}

// 捕获本进程 uncaughtException（崩溃路径测试用：把"进程崩溃"变成可断言的失败）
function captureUncaught() {
  const errors = [];
  const handler = (e) => errors.push(e);
  process.on('uncaughtException', handler);
  return { errors, done: () => process.off('uncaughtException', handler) };
}

test('__status：hello 后插件在线、端口正确', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    await hello(base);
    const m = await sendOne(port, { action: '__status' });
    assert.equal(m.ok, true);
    assert.equal(m.result.port, port);
    assert.equal(m.result.pluginAlive, true);
    assert.equal(m.result.sessions[0].fileName, '测试文件');
  } finally {
    await bridge.close();
  }
});

test('命令投递：poller 收到命令，CLI 收到结果', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const sid = await hello(base);
    const p = hangPoll(base, sid);
    const replyP = sendOne(port, { action: 'ping' });
    const delivered = await p.done;
    assert.equal(delivered.body.command.action, 'ping');
    await fetch(`${base}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: delivered.body.command.id, sessionId: sid, ok: true, result: { pong: true } }),
    });
    const reply = await replyP;
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.result, { pong: true });
  } finally {
    await bridge.close();
  }
});

test('执行超时：插件不回结果时 CLI 在 commandTimeoutMs 后收到失败', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const sid = await hello(base);
    const p = hangPoll(base, sid); // 收到命令但永不回结果
    const t0 = Date.now();
    const reply = await sendOne(port, { action: 'ping' });
    await p.done;
    assert.equal(reply.ok, false);
    assert.match(reply.error, /超时/);
    assert.ok(Date.now() - t0 >= 550, `过快返回：${Date.now() - t0}ms`);
  } finally {
    await bridge.close();
  }
});

test('队列 TTL：插件不来取，命令在 queueTtlMs 后被驱逐并答复 CLI', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    await hello(base);
    const t0 = Date.now();
    const reply = await sendOne(port, { action: 'ping' }); // 没有任何 poller
    assert.equal(reply.ok, false);
    assert.match(reply.error, /超时/);
    assert.ok(Date.now() - t0 >= 380, `过快驱逐：${Date.now() - t0}ms`);
    assert.ok(Date.now() - t0 < 3000, `驱逐过慢：${Date.now() - t0}ms`);
  } finally {
    await bridge.close();
  }
});

test('双 poller：3 条命令各送达一次，服务保持健康', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const sid = await hello(base);
    const a = autoPoller(base, sid);
    const b = autoPoller(base, sid);
    for (let i = 0; i < 3; i++) {
      const reply = await sendOne(port, { action: 'ping', i });
      assert.equal(reply.ok, true, `第 ${i} 条命令失败`);
    }
    await sleep(100);
    assert.equal(a.commands.length + b.commands.length, 3, '命令应各送达恰好一次');
    const m = await sendOne(port, { action: '__status' });
    assert.equal(m.ok, true);
    a.stop(); b.stop();
  } finally {
    await bridge.close();
  }
});

test('孤儿 poll：A 中断后其挂起 timer 不应清掉 B 的注册（命令仍即时送达 B）', async () => {
  const { bridge, port, base } = await startBridge();
  const cap = captureUncaught();
  try {
    const sid = await hello(base);
    const a = hangPoll(base, sid);
    a.done.catch(() => {}); // abort 是预期行为，吞掉 AbortError 避免 unhandled rejection
    await sleep(FAST.pollHoldMs / 2);
    const b = hangPoll(base, sid);
    await sleep(40);
    a.abort(); // A 断开；其 timer 不应影响 B
    // 等过 A 原始 timer 的触发点（t0+hold），但早于 B 自己的 timer（t0+0.5hold+hold）
    await sleep(FAST.pollHoldMs / 2);
    const replyP = sendOne(port, { action: 'ping' });
    const delivered = await b.done; // B 应收到命令而不是空轮询
    assert.ok(delivered.body.command, `B 未收到命令：${JSON.stringify(delivered.body)}`);
    await fetch(`${base}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: delivered.body.command.id, sessionId: sid, ok: true, result: { pong: true } }),
    });
    const reply = await replyP;
    assert.equal(reply.ok, true);
    assert.equal(cap.errors.length, 0, `发生未捕获异常：${cap.errors[0] && cap.errors[0].message}`);
  } finally {
    cap.done();
    await bridge.close();
  }
});

test('CLI 连接 RST：不产生 uncaughtException，服务继续可用', async (t) => {
  const { bridge, port, base } = await startBridge();
  const cap = captureUncaught();
  try {
    await hello(base);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await opened(ws);
    if (typeof ws._socket.resetAndDestroy !== 'function') return t.skip('Node 无 resetAndDestroy');
    ws._socket.resetAndDestroy();
    await sleep(300);
    const m = await sendOne(port, { action: '__status' });
    assert.equal(m.ok, true);
    assert.equal(cap.errors.length, 0, `发生未捕获异常：${cap.errors[0] && cap.errors[0].message}`);
  } finally {
    cap.done();
    await bridge.close();
  }
});

test('心跳：服务端周期 ping，健康客户端保持连接', async () => {
  const { bridge, port } = await startBridge();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await opened(ws);
    let pings = 0;
    ws.on('ping', () => pings++);
    await sleep(FAST.heartbeatMs * 2 + 100);
    assert.ok(pings >= 1, `两次心跳周期内未收到 ping（收到 ${pings} 次）`);
    assert.equal(ws.readyState, WebSocket.OPEN, '健康客户端不应被断开');
  } finally {
    ws.close();
    await bridge.close();
  }
});

test('poll 响应携带 relayBootId，中继重启（新实例）后变化', async () => {
  const a = await startBridge();
  const sidA = await hello(a.base);
  const p1 = await (await fetch(`${a.base}/poll?sessionId=${sidA}`)).json();
  assert.ok(p1.relayBootId, '空轮询响应缺少 relayBootId');
  await a.bridge.close();

  const b = await startBridge();
  const sidB = await hello(b.base);
  const p2 = await (await fetch(`${b.base}/poll?sessionId=${sidB}`)).json();
  assert.ok(p2.relayBootId, '空轮询响应缺少 relayBootId');
  assert.notEqual(p2.relayBootId, p1.relayBootId, '重启后 bootId 未变化');
  await b.bridge.close();
});

test('命令投递响应同样携带 relayBootId', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const sid = await hello(base);
    const p = hangPoll(base, sid);
    const replyP = sendOne(port, { action: 'ping' });
    const delivered = await p.done;
    assert.ok(delivered.body.relayBootId, '命令响应缺少 relayBootId');
    await fetch(`${base}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: delivered.body.command.id, sessionId: sid, ok: true, result: {} }),
    });
    await replyP;
  } finally {
    await bridge.close();
  }
});

test('close() 释放端口并清理定时器', async () => {
  const { bridge, port, base } = await startBridge();
  await bridge.close();
  await assert.rejects(fetch(`${base}/hello`), undefined, '端口未释放');
  assert.notEqual(port, undefined);
});

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

// ---------- 畸形 percent-encoding 防护（安全解码） ----------

test('畸形编码：/poll?sessionId=% 返回 400 且中继仍可用', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const r = await fetch(`${base}/poll?sessionId=%`);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /协议过旧/);
    // 进程未崩：正常握手 + 命令链路照常工作
    const sid = await hello(base);
    const m = await sendOne(port, { action: '__status' });
    assert.equal(m.ok, true);
    assert.deepEqual(m.result.sessions.map((s) => s.sessionId), [sid]);
  } finally {
    await bridge.close();
  }
});

test('畸形编码：/hello fileName 解码失败退化为 未知', async () => {
  const { bridge, port, base } = await startBridge();
  try {
    const r = await fetch(`${base}/hello?fileName=%&version=x&instanceId=i`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.sessionId, '畸形 fileName 不应影响握手');
    const m = await sendOne(port, { action: '__status' });
    assert.equal(m.ok, true);
    assert.equal(m.result.sessions[0].fileName, '未知');
  } finally {
    await bridge.close();
  }
});

// ---------- 多会话路由语义（v0.2.0 Task 2） ----------

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

test('无 target 且零在线：报错"插件未连接"', async () => {
  const { bridge, port } = await startBridge();
  try {
    const reply = await sendOne(port, { action: 'ping' }); // 从未 hello 过任何插件
    assert.equal(reply.ok, false);
    assert.match(reply.error, /插件未连接/);
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

// ---------- 会话生命周期与内存防护（v0.2.0 Task 4） ----------

test('会话驱逐：挂起的 poll 收到 sessionExpired 推送', async () => {
  // harness 时序注入：驱逐扫描周期为 sessionEvictMs/2，首达点约 750ms（严格大于判定），
  // 若沿用 FAST 的 pollHoldMs(400ms)，挂起 poll 会先空转返回、驱逐推送永远轮不到
  const { bridge, base } = await startBridge({ sessionEvictMs: 500, queueTtlMs: 10000, pollHoldMs: 1500 });
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
  // harness 时序注入：驱逐首达点约 750ms，FAST 的 commandTimeoutMs(600ms) 会先发"命令超时"，
  // 拉长 pollHoldMs/commandTimeoutMs 让驱逐成为先发生的一方
  const { bridge, port, base } = await startBridge({ sessionEvictMs: 500, queueTtlMs: 10000, pollHoldMs: 1500, commandTimeoutMs: 2000 });
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

test('会话数上限：新建超限返回 503，刷新已有会话不受限', async () => {
  const { bridge, base } = await startBridge({ sessionsMax: 2 });
  try {
    const sidA = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    await hello(base, { fileKey: 'fkB', fileName: '文件B', instanceId: 'iB' });
    const r3 = await fetch(`${base}/hello?fileKey=fkC&fileName=${encodeURIComponent('文件C')}&version=x&instanceId=iC`);
    assert.equal(r3.status, 503);
    const body3 = await r3.json();
    assert.equal(body3.ok, false);
    assert.match(body3.error, /会话数已达上限（2）/);
    // 刷新已有 sessionId（同 fileKey+instanceId 再 hello）不应受上限约束
    const sidA2 = await hello(base, { fileKey: 'fkA', fileName: '文件A', instanceId: 'iA' });
    assert.equal(sidA2, sidA);
  } finally {
    await bridge.close();
  }
});
