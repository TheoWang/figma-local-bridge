// Figma Local Bridge 插件主沙箱：通过 fetch 长轮询本地中继取命令，
// 执行 Figma 操作后 POST 结果回去。插件沙箱没有 WebSocket，但有 fetch，长轮询更稳。
// 端口与中继一致（默认 9741）；如需改端口，两处同步修改。

var SERVER = 'http://localhost:9741';
var PLUGIN_VERSION = '0.2.0';
var instanceId = Math.random().toString(36).slice(2, 8);
var sessionId = null;
var fileKey = (typeof figma.fileKey === 'string' && figma.fileKey) || ('name:' + figma.root.name);
var notifiedFailure = false;
var notifiedSuccess = false;
var lastBootId = null;

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function hello() {
  var res = await fetch(
    SERVER + '/hello?fileKey=' + encodeURIComponent(fileKey) +
      '&fileName=' + encodeURIComponent(figma.root.name) +
      '&version=' + PLUGIN_VERSION +
      '&instanceId=' + instanceId,
  );
  var data = await res.json();
  if (!(data && data.sessionId)) throw new Error('握手未获 sessionId（中继版本过旧？）');
  sessionId = data.sessionId;
}

async function pollLoop() {
  for (;;) {
    try {
      if (!sessionId) await hello();
      var res = await fetch(SERVER + '/poll?sessionId=' + encodeURIComponent(sessionId));
      var data = await res.json();
      if (!notifiedSuccess) {
        notifiedSuccess = true;
        notifiedFailure = false;
        figma.notify('Figma Local Bridge 已连接本地中继，可以接收命令了');
      }
      if (data && data.sessionExpired) {
        sessionId = null; // 下一轮重新 hello
      } else {
        // 命令分支必须先于 bootId 重握手：poll 响应带 command 说明本会话已在当前
        // 中继实例注册，此时先执行命令并回传结果，再标记重握手，避免命令被静默丢弃
        if (data && data.command) {
          await runCommand(data.command);
        }
        if (data && data.relayBootId !== lastBootId) {
          sessionId = null; // 中继换实例：重新握手（命令已先执行，结果已回传）
          lastBootId = data.relayBootId;
        }
      }
    } catch (e) {
      if (!notifiedFailure) {
        notifiedFailure = true;
        figma.notify('未连上本地中继（请先运行 figma-bridge server），持续重试中…', {
          error: true,
          timeout: 3000,
        });
      }
      notifiedSuccess = false;
      await sleep(2000);
    }
  }
}

async function runCommand(cmd) {
  var ok = true,
    result = null,
    error = null;
  try {
    result = await execute(cmd);
  } catch (e) {
    ok = false;
    error = String(e && e.message ? e.message : e);
  }
  try {
    await fetch(SERVER + '/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: cmd.id, sessionId: sessionId, ok: ok, result: result, error: error }),
    });
  } catch (e) {
    // 结果回传失败：中继可能重启过，下一轮 poll 会重建状态
  }
}

// ---------- 命令分发 ----------

function execute(command) {
  switch (command.action) {
    case 'ping':
      return Promise.resolve({
        pong: true,
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        pageId: figma.currentPage.id,
      });
    case 'listPages':
      return Promise.resolve(
        figma.root.children.map(function (p) {
          return { id: p.id, name: p.name };
        }),
      );
    case 'createPage':
      return createPage(command.params || {});
    case 'gotoPage':
      return gotoPage(command.params || {});
    case 'getStructure':
      return Promise.resolve(
        describeNode(figma.currentPage, (command.params && command.params.depth) || 2),
      );
    case 'inspectNode':
      return Promise.resolve(
        inspectNode(
          figma.getNodeById(command.params.nodeId),
          command.params.depth == null ? 3 : command.params.depth,
        ),
      );
    case 'capabilities':
      return Promise.resolve({
        createNodeFromSvgAsync: typeof figma.createNodeFromSvgAsync,
        createNodeFromSVG: typeof figma.createNodeFromSVG,
        createImageAsync: typeof figma.createImageAsync,
        createImage: typeof figma.createImage,
        createComponentFromNode: typeof figma.createComponentFromNode,
        apiVersion: figma.apiVersion,
        editorType: figma.editorType,
        mode: figma.mode,
      });
    case 'render':
      return renderTree(command.params || {});
    case 'exportNode':
      return exportNode(command.params || {});
    case 'remove':
      return removeNode(command.params || {});
    case 'update':
      return updateNode(command.params || {});
    case 'importSvg':
      return Promise.reject(
        new Error(
          '当前 Figma 版本无 SVG 导入 API；请直接用 CLI 的 importSvg（会自动栅格化为 PNG 走 placeImage）',
        ),
      );
    case 'placeImage':
      return placeImage(command.params || {});
    case 'makeComponent':
      return makeComponent(command.params || {});
    case 'setImageFill':
      return setImageFill(command.params || {});
    case 'link':
      return linkNodes(command.params || {});
    default:
      return Promise.reject(new Error('未知命令：' + command.action));
  }
}

