// Figma Local Bridge 本地中继服务：CLI 走 WebSocket，Figma 插件走 HTTP 长轮询（插件沙箱没有 WebSocket，但有 fetch）。
// 同一端口 9741：WS 升级请求给 CLI，HTTP /poll /result /hello 给插件。
// 用法：figma-bridge server（或 node src/server.js）
// 测试用 createBridgeServer(options) 工厂创建实例（可注入端口与各定时器时长）。

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const SERVER_VERSION = require(path.join(__dirname, '..', 'package.json')).version;
const PORT = Number(process.env.FLB_PORT || process.env.OPC_BRIDGE_PORT || 9741);
const COMMAND_TIMEOUT_MS = 60 * 1000;  // 已下发命令等插件结果的上限
const POLL_HOLD_MS = 25 * 1000;        // 长轮询挂起上限，空转后插件立刻重新挂起
const QUEUE_TTL_MS = 60 * 1000;        // 队列条目未被插件取走的存活期（与 CLI 侧 70s 超时对齐）
const QUEUE_SWEEP_MS = 15 * 1000;      // 队列 TTL 扫描周期
const HEARTBEAT_MS = 30 * 1000;        // WS 心跳周期；两轮无 pong 判定半开连接并断开

function createBridgeServer(options = {}) {
  const defaultPort = options.port ?? 0; // 缺省 ephemeral 端口，生产入口 start() 传入 PORT
  const pollHoldMs = options.pollHoldMs ?? POLL_HOLD_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const queueTtlMs = options.queueTtlMs ?? QUEUE_TTL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const log = typeof options.logger === 'function' ? options.logger : console.log.bind(console);

  // 实例标识：插件据此识别"对面的中继换实例了"（重启/升级），即使没观察到断线也重新握手
  const bootId = crypto.randomUUID();

  const queue = [];                // 待执行命令 [{ id, command, cliSocket, enqueuedAt }]
  const waitingPolls = new Set();  // 挂起中的插件长轮询 { res, timer }，按挂起先后投递
  const inflight = new Map();      // id -> { cliSocket, timer }（已发给插件、等结果的命令）
  const state = { pluginSeenAt: 0, pluginVersion: null, pluginFileName: null };
  let nextId = 1;
  let heartbeatTimer = null;

  const pluginAlive = () => Date.now() - state.pluginSeenAt < pollHoldMs + 10000;

  const currentPort = () => {
    const addr = server.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  };

  // 队列 TTL：插件失联前入队的命令不能永久滞留（连同 cliSocket 引用）
  const queueSweeper = queueTtlMs > 0
    ? setInterval(() => {
        const deadline = Date.now() - queueTtlMs;
        while (queue.length && queue[0].enqueuedAt <= deadline) {
          const item = queue.shift();
          safeSend(item.cliSocket, { id: item.id, ok: false, error: `命令超时（${queueTtlMs / 1000}s 未被插件取走）` });
        }
      }, Math.min(QUEUE_SWEEP_MS, queueTtlMs / 2))
    : null;

  // ---------- HTTP（插件侧） ----------

  const server = http.createServer((req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/hello')) {
      state.pluginSeenAt = Date.now();
      state.pluginFileName = decodeURIComponent((req.url.match(/[?&]fileName=([^&]*)/) || [])[1] || '未知');
      state.pluginVersion = (req.url.match(/[?&]version=([^&]*)/) || [])[1] || '未知';
      const mismatch = state.pluginVersion !== '未知' && state.pluginVersion !== SERVER_VERSION;
      log(`[中继] Figma 插件已上线（文件：${state.pluginFileName}，插件 v${state.pluginVersion}）${mismatch ? ` ⚠️ 与中继 v${SERVER_VERSION} 版本不一致，请重新导入插件` : ''}`);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && req.url === '/poll') {
      state.pluginSeenAt = Date.now();
      const item = queue.shift();
      if (item) return deliverToPlugin(res, item);
      // 没有命令：挂起等待，最多 pollHoldMs；各 poll 独立登记，互不覆盖
      const entry = { res };
      entry.timer = setTimeout(() => {
        waitingPolls.delete(entry);
        sendJson(res, 200, { command: null, relayBootId: bootId });
      }, pollHoldMs);
      waitingPolls.add(entry);
      req.on('close', () => {
        clearTimeout(entry.timer);
        waitingPolls.delete(entry);
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/result') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.pluginSeenAt = Date.now();
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

  function deliverToPlugin(res, item) {
    inflight.set(item.id, item);
    item.timer = setTimeout(() => {
      inflight.delete(item.id);
      safeSend(item.cliSocket, { id: item.id, ok: false, error: `命令超时（${commandTimeoutMs / 1000}s）` });
    }, commandTimeoutMs);
    sendJson(res, 200, { command: { id: item.id, ...item.command }, relayBootId: bootId });
  }

  function flushQueueToPoll() {
    if (!queue.length) return;
    for (const entry of waitingPolls) {
      waitingPolls.delete(entry);
      clearTimeout(entry.timer);
      deliverToPlugin(entry.res, queue.shift());
      return;
    }
  }

  function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Chrome 私有网络访问（https 页面访问 localhost）需要这个响应头
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  // 目标连接可能已被插件/中间层断开：写之前检查、写入失败也不冒泡成 uncaughtException
  function sendJson(res, code, obj) {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    } catch {
      // 连接已中断，响应作废
    }
  }

  // ---------- WebSocket（CLI 侧） ----------

  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket) => {
    // 不挂 error 监听时，ECONNRESET 会作为 uncaughtException 打崩整个进程
    socket.on('error', () => {}); // 断连细节在 close 里统一处理
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

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
              port: currentPort(),
              pluginAlive: pluginAlive(),
              pluginVersion: state.pluginVersion,
              pluginFileName: state.pluginFileName,
              pluginLastSeenAt: state.pluginSeenAt ? new Date(state.pluginSeenAt).toISOString() : null,
              queuedCommands: queue.length
            }
          });
          return;
        }
        if (!pluginAlive()) {
          safeSend(socket, { id, ok: false, error: 'Figma 插件未连接：请先在 Figma 中运行「Figma Local Bridge」插件并保持打开' });
          return;
        }
        queue.push({ id, command: msg.command, cliSocket: socket, enqueuedAt: Date.now() });
        flushQueueToPoll();
        return;
      }
    });
  });

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      for (const socket of wss.clients) {
        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }, heartbeatMs);
  }

  return {
    async listen(host) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(defaultPort, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    async close() {
      if (queueSweeper) clearInterval(queueSweeper);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const entry of waitingPolls) clearTimeout(entry.timer);
      waitingPolls.clear();
      for (const item of inflight.values()) clearTimeout(item.timer);
      inflight.clear();
      queue.length = 0;
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
    get port() {
      return currentPort();
    },
  };
}

// 生产入口：默认端口前台运行
function start() {
  const bridge = createBridgeServer({ port: PORT });
  bridge.listen().then(() => {
    console.log(`[中继] Figma Local Bridge v${SERVER_VERSION} 已启动：http://localhost:${bridge.port}（插件轮询）+ ws://localhost:${bridge.port}（CLI）`);
    console.log('[中继] 等待 Figma 插件上线（在 Figma 中运行「Figma Local Bridge」插件）…');
  });
  process.on('SIGINT', () => {
    console.log('\n[中继] 已停止');
    process.exit(0);
  });
}

function safeSend(socket, obj) {
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj));
  } catch {
    // 忽略已断开的连接
  }
}

if (require.main === module) start();

module.exports = { createBridgeServer, start };
