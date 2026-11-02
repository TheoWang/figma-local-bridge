// 插件侧测试：node --test test/
// plugin/code.js 是 Figma 插件沙箱脚本（无 module.exports），这里用 vm 加载源码，
// 注入 mock 的 figma/fetch/setTimeout：
//   - fetch 返回永不 resolve 的 Promise → pollLoop 挂起在第一次 await，不产生事件循环句柄
//   - setTimeout 为 no-op → sleep 永不触发，测试进程可正常退出
// figma.mixed 用真实 Symbol 模拟，验证 per-corner 半径桥接（含 mixed 泄漏防护）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE_SRC = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'code.js'), 'utf8');

function loadPlugin(figmaMock) {
  const sandbox = {
    figma: figmaMock,
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: { log: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE_SRC, sandbox, { filename: 'plugin/code.js' });
  return sandbox;
}

function makeFigma() {
  return { root: { name: '测试文件' }, mixed: Symbol('figma.mixed') };
}

// CornerMixin 形状的最小节点（RECTANGLE 支持全部圆角属性）
function makeCornerNode(figmaMock, corners) {
  return {
    id: '1:2',
    name: '卡片',
    type: 'RECTANGLE',
    width: 100,
    height: 80,
    absoluteBoundingBox: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    fills: [],
    strokes: [],
    effects: [],
    cornerRadius: corners.uniform,
    topLeftRadius: corners.tl,
    topRightRadius: corners.tr,
    bottomLeftRadius: corners.bl,
    bottomRightRadius: corners.br,
    resize: () => {},
  };
}

test('inspectNode：四角不一致时逐角读出，且不再输出 figma.mixed（Symbol）', () => {
  const figmaMock = makeFigma();
  const node = makeCornerNode(figmaMock, { uniform: figmaMock.mixed, tl: 16, tr: 16, bl: 0, br: 0 });
  const sandbox = loadPlugin(figmaMock);
  const info = sandbox.inspectNode(node, 0);
  assert.ok(!('cornerRadius' in info), 'mixed 时不应输出 cornerRadius（Symbol 会被 JSON 丢弃）');
  assert.equal(info.topLeftRadius, 16);
  assert.equal(info.topRightRadius, 16);
  assert.equal(info.bottomLeftRadius, 0);
  assert.equal(info.bottomRightRadius, 0);
  // 结果必须可 JSON 序列化（Symbol 泄漏防护：runCommand 经 JSON.stringify 回传）
  assert.deepEqual(JSON.parse(JSON.stringify(info)), info);
});

test('inspectNode：四角一致时保持 cornerRadius 输出（既有行为不回归）', () => {
  const figmaMock = makeFigma();
  const node = makeCornerNode(figmaMock, { uniform: 12, tl: 12, tr: 12, bl: 12, br: 12 });
  const sandbox = loadPlugin(figmaMock);
  const info = sandbox.inspectNode(node, 0);
  assert.equal(info.cornerRadius, 12);
  assert.ok(!('topLeftRadius' in info), '统一圆角时不需要冗余的 per-corner 键');
});

test('updateNode：接受 per-corner 半径参数并逐角赋值', async () => {
  const figmaMock = makeFigma();
  const node = makeCornerNode(figmaMock, { uniform: 0, tl: 0, tr: 0, bl: 0, br: 0 });
  figmaMock.getNodeById = (id) => (id === '1:2' ? node : null);
  const sandbox = loadPlugin(figmaMock);
  await sandbox.updateNode({ nodeId: '1:2', topLeftRadius: 16, topRightRadius: 16 });
  assert.equal(node.topLeftRadius, 16);
  assert.equal(node.topRightRadius, 16);
  assert.equal(node.bottomLeftRadius, 0, '未指定的角不应被改动');
  assert.equal(node.bottomRightRadius, 0);
});

test('createNode：render 规格接受 per-corner 半径参数并逐角赋值', async () => {
  const figmaMock = makeFigma();
  const created = makeCornerNode(figmaMock, { uniform: 0, tl: 0, tr: 0, bl: 0, br: 0 });
  figmaMock.createRectangle = () => created;
  const sandbox = loadPlugin(figmaMock);
  const node = await sandbox.createNode(
    {
      type: 'RECTANGLE',
      name: '上圆角卡片',
      width: 10,
      height: 10,
      fills: ['#112233'],
      topLeftRadius: 16,
      topRightRadius: 16,
    },
    { appendChild: () => {} },
  );
  assert.equal(node, created);
  assert.equal(node.topLeftRadius, 16);
  assert.equal(node.topRightRadius, 16);
  assert.equal(node.bottomLeftRadius, 0, '未指定的角不应被改动');
  assert.equal(node.bottomRightRadius, 0);
});

// ---------- effects：shadow alpha / spread / visible 过滤 ----------
// Figma API：paint 的 alpha 在顶层 opacity（color 为 RGB）；shadow effect 无 opacity，
// alpha 编码在 color.a（RGBA）。paintToHex 两种来源都要读。

test('paintToHex：shadow 的 alpha 从 color.a 读出（此前被静默丢弃）', () => {
  const sandbox = loadPlugin(makeFigma());
  const shadow = { type: 'DROP_SHADOW', color: { r: 0, g: 0.2, b: 0.4, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 12 };
  assert.equal(sandbox.paintToHex(shadow), '#00336640');
});

test('paintToHex：不透明阴影无 alpha 后缀（不引入冗余位）', () => {
  const sandbox = loadPlugin(makeFigma());
  const shadow = { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 2 }, radius: 8 };
  assert.equal(sandbox.paintToHex(shadow), '#000000');
});

test('paintToHex：填充的顶层 opacity 行为不变（回归哨兵）', () => {
  const sandbox = loadPlugin(makeFigma());
  assert.equal(sandbox.paintToHex({ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }), '#FF000080');
});

test('inspectNode：阴影读出 spread，visible:false 的 effect 被过滤', () => {
  const figmaMock = makeFigma();
  const node = makeCornerNode(figmaMock, { uniform: 0, tl: 0, tr: 0, bl: 0, br: 0 });
  node.effects = [
    { type: 'DROP_SHADOW', color: { r: 0, g: 0.2, b: 0.4, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 12, spread: 8, visible: true },
    { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4, visible: false },
    { type: 'LAYER_BLUR', radius: 6, visible: true },
  ];
  const sandbox = loadPlugin(figmaMock);
  const info = sandbox.inspectNode(node, 0);
  assert.equal(info.effects.length, 2, 'visible:false 的阴影不应出现在输出');
  assert.deepEqual(info.effects[0], {
    type: 'DROP_SHADOW',
    color: '#00336640',
    offset: { x: 0, y: 4 },
    radius: 12,
    spread: 8,
  });
  assert.deepEqual(info.effects[1], { type: 'LAYER_BLUR' });
});

// ---------- 渐变 stops：GradientPaint 无 color 字段（数据在 gradientStops + gradientTransform） ----------

function makeGradientPaint() {
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [
      { position: 0, color: { r: 0.29, g: 0.42, b: 0.93, a: 1 } },
      { position: 1, color: { r: 0.31, g: 0.85, b: 0.62, a: 0.6 } },
    ],
  };
}

test('paintToHex：渐变读出 stops（含 alpha）与 transform，不再降级为类型字符串', () => {
  const sandbox = loadPlugin(makeFigma());
  assert.deepEqual(sandbox.paintToHex(makeGradientPaint()), {
    type: 'GRADIENT_LINEAR',
    stops: [
      { position: 0, color: '#4A6BED' },
      { position: 1, color: '#4FD99E99' },
    ],
    transform: [[1, 0, 0], [0, 1, 0]],
  });
});

test('inspectNode：渐变填充在 fills 里以对象读出（此前只有 "GRADIENT_LINEAR" 字符串）', () => {
  const figmaMock = makeFigma();
  const node = makeCornerNode(figmaMock, { uniform: 0, tl: 0, tr: 0, bl: 0, br: 0 });
  node.fills = [makeGradientPaint()];
  const sandbox = loadPlugin(figmaMock);
  const info = sandbox.inspectNode(node, 0);
  assert.equal(info.fills.length, 1);
  assert.equal(info.fills[0].type, 'GRADIENT_LINEAR');
  assert.deepEqual(info.fills[0].stops, [
    { position: 0, color: '#4A6BED' },
    { position: 1, color: '#4FD99E99' },
  ]);
});

test('paintToHex：SOLID 填充仍为 hex 字符串（渐变改造不回归既有契约）', () => {
  const sandbox = loadPlugin(makeFigma());
  assert.equal(sandbox.paintToHex({ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }), '#FF0000');
});