// 修改已有节点：{ nodeId, name?, fills?, opacity?, cornerRadius?, width?, height?, x?, y?,
//   text?: { characters?, fontSize?, fontWeight?, color? } }
async function updateNode(params) {
  var node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error('找不到节点：' + params.nodeId);
  if (params.name !== undefined) node.name = params.name;
  if (params.fills && 'fills' in node) node.fills = params.fills.map(hexToPaint);
  if (params.opacity !== undefined) node.opacity = params.opacity;
  if (params.cornerRadius !== undefined && 'cornerRadius' in node)
    node.cornerRadius = params.cornerRadius;
  if ((params.width || params.height) && 'resize' in node) {
    node.resize(params.width || node.width, params.height || node.height);
  }
  if (params.x !== undefined) node.x = params.x;
  if (params.y !== undefined) node.y = params.y;
  if (params.text && node.type === 'TEXT') {
    await figma.loadFontAsync(node.fontName);
    var t = params.text;
    if (t.characters !== undefined) node.characters = String(t.characters);
    if (t.fontSize) node.fontSize = t.fontSize;
    if (t.fontWeight) {
      var style = FONT_WEIGHT_STYLE[t.fontWeight] || 'Regular';
      try {
        await figma.loadFontAsync({ family: node.fontName.family, style: style });
        node.fontName = { family: node.fontName.family, style: style };
      } catch (e) {
        /* 字体缺该字重则保持原样 */
      }
    }
    if (t.color) node.fills = [hexToPaint(t.color)];
  }
  return { nodeId: node.id, name: node.name };
}

// 放置图片节点（含栅格化后的图标）：{ imageBase64, width, height, name?, parentNodeId?, x?, y?, scaleMode? }
// 创建透明矩形 + IMAGE 填充；图片字节可为 PNG/JPEG。
async function placeImage(params) {
  if (!params.imageBase64) throw new Error('缺少 imageBase64 参数');
  var bytes = base64ToUint8(params.imageBase64);
  var image;
  try {
    image = await figma.createImageAsync(bytes);
  } catch (e) {
    image = figma.createImage(bytes); // 旧版同步 API 兜底
  }
  var node = figma.createRectangle();
  node.name = params.name || 'image';
  node.resize(params.width || 24, params.height || 24);
  node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: params.scaleMode || 'FIT' }];
  var parent = figma.currentPage;
  if (params.parentNodeId) {
    var p = figma.getNodeById(params.parentNodeId);
    if (!p || !('appendChild' in p)) throw new Error('父节点不可用：' + params.parentNodeId);
    parent = p;
  }
  parent.appendChild(node);
  if (!('layoutMode' in parent) || parent.layoutMode === 'NONE') {
    node.x = params.x || 0;
    node.y = params.y || 0;
  }
  cleanUnusedImages();
  return { nodeId: node.id, name: node.name, width: node.width, height: node.height };
}

// 把已有节点转成组件：{ nodeId }
async function makeComponent(params) {
  var node = figma.getNodeById(params.nodeId);
  if (!node) throw new Error('找不到节点：' + params.nodeId);
  if (node.type === 'COMPONENT') return { nodeId: node.id, name: node.name, already: true };
  var comp = figma.createComponentFromNode(node);
  return { nodeId: comp.id, name: comp.name };
}

