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
          const out = respond ? await respond(body.command) : { ok: true, result: { ack: body.command.action } };
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

test('回复窗口：拨号重试消耗后，回复计时器仍拿满完整超时', async () => {
  const port = await getFreePort(); // 先占空闲端口但不监听 → 首轮拨号必败
  const conn = new BridgeConnection({ port, commandTimeoutMs: 1500, logger: () => {} });
  const base = `http://127.0.0.1:${port}`;
  const p = conn.request({ action: 'ping' }); // 第一轮拨号失败后进入约 1s 退避
  await sleep(100); // 确保首轮拨号已失败
  const bridge = createBridgeServer({ ...FAST, logger: () => {}, port }); // 退避窗口内在同端口起中继
  await bridge.listen('127.0.0.1');
  const sid = await hello(base);
  const p1 = autoPoller(base, sid, async () => { await sleep(800); return { ok: true, result: { ack: 'ping' } }; });
  try {
    // 拨号阶段耗掉约 1s：若回复计时器用剩余预算（约 500ms < 插件 800ms 延迟）会误报命令超时；
    // 修复后回复阶段重新拿满 1500ms → 正常等到应答
    const result = await p;
    assert.deepEqual(result, { ack: 'ping' });
  } finally { p1.stop(); conn.close(); await bridge.close(); }
});

test('close：拨号重试中调用 close，request 以「连接已关闭」拒绝且不留活动连接', async () => {
  const port = await getFreePort(); // 没有中继 → 拨号必败进入退避重试
  const conn = new BridgeConnection({ port, commandTimeoutMs: 5000, dialTimeoutMs: 100, backoffMaxMs: 200, logger: () => {} });
  const p = conn.request({ action: 'ping' }); // 不 await：让其停在拨号重试循环
  await sleep(120); // 等首轮拨号失败、进入退避
  conn.close();
  await assert.rejects(p, /连接已关闭/);
  assert.equal(conn.ws, null, '不留活动连接');
});
