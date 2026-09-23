// 供使用方脚本编程式调用：const { sendOne } = require('figma-local-bridge');
const WebSocket = require('ws');

const PORT = Number(process.env.FLB_PORT || 9741);

function sendOne(command) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('中继无响应（超时）')); }, 70000);
    ws.on('open', () => ws.send(JSON.stringify({ role: 'cli', command })));
    ws.on('message', (raw) => {
      clearTimeout(timer);
      ws.close();
      try {
        const msg = JSON.parse(raw.toString());
        msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
      } catch (e) { reject(e); }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法连接中继（请先运行 figma-bridge server）：${e.message}`));
    });
  });
}

module.exports = { sendOne };