// 组件名 → 主组件（运行期内缓存；组件库重建/删除后缓存会失效，createInstance 失败时自动重建重试一次）
// 注意：dynamic-page 模式下必须先 loadAllPagesAsync，否则搜不到未加载页面上的组件
var componentCache = null;
async function getComponentMap() {
  if (figma.loadAllPagesAsync) await figma.loadAllPagesAsync();
  componentCache = {};
  figma.root
    .findAll(function (n) {
      return n.type === 'COMPONENT';
    })
    .forEach(function (c) {
      componentCache[c.name] = c;
    });
  return componentCache;
}
async function findComponentByName(name) {
  if (!componentCache) await getComponentMap();
  return componentCache[name] || null;
}

// INSTANCE：{ component: '按钮/主要/中', text?: '覆盖首个TEXT', width?, height?, x?, y?, name? }
async function createInstanceNode(spec, parent) {
  if (!spec.component) throw new Error('INSTANCE 缺少 component 名称');
  var comp = await findComponentByName(spec.component);
  if (!comp) throw new Error('找不到主组件：' + spec.component + '（请先生成组件库页）');
  var inst;
  try {
    inst = comp.createInstance();
  } catch (e) {
    await getComponentMap();
    comp = componentCache[spec.component];
    if (!comp) throw new Error('主组件已不存在：' + spec.component);
    inst = comp.createInstance();
  }
  inst.name = spec.name || spec.component;
  parent.appendChild(inst);
  if (spec.text !== undefined) {
    var txt = inst.findOne(function (n) {
      return n.type === 'TEXT';
    });
    if (txt) {
      await figma.loadFontAsync(txt.fontName);
      txt.characters = String(spec.text);
      if (spec.textColor) txt.fills = [hexToPaint(spec.textColor)];
    }
  }
  if (spec.width || spec.height) {
    try {
      inst.resize(spec.width || inst.width, spec.height || inst.height);
    } catch (e) {}
  }
  if (!('layoutMode' in parent) || parent.layoutMode === 'NONE') {
    inst.x = spec.x || 0;
    inst.y = spec.y || 0;
  }
  return inst;
}

// 图片填充：{ nodeId, imageBase64, scaleMode? }（base64 为 PNG/JPEG 原始字节）
async function setImageFill(params) {
  var node = figma.getNodeById(params.nodeId);
  if (!node || !('fills' in node)) throw new Error('节点不可填充：' + params.nodeId);
  var bytes = base64ToUint8(params.imageBase64);
  var image;
  try {
    image = await figma.createImageAsync(bytes);
  } catch (e) {
    image = figma.createImage(bytes); // 旧版同步 API 兜底
  }
  node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: params.scaleMode || 'FILL' }];
  cleanUnusedImages();
  return { nodeId: node.id, imageHash: image.hash };
}

// 清理文档中不再被任何节点引用的图片字节。只增不删会让 Figma 长时间运行后内存单调上涨；
// 刚创建的图片已被节点引用，不会被误删。
function cleanUnusedImages() {
  if (typeof figma.cleanAllImages !== 'function') return;
  Promise.resolve(figma.cleanAllImages()).catch(function (e) {
    /* 清理失败不影响命令结果 */
  });
}

// 原型连线：{ fromNodeId, toNodeId }（点击 from 跳转到 to）
async function linkNodes(params) {
  var from = figma.getNodeById(params.fromNodeId);
  var to = figma.getNodeById(params.toNodeId);
  if (!from || !('reactions' in from)) throw new Error('起点节点不支持连线：' + params.fromNodeId);
  if (!to) throw new Error('找不到终点节点：' + params.toNodeId);
  var reactions = [
    {
      trigger: { type: 'ON_CLICK' },
      actions: [{ type: 'NODE', destinationId: to.id, navigation: 'NAVIGATE', transition: null }],
    },
  ];
  if (from.setReactionsAsync) {
    await from.setReactionsAsync(reactions);
  } else {
    from.reactions = reactions;
  }
  return { from: from.id, to: to.id };
}

