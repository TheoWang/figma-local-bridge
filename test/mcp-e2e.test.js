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
