// Figma Local Bridge 本地中继服务：CLI 走 WebSocket，Figma 插件走 HTTP 长轮询（插件沙箱没有 WebSocket，但有 fetch）。
// 同一端口 9741：WS 升级请求给 CLI，HTTP /poll /result /hello 给插件。
// 用法：figma-bridge server（或 node src/server.js）

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const SERVER_VERSION = require(path.join(__dirname, '..', 'package.json')).version;
const PORT = Number(process.env.FLB_PORT || process.env.OPC_BRIDGE_PORT || 9741);
const COMMAND_TIMEOUT_MS = 60 * 1000;
const POLL_HOLD_MS = 25 * 1000;

const queue = [];           // 待执行命令 [{ id, command, cliSocket, timer }]
let waitingPoll = null;     // 插件挂起的长轮询响应 { res, timer }
let pluginSeenAt = 0;       // 插件最近一次活跃时间
let pluginVersion = null;   // 插件握手上报的版本
let pluginFileName = null;  // 插件所在文件名
let nextId = 1;

// ---------- HTTP（插件侧） ----------

const server = http.createServer((req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/hello')) {
    pluginSeenAt = Date.now();
    pluginFileName = decodeURIComponent((req.url.match(/[?&]fileName=([^&]*)/) || [])[1] || '未知');
    pluginVersion = (req.url.match(/[?&]version=([^&]*)/) || [])[1] || '未知';
    const mismatch = pluginVersion !== '未知' && pluginVersion !== SERVER_VERSION;
    console.log(`[中继] Figma 插件已上线（文件：${pluginFileName}，插件 v${pluginVersion}）${mismatch ? ` ⚠️ 与中继 v${SERVER_VERSION} 版本不一致，请重新导入插件` : ''}`);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && req.url === '/poll') {
    pluginSeenAt = Date.now();
    const item = queue.shift();
    if (item) return deliverToPlugin(res, item);
    // 没有命令：挂起等待，最多 POLL_HOLD_MS
    const timer = setTimeout(() => {
      waitingPoll = null;
      sendJson(res, 200, { command: null });
    }, POLL_HOLD_MS);
    waitingPoll = { res, timer };
    req.on('close', () => {
      if (waitingPoll && waitingPoll.res === res) {
        clearTimeout(timer);
        waitingPoll = null;
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      pluginSeenAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { ok: false });
      }
      const item = inflight.get(msg.id);
      if (item) {
        inflight.delete(msg.id);
        clearTimeout(item.timer);
        safeSend(item.cliSocket, { id: msg.id, ok: msg.ok, result: msg.result, error: msg.error });
      }
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

const inflight = new Map(); // id -> { cliSocket, timer }（已发给插件、等结果的命令）

function deliverToPlugin(res, item) {
  inflight.set(item.id, item);
  item.timer = setTimeout(() => {
    inflight.delete(item.id);
    safeSend(item.cliSocket, { id: item.id, ok: false, error: `命令超时（${COMMAND_TIMEOUT_MS / 1000}s）` });
  }, COMMAND_TIMEOUT_MS);
  sendJson(res, 200, { command: { id: item.id, ...item.command } });
}

function flushQueueToPoll() {
  if (waitingPoll && queue.length) {
    const { res, timer } = waitingPoll;
    waitingPoll = null;
    clearTimeout(timer);
    deliverToPlugin(res, queue.shift());
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome 私有网络访问（https 页面访问 localhost）需要这个响应头
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- WebSocket（CLI 侧） ----------

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.role === 'cli' && msg.command) {
      const id = nextId++;
      // __status 由中继直接应答，不转发插件（doctor 用）
      if (msg.command.action === '__status') {
        safeSend(socket, {
          id,
          ok: true,
          result: {
            serverVersion: SERVER_VERSION,
            port: PORT,
            pluginAlive: Date.now() - pluginSeenAt < POLL_HOLD_MS + 10000,
            pluginVersion,
            pluginFileName,
            pluginLastSeenAt: pluginSeenAt ? new Date(pluginSeenAt).toISOString() : null,
            queuedCommands: queue.length
          }
        });
        return;
      }
      const pluginAlive = Date.now() - pluginSeenAt < (POLL_HOLD_MS + 10000);
      if (!pluginAlive) {
        safeSend(socket, { id, ok: false, error: 'Figma 插件未连接：请先在 Figma 中运行「Figma Local Bridge」插件并保持打开' });
        return;
      }
      queue.push({ id, command: msg.command, cliSocket: socket });
      flushQueueToPoll();
      return;
    }
  });
});

function safeSend(socket, obj) {
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj));
  } catch {
    // 忽略已断开的连接
  }
}

server.listen(PORT, () => {
  console.log(`[中继] Figma Local Bridge v${SERVER_VERSION} 已启动：http://localhost:${PORT}（插件轮询）+ ws://localhost:${PORT}（CLI）`);
  console.log('[中继] 等待 Figma 插件上线（在 Figma 中运行「Figma Local Bridge」插件）…');
});

process.on('SIGINT', () => {
  console.log('\n[中继] 已停止');
  process.exit(0);
});