function base64ToUint8(base64) {
  var clean = String(base64).replace(/\s/g, '');
  var len = clean.length;
  var padding = (clean[len - 1] === '=' ? 1 : 0) + (clean[len - 2] === '=' ? 1 : 0);
  var exact = Math.floor((len * 3) / 4) - padding;
  var tmp = new Uint8Array(Math.floor((len * 3) / 4));
  var p = 0;
  for (var i = 0; i < len; i += 4) {
    var c0 = BASE64_CHARS.indexOf(clean[i]);
    var c1 = BASE64_CHARS.indexOf(clean[i + 1]);
    var c2 = clean[i + 2] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 2]);
    var c3 = clean[i + 3] === '=' ? 0 : BASE64_CHARS.indexOf(clean[i + 3]);
    tmp[p++] = (c0 << 2) | (c1 >> 4);
    if (clean[i + 2] !== '=') tmp[p++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (clean[i + 3] !== '=') tmp[p++] = ((c2 & 3) << 6) | c3;
  }
  // 返回精确长度的全新数组（subarray 视图在部分 API 的参数校验中会被拒）
  var out = new Uint8Array(exact);
  for (var j = 0; j < exact; j++) out[j] = tmp[j];
  return out;
}

// 新建页面：{ name } → 返回新页面 id
function createPage(params) {
  var page = figma.createPage();
  page.name = params.name || '未命名页面';
  return Promise.resolve({ pageId: page.id, pageName: page.name });
}

function gotoPage(params) {
  var page = figma.root.children.find(function (p) {
    return p.id === params.pageId || p.name === params.pageName;
  });
  if (!page) return Promise.reject(new Error('找不到页面：' + (params.pageId || params.pageName)));
  return figma.setCurrentPageAsync(page).then(function () {
    return { pageId: page.id, pageName: page.name };
  });
}

function describeNode(node, depth) {
  var info = { id: node.id, name: node.name, type: node.type };
  if ('width' in node) {
    info.width = Math.round(node.width);
    info.height = Math.round(node.height);
  }
  if (depth > 0 && 'children' in node) {
    info.children = node.children.map(function (c) {
      return describeNode(c, depth - 1);
    });
  } else if ('children' in node) {
    info.childCount = node.children.length;
  }
  return info;
}

// 读出节点完整视觉属性（颜色/圆角/字体/间距/阴影），供设计令牌提取与 1:1 还原核对。
// 与 describeNode 的区别：describeNode 只有几何信息，inspectNode 带全部样式。
function inspectNode(node, depth) {
  if (!node) throw new Error('inspectNode: 找不到节点');
  var info = describeNode(node, 0);
  var box = node.absoluteBoundingBox;
  if (box) info.abs = { x: Math.round(box.x), y: Math.round(box.y) };
  if ('opacity' in node && node.opacity !== 1) info.opacity = node.opacity;
  if ('visible' in node && node.visible === false) info.visible = false;
  if ('fills' in node && Array.isArray(node.fills)) info.fills = node.fills.map(paintToHex);
  if ('strokes' in node && node.strokes.length) {
    info.stroke = { color: paintToHex(node.strokes[0]), weight: node.strokeWeight };
  }
  if ('cornerRadius' in node && node.cornerRadius) info.cornerRadius = node.cornerRadius;
  if ('effects' in node && node.effects.length) {
    info.effects = node.effects.map(function (e) {
      if (e.type.indexOf('SHADOW') < 0) return { type: e.type };
      return { type: e.type, color: paintToHex(e), offset: e.offset, radius: e.radius };
    });
  }
  if (node.type === 'TEXT') {
    info.text = {
      characters: node.characters,
      fontSize: node.fontSize,
      fontFamily: node.fontName && node.fontName.family,
      fontStyle: node.fontName && node.fontName.style,
      lineHeight: node.lineHeight,
      textAlign: node.textAlignHorizontal,
    };
  }
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    info.layout = {
      mode: node.layoutMode,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      primaryAlign: node.primaryAxisAlignItems,
      counterAlign: node.counterAxisAlignItems,
    };
  }
  if (depth > 0 && 'children' in node) {
    info.children = node.children.map(function (c) {
      return inspectNode(c, depth - 1);
    });
  }
  return info;
}

function paintToHex(p) {
  if (!p || !p.color) return p && p.type ? p.type : null;
  var c = p.color;
  var hex =
    '#' +
    [c.r, c.g, c.b]
      .map(function (v) {
        return ('0' + Math.round(v * 255).toString(16)).slice(-2).toUpperCase();
      })
      .join('');
  var a = p.opacity == null ? 1 : p.opacity;
  return a < 1 ? hex + ('0' + Math.round(a * 255).toString(16)).slice(-2).toUpperCase() : hex;
}

