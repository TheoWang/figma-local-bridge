// MCP 工具定义表：16 个 tools ↔ 中继 action 的翻译层。
// handler(args, ctx) 收 AI 参数与 { conn, saveDir? }，返回 MCP content 数组；
// 抛错由协议层（main.js createRpcHandler）包成 isError: true 的文本响应。
// file 选择器语义与 CLI --file 一致（src/relay-client.js resolveFileKey）。
const fs = require('fs');
const path = require('path');
const { resolveFileKey, rasterizeSvgToPlaceImage } = require('../relay-client');

const FILE_PARAM = {
  type: 'string',
  description: '目标文件：fileKey 或文件名唯一子串（大小写不敏感）。多文件在线时建议携带（先用 list_files 查看）；不传且恰好一个文件在线时自动路由。',
};

// 解析 file 选择器 → 注入 target；返回完整命令
async function withTarget(ctx, file, action, params) {
  const command = { action, params };
  if (file) {
    command.target = { fileKey: await resolveFileKey(() => ctx.conn.request({ action: '__status' }), file) };
  }
  return command;
}

// 通用形态：发命令，result 作为 JSON 文本返回
async function sendAction(ctx, file, action, params) {
  const result = await ctx.conn.request(await withTarget(ctx, file, action, params));
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}

function readImageBase64(p) {
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    throw new Error(`无法读取图片文件：${p}（${e.message}）`);
  }
  return buf.toString('base64');
}

// render 节点树的递归 schema：type/name/尺寸/坐标/填充/圆角/描边/自动布局/文本/组件实例/children
const NODE_SCHEMA = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { enum: ['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'INSTANCE'] },
    name: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    x: { type: 'number', description: '父级非自动布局时生效；不传自动向右排开' },
    y: { type: 'number' },
    fills: { type: 'array', items: { type: 'string' }, description: '#RRGGBB 或 #RRGGBBAA' },
    cornerRadius: { type: 'number' },
    topLeftRadius: { type: 'number', description: '逐角圆角（topRight/bottomLeft/bottomRight 同名）' },
    topRightRadius: { type: 'number' },
    bottomLeftRadius: { type: 'number' },
    bottomRightRadius: { type: 'number' },
    stroke: { type: 'object', properties: { color: { type: 'string' }, weight: { type: 'number' } } },
    layout: {
      type: 'object',
      description: '自动布局（仅 FRAME）',
      properties: {
        mode: { enum: ['VERTICAL', 'HORIZONTAL', 'NONE'] },
        gap: { type: 'number' },
        padding: { type: 'array', items: { type: 'number' }, description: '[上,右,下,左]' },
        primaryAlign: { enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] },
        counterAlign: { enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] },
        primarySizing: { enum: ['AUTO', 'FIXED'] },
        counterSizing: { enum: ['AUTO', 'FIXED'], description: '含文本的容器建议 AUTO，否则文字裁切' },
      },
    },
    text: {
      anyOf: [
        { type: 'string', description: 'INSTANCE：覆盖组件实例的文字' },
        {
          type: 'object',
          description: 'TEXT：文字内容与样式',
          required: ['characters'],
          properties: {
            characters: { type: 'string' },
            fontSize: { type: 'number' },
            fontWeight: { type: 'number', description: '100-900' },
            fontFamily: { type: 'string' },
            color: { type: 'string' },
            align: { enum: ['LEFT', 'CENTER', 'RIGHT'] },
            lineHeightPercent: { type: 'number' },
            width: { type: 'number', description: '长文本必须给 width（定宽换行），否则被裁切' },
          },
        },
      ],
    },
    component: { type: 'string', description: 'INSTANCE 必填：本文件中的主组件名，如 "按钮/主要/中"' },
    textColor: { type: 'string', description: 'INSTANCE：覆盖文字颜色 #RRGGBB' },
    children: { type: 'array', items: { $ref: '#/$defs/node' } },
  },
};

