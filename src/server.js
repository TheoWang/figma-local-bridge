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
const SESSION_EVICT_MS = 90 * 1000;    // Task 4 接线，本任务先定义
const SESSION_QUEUE_MAX = 50;          // Task 4 接线

// 查询串解析：插件侧只用原生 fetch 拼简单查询串，不值得为它引入 URL/URLSearchParams 依赖
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

function createBridgeServer(options = {}) {
  const defaultPort = options.port ?? 0; // 缺省 ephemeral 端口，生产入口 start() 传入 PORT
  const pollHoldMs = options.pollHoldMs ?? POLL_HOLD_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const queueTtlMs = options.queueTtlMs ?? QUEUE_TTL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const log = typeof options.logger === 'function' ? options.logger : console.log.bind(console);

  // 实例标识：插件据此识别"对面的中继换实例了"（重启/升级），即使没观察到断线也重新握手
  const bootId = crypto.randomUUID();

  const sessions = new Map();   // sessionId -> session（形状见 Interfaces）
  const inflight = new Map();   // id -> { id, command, cliSocket, enqueuedAt, sessionId, timer }
  let nextId = 1;
  let heartbeatTimer = null;

  const currentPort = () => {
    const addr = server.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  };

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

  // 队列 TTL：插件失联前入队的命令不能永久滞留（连同 cliSocket 引用）；按会话各自的队列扫描
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

  // ---------- HTTP（插件侧） ----------

  const server = http.createServer((req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

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
