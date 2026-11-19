// MCP 工具层测试：mock conn（记录命令、按 action 返回罐头结果），不碰真实中继
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TOOLS } = require('../src/mcp/tools');

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// mock 连接：记录命令；__status 返回会话表；其余返回 { ack: action }
function mockConn({ sessions = [], results = {} } = {}) {
  const commands = [];
  return {
    commands,
    async request(command) {
      commands.push(command);
      if (command.action === '__status') {
        return { serverVersion: '0.0.0-test', port: 9741, pluginAlive: sessions.length > 0, sessions };
      }
      if (command.action in results) {
        const r = results[command.action];
        if (r instanceof Error) throw r;
        return typeof r === 'function' ? r(command) : r;
      }
      return { ack: command.action };
    },
  };
}

const ctxOf = (conn, saveDir) => ({ conn, ...(saveDir ? { saveDir } : {}) });
const toolByName = (name) => TOOLS.find((t) => t.name === name);

test('tools/list：16 个工具，schema 与描述齐备', () => {
  assert.equal(TOOLS.length, 16);
  for (const t of TOOLS) {
    assert.ok(t.name, '缺 name');
    assert.ok(t.description, `${t.name} 缺 description`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema 根应为 object`);
    assert.equal(typeof t.handler, 'function');
  }
  const names = TOOLS.map((t) => t.name);
  for (const n of ['list_files', 'ping', 'list_pages', 'create_page', 'goto_page', 'get_structure', 'inspect_node',
    'render', 'update', 'remove', 'export_node', 'place_image', 'import_svg', 'set_image_fill', 'make_component', 'link']) {
    assert.ok(names.includes(n), `缺工具 ${n}`);
  }
});

test('render：tree 递归 schema 可描述嵌套子节点（children $ref 存在）', () => {
  const render = toolByName('render');
  assert.ok(render.inputSchema.$defs && render.inputSchema.$defs.node, '缺 $defs.node');
  const node = render.inputSchema.$defs.node;
  assert.deepEqual(node.properties.type.enum, ['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'INSTANCE']);
  assert.equal(node.properties.children.items.$ref, '#/$defs/node');
  assert.deepEqual(node.properties.layout.properties.mode.enum, ['VERTICAL', 'HORIZONTAL', 'NONE']);
  assert.equal(render.inputSchema.properties.tree.$ref, '#/$defs/node');
});

test('render：tree 原样透传，file 选择器解析为 target', async () => {
  const conn = mockConn({ sessions: [{ fileKey: 'fkA', fileName: '设计稿', alive: true }] });
  const tree = { type: 'FRAME', name: '卡片', children: [{ type: 'TEXT', text: { characters: 'hi' } }] };
  const content = await toolByName('render').handler(
    { tree, file: '设计稿' }, ctxOf(conn),
  );
  const cmd = conn.commands.find((c) => c.action === 'render');
  assert.deepEqual(cmd.params.tree, tree, 'tree 不应被改写');
  assert.deepEqual(cmd.target, { fileKey: 'fkA' });
  assert.equal(conn.commands[0].action, '__status', '先解析选择器');
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /"ack":\s*"render"/);
});

test('不传 file 且单文件语义：命令不带 target（交给中继自动路由）', async () => {
  const conn = mockConn();
  await toolByName('ping').handler({}, ctxOf(conn));
  const cmd = conn.commands.find((c) => c.action === 'ping');
  assert.equal(cmd.target, undefined);
  assert.equal(conn.commands.length, 1, '不触发 __status');
});

test('export_node PNG：image content + 落盘 + 路径文本', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-export-'));
  const conn = mockConn({ results: { exportNode: { base64: TINY_PNG, format: 'PNG', byteLength: 70 } } });
  const content = await toolByName('export_node').handler({ nodeId: '1:2' }, ctxOf(conn, saveDir));
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].mimeType, 'image/png');
  assert.equal(content[0].data, TINY_PNG);
  const cmd = conn.commands.find((c) => c.action === 'exportNode');
  assert.deepEqual(cmd.params, { nodeId: '1:2', format: 'PNG', scale: 2 });
  const saved = content[1].text.match(/已保存：(.+\.png)/);
  assert.ok(saved, '应报告落盘路径');
  assert.deepEqual([...fs.readFileSync(saved[1]).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('export_node SVG：文本 content（SVG 源码）+ 落盘 .svg', async () => {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-export-'));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const b64 = Buffer.from(svg).toString('base64');
  const conn = mockConn({ results: { exportNode: { base64: b64, format: 'SVG', byteLength: b64.length } } });
  const content = await toolByName('export_node').handler({ nodeId: '1:2' }, ctxOf(conn, saveDir));
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, svg);
  assert.match(content[1].text, /已保存：.+\.svg/);
});

test('update：nodeId 以外的参数全数进入 params（宽松透传）', async () => {
  const conn = mockConn();
  await toolByName('update').handler(
    { nodeId: '1:2', fills: ['#FF0000'], width: 100, file: undefined }, ctxOf(conn),
  );
  const cmd = conn.commands.find((c) => c.action === 'update');
  assert.deepEqual(cmd.params, { nodeId: '1:2', fills: ['#FF0000'], width: 100 });
});

test('place_image：读本地路径转 base64，path 不透传给中继', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-img-'));
  const img = path.join(dir, 'a.png');
  fs.writeFileSync(img, Buffer.from(TINY_PNG, 'base64'));
  const conn = mockConn();
  await toolByName('place_image').handler(
    { image_path: img, width: 40, height: 20, name: '头像' }, ctxOf(conn),
  );
  const cmd = conn.commands.find((c) => c.action === 'placeImage');
  assert.equal(cmd.params.width, 40);
  assert.equal(cmd.params.height, 20);
  assert.equal(cmd.params.name, '头像');
  assert.deepEqual([...Buffer.from(cmd.params.imageBase64, 'base64').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(cmd.params.image_path, undefined, '路径不应透传');
});

test('place_image：路径不可读报中文错误', async () => {
  await assert.rejects(
    toolByName('place_image').handler({ image_path: '/no/such/file.png' }, ctxOf(mockConn())),
    /无法读取图片文件：\/no\/such\/file\.png/,
  );
});

test('set_image_fill：nodeId + 本地路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flb-img-'));
  const img = path.join(dir, 'b.png');
  fs.writeFileSync(img, Buffer.from(TINY_PNG, 'base64'));
  const conn = mockConn();
  await toolByName('set_image_fill').handler({ nodeId: '9:9', image_path: img }, ctxOf(conn));
  const cmd = conn.commands.find((c) => c.action === 'setImageFill');
  assert.equal(cmd.params.nodeId, '9:9');
  assert.equal(cmd.params.scaleMode, undefined, '缺省 scaleMode 交给插件默认 FILL');
  assert.ok(cmd.params.imageBase64.length > 0);
});

test('import_svg：走栅格化产出 placeImage（sharp 缺失则整例 skip）', { skip: !hasSharp() }, async () => {
  const conn = mockConn();
  await toolByName('import_svg').handler(
    { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', width: 16, height: 16 }, ctxOf(conn),
  );
  const cmd = conn.commands.find((c) => c.action === 'placeImage');
  assert.equal(cmd.action, 'placeImage');
  assert.equal(cmd.params.width, 16);
});

test('list_files：__status 精简输出', async () => {
  const conn = mockConn({ sessions: [{ fileKey: 'fkA', fileName: '文件A', pluginVersion: '0.3.0', alive: true, queuedCommands: 0 }] });
  const content = await toolByName('list_files').handler({}, ctxOf(conn));
  const parsed = JSON.parse(content[0].text);
  assert.equal(parsed.pluginAlive, true);
  assert.deepEqual(parsed.sessions[0], { fileName: '文件A', fileKey: 'fkA', pluginVersion: '0.3.0', alive: true, queuedCommands: 0 });
});

test('handler 抛错直接冒泡（协议层负责包 isError）', async () => {
  const conn = mockConn({ sessions: [], results: { ping: new Error('插件不在线') } });
  await assert.rejects(toolByName('ping').handler({}, ctxOf(conn)), /插件不在线/);
});

function hasSharp() {
  try { require.resolve('sharp'); return true; } catch { return false; }
}