const TOOLS = [
  {
    name: 'list_files',
    description: '列出当前在线的 Figma 文件（文件名/fileKey/插件版本/排队数）。多文件操作前先调用它确定 file 参数。',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const s = await ctx.conn.request({ action: '__status' });
      const sessions = (s.sessions || []).map((x) => ({
        fileName: x.fileName, fileKey: x.fileKey, pluginVersion: x.pluginVersion,
        alive: x.alive, queuedCommands: x.queuedCommands,
      }));
      return [{ type: 'text', text: JSON.stringify({ serverVersion: s.serverVersion, port: s.port, pluginAlive: s.pluginAlive, sessions }, null, 2) }];
    },
  },
  {
    name: 'ping',
    description: '端到端连通性验证：返回目标文件名、当前页名与页 id。',
    inputSchema: { type: 'object', properties: { file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'ping', {}),
  },
  {
    name: 'list_pages',
    description: '列出文件的所有页面（id/名称）。',
    inputSchema: { type: 'object', properties: { file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'listPages', {}),
  },
  {
    name: 'create_page',
    description: '新建页面。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '页面名，缺省"未命名页面"' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'createPage', { name: args.name }),
  },
  {
    name: 'goto_page',
    description: '切换当前页面（pageId 或 pageName 二选一）。get_structure/渲染坐标都作用于当前页。',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, pageName: { type: 'string' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'gotoPage', { pageId: args.pageId, pageName: args.pageName }),
  },
  {
    name: 'get_structure',
    description: '读取当前页面的节点树（id/name/type/尺寸/坐标）。depth 越大越深，默认 2。',
    inputSchema: { type: 'object', properties: { depth: { type: 'number', description: '层级深度，默认 2' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'getStructure', { depth: args.depth }),
  },
  {
    name: 'inspect_node',
    description: '读取单个节点的完整样式细节（填充/描边/阴影/圆角/文本/自动布局），design-to-code 的核心读取工具。depth 默认 3。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, depth: { type: 'number' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'inspectNode', { nodeId: args.nodeId, depth: args.depth }),
  },
  {
    name: 'render',
    description: '在当前页渲染一棵声明式节点树（FRAME/RECTANGLE/ELLIPSE/TEXT/INSTANCE，支持自动布局与组件实例）。返回根节点 id。',
    inputSchema: {
      type: 'object',
      $defs: { node: NODE_SCHEMA },
      required: ['tree'],
      properties: {
        tree: { $ref: '#/$defs/node', description: '节点树根' },
        parentNodeId: { type: 'string', description: '挂载到的父节点；不传挂到当前页' },
        x: { type: 'number' },
        y: { type: 'number' },
        file: FILE_PARAM,
      },
    },
    handler: (args, ctx) => sendAction(ctx, args.file, 'render', { tree: args.tree, parentNodeId: args.parentNodeId, x: args.x, y: args.y }),
  },
  {
    name: 'update',
    description: '修改已有节点属性。常用键：name/x/y/width/height/fills/cornerRadius（或逐角 topLeftRadius 等）/visible/stroke/layout/text。未知属性被插件忽略。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, file: FILE_PARAM }, additionalProperties: true },
    handler: (args, ctx) => {
      const { file, ...props } = args;
      return sendAction(ctx, file, 'update', props);
    },
  },
  {
    name: 'remove',
    description: '删除节点。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'remove', { nodeId: args.nodeId }),
  },
  {
    name: 'export_node',
    description: '导出节点为 PNG（默认，图片直接内联返回）或 SVG（文本返回），同时落盘 exports/ 目录。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, format: { enum: ['PNG', 'SVG'], description: '默认 PNG' }, scale: { type: 'number', description: 'PNG 缩放倍数，默认 2' }, file: FILE_PARAM } },
    handler: async (args, ctx) => {
      const result = await ctx.conn.request(await withTarget(ctx, args.file, 'exportNode', {
        nodeId: args.nodeId, format: args.format || 'PNG', scale: args.scale || 2,
      }));
      const content = [];
      if (result.format === 'SVG') {
        content.push({ type: 'text', text: Buffer.from(result.base64, 'base64').toString('utf8') });
      } else {
        content.push({ type: 'image', data: result.base64, mimeType: 'image/png' });
      }
      let saved = '';
      try {
        const outDir = ctx.saveDir || path.join(process.cwd(), 'exports');
        fs.mkdirSync(outDir, { recursive: true });
        saved = path.join(outDir, `${Date.now()}.${result.format === 'SVG' ? 'svg' : 'png'}`);
        fs.writeFileSync(saved, Buffer.from(result.base64, 'base64'));
      } catch {
        saved = '';
      }
      content.push({
        type: 'text',
        text: saved ? `已保存：${saved}（${result.byteLength} 字节）` : `未落盘（目录不可写？），已直接返回内容（${result.byteLength} 字节）`,
      });
      return content;
    },
  },
  {
    name: 'place_image',
    description: '把本地图片文件放置到画布（矩形节点 + 图片填充）。',
    inputSchema: {
      type: 'object', required: ['image_path'],
      properties: {
        image_path: { type: 'string', description: '本地图片文件路径' },
        width: { type: 'number', description: '默认 24' },
        height: { type: 'number', description: '默认 24' },
        name: { type: 'string' },
        parentNodeId: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' },
        scaleMode: { enum: ['FIT', 'FILL', 'CROP', 'TILE'], description: '默认 FIT' },
        file: FILE_PARAM,
      },
    },
    handler: async (args, ctx) => sendAction(ctx, args.file, 'placeImage', {
      imageBase64: readImageBase64(args.image_path),
      width: args.width, height: args.height, name: args.name,
      parentNodeId: args.parentNodeId, x: args.x, y: args.y, scaleMode: args.scaleMode,
    }),
  },
  {
    name: 'import_svg',
    description: '导入 SVG 字符串：本地栅格化为透明 PNG 后走 placeImage（插件沙箱无 SVG 导入 API）。需要可选依赖 sharp。',
    inputSchema: {
      type: 'object', required: ['svg'],
      properties: {
        svg: { type: 'string' },
        width: { type: 'number', description: '默认 24' },
        height: { type: 'number', description: '默认 24' },
        name: { type: 'string' },
        parentNodeId: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' },
        file: FILE_PARAM,
      },
    },
    handler: async (args, ctx) => {
      const command = await rasterizeSvgToPlaceImage({
        svg: args.svg, width: args.width, height: args.height,
        name: args.name, parentNodeId: args.parentNodeId, x: args.x, y: args.y,
      });
      const result = await ctx.conn.request(await withTarget(ctx, args.file, command.action, command.params));
      return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    },
  },
  {
    name: 'set_image_fill',
    description: '把本地图片设为已有节点的填充（默认 FILL 模式）。',
    inputSchema: {
      type: 'object', required: ['nodeId', 'image_path'],
      properties: {
        nodeId: { type: 'string' },
        image_path: { type: 'string', description: '本地图片文件路径' },
        scaleMode: { enum: ['FILL', 'FIT', 'CROP', 'TILE'], description: '默认 FILL' },
        file: FILE_PARAM,
      },
    },
    handler: async (args, ctx) => sendAction(ctx, args.file, 'setImageFill', {
      nodeId: args.nodeId, imageBase64: readImageBase64(args.image_path), scaleMode: args.scaleMode,
    }),
  },
  {
    name: 'make_component',
    description: '把节点转为主组件（TEXT 节点不可转）。',
    inputSchema: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'makeComponent', { nodeId: args.nodeId }),
  },
  {
    name: 'link',
    description: '创建原型连线：点击 from 节点跳转到 to 节点。',
    inputSchema: { type: 'object', required: ['fromNodeId', 'toNodeId'], properties: { fromNodeId: { type: 'string' }, toNodeId: { type: 'string' }, file: FILE_PARAM } },
    handler: (args, ctx) => sendAction(ctx, args.file, 'link', { fromNodeId: args.fromNodeId, toNodeId: args.toNodeId }),
  },
];

module.exports = { TOOLS };