function removeNode(params) {
  var node = figma.getNodeById(params.nodeId);
  if (!node) return Promise.reject(new Error('找不到节点：' + params.nodeId));
  var name = node.name;
  node.remove();
  return Promise.resolve({ removed: name });
}

function exportNode(params) {
  var node = figma.getNodeById(params.nodeId || figma.currentPage.id);
  if (!node || !('exportAsync' in node))
    return Promise.reject(new Error('节点不可导出：' + params.nodeId));
  var settings = {
    format: params.format === 'SVG' ? 'SVG' : 'PNG',
    constraint: { type: 'SCALE', value: params.scale || 2 },
  };
  if (settings.format === 'SVG') {
    delete settings.constraint;
  }
  return node.exportAsync(settings).then(function (bytes) {
    return { format: settings.format, base64: uint8ToBase64(bytes), byteLength: bytes.length };
  });
}

// ---------- 节点树渲染 ----------

// tree 规格示例：
// { type: 'FRAME', name, width, height, fills: ['#0B1F3A'], cornerRadius,
//   layout: { mode: 'VERTICAL', gap: 16, padding: [24,24,24,24], primaryAlign: 'MIN', counterAlign: 'CENTER' },
//   children: [ { type: 'TEXT', text: { characters: '标题', fontSize: 24, fontWeight: 700, color: '#FFFFFF' } } ] }

function renderTree(params) {
  var tree = params.tree;
  if (!tree) return Promise.reject(new Error('缺少 tree 参数'));
  var parent = figma.currentPage;
  if (params.parentNodeId) {
    var p = figma.getNodeById(params.parentNodeId);
    if (!p || !('appendChild' in p))
      return Promise.reject(new Error('父节点不可用：' + params.parentNodeId));
    parent = p;
  }
  return createNode(tree, parent).then(function (root) {
    // 直接画在页面上的新稿自动向右排开，避免多稿叠在原点
    if (parent.type === 'PAGE' && params.x === undefined && params.y === undefined) {
      var maxRight = 0,
        minTop = 0,
        has = false;
      parent.children.forEach(function (c) {
        if (c === root) return;
        has = true;
        maxRight = Math.max(maxRight, c.x + c.width);
        minTop = Math.min(minTop, c.y);
      });
      if (has) {
        root.x = maxRight + 80;
        root.y = minTop;
      }
    }
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
    return { rootId: root.id, rootName: root.name, pageName: figma.currentPage.name };
  });
}

function createNode(spec, parent) {
  var node;
  switch (spec.type) {
    case 'FRAME':
      node = figma.createFrame();
      break;
    case 'RECTANGLE':
      node = figma.createRectangle();
      break;
    case 'ELLIPSE':
      node = figma.createEllipse();
      break;
    case 'TEXT':
      return createText(spec, parent);
    case 'INSTANCE':
      return createInstanceNode(spec, parent);
    default:
      return Promise.reject(new Error('不支持的节点类型：' + spec.type));
  }
  node.name = spec.name || spec.type;
  parent.appendChild(node);

  if (spec.type === 'FRAME') {
    applyFrameLayout(node, spec);
    node.fills = spec.fills ? spec.fills.map(hexToPaint) : [];
    if (spec.clipsContent !== undefined) node.clipsContent = !!spec.clipsContent;
  } else {
    node.fills = spec.fills
      ? spec.fills.map(hexToPaint)
      : [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8 } }];
  }

  if (spec.cornerRadius !== undefined && 'cornerRadius' in node)
    node.cornerRadius = spec.cornerRadius;
  if (spec.opacity !== undefined) node.opacity = spec.opacity;
  if (spec.stroke && 'strokes' in node) {
    node.strokes = [hexToPaint(spec.stroke.color || '#000000')];
    node.strokeWeight = spec.stroke.weight || 1;
  }

  var w = spec.width || 100;
  var h = spec.height || 100;
  var autoLayout =
    spec.type === 'FRAME' && spec.layout && spec.layout.mode && spec.layout.mode !== 'NONE';
  if (!autoLayout) {
    // 非自动布局：直接定尺寸，子节点用绝对坐标摆放
    node.resize(w, h);
  }
  // 自动布局：先由内容与 sizing 决定尺寸，子节点创建完后再按需 resize（见下方 chain.then）

  if (!('layoutMode' in parent) || parent.layoutMode === 'NONE') {
    node.x = spec.x || 0;
    node.y = spec.y || 0;
  }

  var children = spec.children || [];
  var chain = Promise.resolve();
  children.forEach(function (child) {
    chain = chain.then(function () {
      return createNode(child, node);
    });
  });
  return chain.then(function () {
    if (autoLayout) {
      if (spec.width) {
        // 在自动布局下，宽/高通过调整 sizing 或 resize 实现
        try {
          node.resize(spec.width, node.height);
        } catch (e) {}
      }
      if (spec.height) {
        try {
          node.resize(node.width, spec.height);
        } catch (e) {}
      }
    }
    return node;
  });
}

