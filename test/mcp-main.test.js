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
