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
