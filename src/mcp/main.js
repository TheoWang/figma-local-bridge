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