function applyFrameLayout(node, spec) {
  var layout = spec.layout || {};
  var mode = layout.mode || 'NONE';
  node.layoutMode = mode === 'NONE' ? 'NONE' : mode;
  if (mode !== 'NONE') {
    node.itemSpacing = layout.gap !== undefined ? layout.gap : 0;
    var pad = layout.padding || [0, 0, 0, 0];
    node.paddingTop = pad[0];
    node.paddingRight = pad[1];
    node.paddingBottom = pad[2];
    node.paddingLeft = pad[3];
    node.primaryAxisAlignItems = layout.primaryAlign || 'MIN';
    node.counterAxisAlignItems = layout.counterAlign || 'MIN';
    // 缺省双轴都随内容（AUTO）；指定 width/height 时会在子节点创建后 resize，自动转为 FIXED
    node.primaryAxisSizingMode = layout.primarySizing || 'AUTO';
    node.counterAxisSizingMode = layout.counterSizing || 'AUTO';
  }
}

var FONT_WEIGHT_STYLE = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semi Bold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
};

function createText(spec, parent) {
  var t = spec.text || {};
  var family = t.fontFamily || 'Inter';
  var style = t.fontStyle || FONT_WEIGHT_STYLE[t.fontWeight || 400] || 'Regular';
  var node = figma.createText();
  return figma
    .loadFontAsync({ family: family, style: style })
    .catch(function () {
      family = 'Inter';
      style = 'Regular';
      return figma.loadFontAsync({ family: family, style: style });
    })
    .then(function () {
      node.fontName = { family: family, style: style };
      node.characters = String(t.characters !== undefined ? t.characters : '');
      node.name = spec.name || String(t.characters || 'TEXT').slice(0, 20);
      node.fontSize = t.fontSize || 14;
      if (t.lineHeightPercent) node.lineHeight = { unit: 'PERCENT', value: t.lineHeightPercent };
      if (t.letterSpacing) node.letterSpacing = { unit: 'PERCENT', value: t.letterSpacing };
      if (t.align) node.textAlignHorizontal = t.align; // 'LEFT'|'CENTER'|'RIGHT'
      node.fills = [hexToPaint(t.color || '#000000')];
      parent.appendChild(node);
      if (t.width) {
        // 定宽换行：高度随内容，宽度固定（长段落必须）
        node.textAutoResize = 'HEIGHT';
        node.resize(t.width, node.height);
      } else {
        node.textAutoResize = t.autoResize || 'WIDTH_AND_HEIGHT';
      }
      if (spec.opacity !== undefined) node.opacity = spec.opacity;
      if (!('layoutMode' in parent) || parent.layoutMode === 'NONE') {
        node.x = spec.x || 0;
        node.y = spec.y || 0;
      }
      return node;
    });
}

// ---------- 工具函数 ----------

function hexToPaint(hex) {
  var h = String(hex).replace('#', '');
  var a = 1;
  if (h.length === 8) {
    a = parseInt(h.slice(6, 8), 16) / 255;
    h = h.slice(0, 6);
  }
  return {
    type: 'SOLID',
    color: {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
    },
    opacity: a,
  };
}

var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function uint8ToBase64(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i],
      b1 = i + 1 < bytes.length ? bytes[i + 1] : 0,
      b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? BASE64_CHARS[b2 & 63] : '=';
  }
  return out;
}

console.log('[FLB] 主沙箱已启动，开始轮询中继…');
pollLoop();
