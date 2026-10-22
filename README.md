# figma-local-bridge

Figma 本地插件桥：**无需 Figma MCP 权限、免费账号可用**，让 AI 代理 / 脚本读写你的 Figma 画布。

- 读：文件结构（`getStructure`）、任意节点导出 PNG/SVG（`exportNode`）
- 写：声明式节点树渲染（`render`，支持自动布局）、组件实例（`INSTANCE`）、修改/删除节点（`update`/`remove`）、组件化（`makeComponent`）、原型连线（`link`）、图片/SVG 图标（`placeImage`/`importSvg`/`setImageFill`）

中继支持多文件：在多个 Figma 文件中各自运行插件，`list-files` 查看在线文件，命令用 `--file` 指定目标（单文件用法不变）。

## 原理

```
你的脚本/AI ──ws──> 本地中继（server.js，端口 9741）<──fetch 长轮询── Figma 插件（沙箱内执行命令）
```

插件沙箱没有 WebSocket（且 iframe 方案会被桌面端私有网络策略拦截），所以插件侧用 `fetch` 长轮询——这是官方支持的 localhost 开发场景。

## 安装

```bash
npm install figma-local-bridge        # 或 file: 引用本地路径
npx figma-bridge install-plugin       # 把插件安装到 ~/figma-local-bridge-plugin（非隐藏目录）
```

> 插件的完整配置步骤（导入 manifest、运行、自检、常见问题）见 **[插件安装与配置指南](docs/plugin-setup.md)**。

## 每次使用（三步）

1. `npx figma-bridge server`（保持运行）
2. Figma **桌面客户端**（网页版不支持开发插件）→ `Plugins` → `Development` → `Import plugin from manifest…` → 选安装目录里的 `manifest.json`（仅首次）
3. 打开目标文件，运行「Figma Local Bridge」插件（无界面、常驻后台）

自检：`npx figma-bridge doctor`（中继连通性 / 插件在线 / 版本一致性）。

## 命令

```bash
npx figma-bridge server                    # 起中继
npx figma-bridge render examples/hello.json  # 渲染节点树文件
npx figma-bridge send '{"action":"ping"}'  # 发任意命令
npx figma-bridge send --file 首页 '{"action":"ping"}'   # 向指定文件发命令（选择器为 fileKey 或文件名唯一子串）
npx figma-bridge export 123:456 2          # 导出节点为 PNG 到 ./exports/
npx figma-bridge list-files                # 列出在线文件（fileKey/文件名/版本/排队数）
npx figma-bridge install-plugin            # 安装/更新插件文件
npx figma-bridge doctor                    # 自检
```

插件命令一览：`ping` / `listPages` / `createPage` / `gotoPage` / `getStructure{depth}` / `render{tree,parentNodeId?,x?,y?}` / `update{nodeId,...}` / `remove{nodeId}` / `exportNode{nodeId,format,scale}` / `importSvg{svg,...}`（CLI 侧栅格化为 PNG）/ `placeImage{imageBase64,...}` / `setImageFill{nodeId,imageBase64}` / `makeComponent{nodeId}` / `link{fromNodeId,toNodeId}`。

## render 节点树规格

```jsonc
{
  "type": "FRAME",                 // FRAME | RECTANGLE | ELLIPSE | TEXT | INSTANCE
  "name": "名称",
  "width": 375, "height": 812,     // 非自动布局直接生效；自动布局在子节点创建后 resize
  "x": 0, "y": 0,                  // 父级非自动布局时生效；落在页面上不给坐标时自动向右排开
  "fills": ["#RRGGBB" 或 "#RRGGBBAA"],
  "cornerRadius": 12,
  "stroke": { "color": "#000000", "weight": 1 },
  "layout": {                      // 自动布局（仅 FRAME）
    "mode": "VERTICAL",            // VERTICAL | HORIZONTAL | NONE
    "gap": 16,
    "padding": [24, 24, 24, 24],   // 上右下左
    "primaryAlign": "MIN",         // MIN | CENTER | MAX | SPACE_BETWEEN
    "counterAlign": "CENTER",
    "primarySizing": "AUTO",       // AUTO | FIXED
    "counterSizing": "FIXED"
  },
  "children": []
}
```

TEXT：`{ "type": "TEXT", "text": { "characters", "fontSize", "fontWeight": 100-900, "fontFamily", "color", "align", "lineHeightPercent", "width" } }`——**长文本必须给 `width`**（定宽换行，否则被裁切）。

INSTANCE：`{ "type": "INSTANCE", "component": "按钮/主要/中", "text": "覆盖文字", "textColor": "#1A1A1A", "width": 351 }`——按组件名实例化本文件中的主组件。

## 已踩过的坑（勿重蹈）

- **必须桌面客户端**：网页版 Figma 不能装载/运行开发插件。
- **manifest 白名单**：`allowedDomains` 必填（可写 `["none"]`）；localhost 只能放 `devAllowedDomains`，且必须 `http://localhost:端口`——不认 `ws://`、不认 `127.0.0.1`。
- **中继监听**：不能绑死 `127.0.0.1`（macOS `localhost` 优先解析 IPv6 `::1`），不指定 host 走双栈。
- **沙箱无 WebSocket**：iframe 方案会被私有网络策略拦截；插件侧用 fetch 长轮询。
- **SVG 导入 API 已移除**：`createNodeFromSVG*` 均不可用；CLI 用 sharp 栅格化 SVG 为透明 PNG 再走 `placeImage`。
- **`createImageAsync` 校验严格**：必须精确长度的全新 `Uint8Array`，subarray 视图会被拒。
- **自动布局副轴默认 FIXED**：需显式 `counterAxisSizingMode: 'AUTO'`，否则文字裁切。
- **属性层级**：`padding/gap/primaryAlign` 属 `layout`；`fills/cornerRadius/width` 属节点顶层——放错层级静默忽略。
- **组件检索要先 `loadAllPagesAsync`**（dynamic-page 模式）；组件缓存失效要重建重试。
- **TEXT 不可转组件**，且 TEXT 按内容自动命名（收集组件化目标时排除）。
- **改插件代码必须重启插件；改 manifest 必须重新导入**；包升级后跑 `install-plugin` + 重启插件（`doctor` 查版本一致性）。

## 端口

默认 `9741`。修改：中继/CLI 用环境变量 `FLB_PORT`；插件改 `plugin/code.js` 顶部 `SERVER` 常量（改后需重新 install-plugin + 重启插件）。

## License

MIT
