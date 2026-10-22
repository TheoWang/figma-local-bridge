#!/usr/bin/env node
// Figma Local Bridge CLI
// 子命令：
//   server                        启动本地中继（前台运行）
//   send '<json>' | send @file    发送一条命令并打印结果
//   render <file.json>            渲染节点树文件（send @file 的别名）
//   export <nodeId> [scale]       导出节点为 PNG/SVG，落盘 ./exports/
//   list-files                    列出在线文件（fileKey/文件名/版本/排队数）
//   install-plugin [dir]          把插件文件拷到稳定目录（默认 ~/.figma-local-bridge/plugin）
//   doctor                        自检：中继连通性、插件在线状态、版本一致性
// 环境变量：FLB_PORT（默认 9741）

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.FLB_PORT || 9741);
const PKG_VERSION = require(path.join(__dirname, '..', 'package.json')).version;

function sendOne(command, { allowOffline = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('中继无响应（超时）')); }, 70000);
    ws.on('open', () => ws.send(JSON.stringify({ role: 'cli', command })));
    ws.on('message', (raw) => {
      clearTimeout(timer);
      ws.close();
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg.ok && !allowOffline) return reject(new Error(msg.error));
        resolve(msg);
      } catch (e) { reject(e); }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法连接中继（请先运行 figma-bridge server）：${e.message}`));
    });
  });
}

function readCommand(arg) {
  if (!arg) throw new Error('缺少命令参数（JSON 字符串或 @文件路径）');
  return JSON.parse(arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg);
}

async function rasterizeSvgCommand(command) {
  const p = (command && command.params) || {};
  if (!p.svg) throw new Error('importSvg 缺少 svg 参数');
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    throw new Error('importSvg 需要可选依赖 sharp（npm i sharp）');
  }
  const w = p.width || 24;
  const h = p.height || 24;
  const SCALE = 4;
  const svg = p.svg
    .replace(/width="[^"]*"/, `width="${w * SCALE}"`)
    .replace(/height="[^"]*"/, `height="${h * SCALE}"`);
  const png = await sharp(Buffer.from(svg), { density: 300 }).png().toBuffer();
  return {
    action: 'placeImage',
    params: {
      imageBase64: png.toString('base64'),
      width: w, height: h, name: p.name, parentNodeId: p.parentNodeId, x: p.x, y: p.y, scaleMode: 'FIT'
    }
  };
}

async function cmdSend(arg) {
  let command = readCommand(arg);
  if (command.action === 'importSvg') command = await rasterizeSvgCommand(command);
  const reply = await sendOne(command);
  // 导出命令：base64 落盘
  if (command.action === 'exportNode' && reply.result && reply.result.base64) {
    const ext = reply.result.format === 'SVG' ? 'svg' : 'png';
    const outDir = path.join(process.cwd(), 'exports');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${Date.now()}.${ext}`);
    fs.writeFileSync(outFile, Buffer.from(reply.result.base64, 'base64'));
    console.log(JSON.stringify({ ok: true, file: outFile, byteLength: reply.result.byteLength }, null, 2));
    return;
  }
  console.log(JSON.stringify(reply.result, null, 2));
}

async function cmdExport(nodeId, scale) {
  if (!nodeId) throw new Error('用法：figma-bridge export <nodeId> [scale]');
  await cmdSend(JSON.stringify({ action: 'exportNode', params: { nodeId, scale: Number(scale) || 2 } }));
}

function cmdInstallPlugin(dir) {
  // 不用隐藏目录：macOS 打开对话框默认不显示点目录，用户找 manifest 困难
  const target = dir || path.join(require('os').homedir(), 'figma-local-bridge-plugin');
  fs.mkdirSync(target, { recursive: true });
  const src = path.join(__dirname, '..', 'plugin');
  for (const f of ['manifest.json', 'code.js']) {
    fs.copyFileSync(path.join(src, f), path.join(target, f));
  }
  console.log(`插件已安装到：${target}`);
  console.log('请在 Figma 桌面客户端：Plugins → Development → Import plugin from manifest… 选择上面的 manifest.json');
  console.log('注意：包升级后需重新运行本命令并重启插件（doctor 可检查版本一致性）');
}

async function cmdListFiles() {
  const reply = await sendOne({ action: '__status' }, { allowOffline: true });
  const sessions = (reply.result && reply.result.sessions) || [];
  if (!sessions.length) {
    console.log('当前没有已注册的文件。请在 Figma 中运行「Figma Local Bridge」插件。');
    return;
  }
  console.log(`已注册文件（${sessions.length}）：`);
  for (const s of sessions) {
    const seen = s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleTimeString() : '未知';
    console.log(`  ${s.alive ? '●' : '○'} ${s.fileName}  fileKey=${s.fileKey}  插件 v${s.pluginVersion}  最后心跳 ${seen}  排队 ${s.queuedCommands}`);
  }
}

async function cmdDoctor() {
  console.log(`Figma Local Bridge v${PKG_VERSION} 自检`);
  try {
    const reply = await sendOne({ action: '__status' }, { allowOffline: true });
    const s = reply.result;
    console.log(`✅ 中继在线（v${s.serverVersion}，端口 ${s.port}）`);
    const alive = (s.sessions || []).filter((x) => x.alive);
    if (!alive.length) {
      console.log('❌ 插件不在线：请在 Figma 中运行「Figma Local Bridge」插件');
      return;
    }
    for (const x of alive) {
      console.log(`✅ 插件在线（文件：${x.fileName}，fileKey: ${x.fileKey}，插件 v${x.pluginVersion}）`);
      if (x.pluginVersion !== '未知' && x.pluginVersion !== s.serverVersion) {
        console.log(`⚠️ 版本不一致：插件 v${x.pluginVersion} ≠ 中继 v${s.serverVersion}，请重新 install-plugin 并重启插件`);
      }
      if (x.queuedCommands > 0) console.log(`⚠️ ${x.fileName} 队列中有 ${x.queuedCommands} 条待执行命令`);
    }
  } catch (e) {
    console.log(`❌ 中继离线：${e.message}`);
    process.exit(1);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'server':
      require(path.join(__dirname, '..', 'src', 'server.js')).start();
      break;
    case 'send':
      await cmdSend(args[0]);
      break;
    case 'render':
      if (!args[0]) throw new Error('用法：figma-bridge render <file.json>');
      await cmdSend('@' + args[0]);
      break;
    case 'export':
      await cmdExport(args[0], args[1]);
      break;
    case 'list-files':
      await cmdListFiles();
      break;
    case 'install-plugin':
      cmdInstallPlugin(args[0]);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    default:
      console.log('用法：figma-bridge <server|send|render|export|list-files|install-plugin|doctor>');
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
