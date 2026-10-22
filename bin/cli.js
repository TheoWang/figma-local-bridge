#!/usr/bin/env node
// Figma Local Bridge CLI
// 子命令：
//   server                        启动本地中继（前台运行）
//   send '<json>' | send @file    发送一条命令并打印结果
//   render <file.json>            渲染节点树文件（send @file 的别名）
//   export <nodeId> [scale]       导出节点为 PNG/SVG，落盘 ./exports/
//   send/render/export 均支持 --file <选择器>：fileKey 精确值或文件名唯一子串（大小写不敏感）
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

// 从参数里摘除 --file <选择器>，返回剩余参数与选择器（选择器为 fileKey 或文件名唯一子串）
function takeFileArg(args) {
  const i = args.indexOf('--file');
  if (i < 0) return { args, selector: null };
  const selector = args[i + 1];
  if (!selector) throw new Error('--file 缺少选择器参数');
  const rest = args.slice();
  rest.splice(i, 2);
  return { args: rest, selector };
}

// 解析选择器为唯一 fileKey：先精确匹配 fileKey，再大小写不敏感匹配文件名唯一子串。
// 模糊匹配只在 CLI 层做——解析出 fileKey 后注入 target，中继协议只认 fileKey
async function resolveFileKey(selector) {
  const reply = await sendOne({ action: '__status' }, { allowOffline: true });
  const sessions = ((reply.result && reply.result.sessions) || []).filter((s) => s.alive);
  const exact = sessions.filter((s) => s.fileKey === selector);
  if (exact.length === 1) return exact[0].fileKey;
  const lower = String(selector).toLowerCase();
  const fuzzy = sessions.filter((s) => (s.fileName || '').toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0].fileKey;
  if (!fuzzy.length) throw new Error(`没有匹配的在线文件：${selector}（用 figma-bridge list-files 查看）`);
  throw new Error(`「${selector}」匹配到多个文件：${fuzzy.map((s) => `${s.fileName}（${s.fileKey}）`).join('、')}，请改用 fileKey`);
}

async function cmdSend(arg, selector) {
  let command = readCommand(arg);
  if (command.action === 'importSvg') command = await rasterizeSvgCommand(command);
  // --file 注入直接覆盖 command.target（用户在 JSON 里手写 target 时以 --file 为准）
  if (selector) {
    command.target = { fileKey: await resolveFileKey(selector) };
  }
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

async function cmdExport(nodeId, scale, selector) {
  if (!nodeId) throw new Error('用法：figma-bridge export [--file <选择器>] <nodeId> [scale]');
  await cmdSend(JSON.stringify({ action: 'exportNode', params: { nodeId, scale: Number(scale) || 2 } }), selector);
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
    case 'send': {
      const { args: rest, selector } = takeFileArg(args);
      await cmdSend(rest[0], selector);
      break;
    }
    case 'render': {
      const { args: rest, selector } = takeFileArg(args);
      if (!rest[0]) throw new Error('用法：figma-bridge render [--file <选择器>] <file.json>');
      await cmdSend('@' + rest[0], selector);
      break;
    }
    case 'export': {
      const { args: rest, selector } = takeFileArg(args);
      await cmdExport(rest[0], rest[1], selector);
      break;
    }
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
