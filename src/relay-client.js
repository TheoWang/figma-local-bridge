// CLI 与 MCP server 共享的中继客户端工具：file 选择器解析、SVG 栅格化。
// v0.3.0 从 bin/cli.js 抽出，行为不变——两条入口共用同一套语义。
// fetchStatus 由调用方注入：CLI 走一次性 sendOne，MCP 走长驻连接。

// 从 __status 结果解析选择器为唯一 fileKey：先精确匹配 fileKey（多个活会话取最近活跃），
// 再大小写不敏感匹配文件名唯一子串；歧义与无匹配都抛错并列出候选。
async function resolveFileKey(fetchStatus, selector) {
  const status = await fetchStatus();
  const sessions = ((status && status.sessions) || []).filter((s) => s.alive);
  const exact = sessions.filter((s) => s.fileKey === selector);
  if (exact.length >= 1) {
    exact.sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
    return exact[0].fileKey;
  }
  const lower = String(selector).toLowerCase();
  const fuzzy = sessions.filter((s) => (s.fileName || '').toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0].fileKey;
  if (!fuzzy.length) throw new Error(`没有匹配的在线文件：${selector}（用 figma-bridge list-files 查看）`);
  throw new Error(`「${selector}」匹配到多个文件：${fuzzy.map((s) => `${s.fileName}（${s.fileKey}）`).join('、')}，请改用 fileKey`);
}

// SVG → placeImage 命令：sharp 栅格化为 4x 透明 PNG（插件沙箱无 SVG 导入 API）。
// sharp 是可选依赖，缺失时报可安装提示。
async function rasterizeSvgToPlaceImage({ svg, width, height, name, parentNodeId, x, y } = {}) {
  if (!svg) throw new Error('importSvg 缺少 svg 参数');
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    throw new Error('importSvg 需要可选依赖 sharp（npm i sharp）');
  }
  const w = width || 24;
  const h = height || 24;
  const SCALE = 4;
  const scaled = svg
    .replace(/width="[^"]*"/, `width="${w * SCALE}"`)
    .replace(/height="[^"]*"/, `height="${h * SCALE}"`);
  const png = await sharp(Buffer.from(scaled), { density: 300 }).png().toBuffer();
  return {
    action: 'placeImage',
    params: {
      imageBase64: png.toString('base64'),
      width: w, height: h, name, parentNodeId, x, y, scaleMode: 'FIT',
    },
  };
}

module.exports = { resolveFileKey, rasterizeSvgToPlaceImage };
