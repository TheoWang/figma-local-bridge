# MCP Server 设计 — v0.3.0

日期：2026-11-19
状态：已评审（方案 A 手写协议；细粒度工具；中继自动拉起，均为用户确认）

## 背景与目标

v0.2.x 的对外接口是 CLI（`figma-bridge send/render/export`），AI 代理经由 Bash 调用。这条通道的三个痛点：

1. **无自描述**：AI 靠 README 猜命令格式与 action 参数，错了运行时才报错。
2. **图片两步走**：`export` 落盘后 AI 还要再 Read 一次才能"看到"画布。
3. **权限粒度粗**：Bash 通道下 AI 可发任意 action，无法只放行"读"。

目标：新增一个 **MCP stdio server**（`figma-bridge mcp`），让任意 MCP 客户端（ZCode / Claude Desktop / Cursor）获得：结构化工具 schema、图片内联返回（image content）、工具级权限控制、一行配置接入。

**中继（server.js）与插件（code.js）零改动**——MCP server 是纯增量的一层翻译。CLI 保留不动，作为人用/调试通道。

非目标（YAGNI）：不做 MCP resources / prompts / sampling；不做 Streamable HTTP 传输；不做 `capabilities` 工具（开发期诊断，AI 用不上）；不做 `notifications/cancelled` 向中继的传播（取消时结果自然丢弃）；不做 `export_node` 自定义落盘路径（固定 `<cwd>/exports/`，与 CLI 一致）。

## 方案选型（已确认的三个决策 + 一个推荐）

| 决策 | 选择 | 为什么不是另一个 |
|---|---|---|
| 协议实现 | **手写 stdio JSON-RPC 2.0**（方案 A） | 官方 SDK 是 ESM-only，与 CJS 主包混装增加发布复杂度，且引入 SDK+zod 依赖违背零依赖哲学；我们只用 tools 子集，协议面很小 |
| 工具粒度 | **细粒度逐 action 映射**（16 个工具） | 粗粒度合并/单工具透传会让 schema 退化为宽松 object，丢掉 MCP 自描述的核心优势 |
| 中继生命周期 | **自动拉起 + 复用已有** | 手动起中继要求用户记得前置步骤，重启机器/客户端后必然踩"中继离线" |

## 总体架构

```
MCP 客户端（ZCode 等）
   │ stdio：换行分隔 JSON-RPC 2.0（stdin/stdout；日志只进 stderr）
   ▼
MCP server（src/mcp/，客户端按需拉起）
   ├── 协议层：initialize / tools/list / tools/call / ping 分发
   ├── 工具层：16 个 tools ↔ action 翻译 + inputSchema
   ├── 连接层：一条长驻 WS → localhost:9741（串行化命令 + 指数退避重连）
   └── 生命周期：探测 9741 → 不在线则 spawn 中继子进程，退出时回收自己拉起的
   ▼
本地中继（src/server.js，零改动）◀──HTTP 长轮询── Figma 插件（零改动）
```

## MCP 协议实现（手写）

传输：stdio 上换行分隔的 JSON-RPC 2.0（Node 内置 readline，零依赖）。

| 方法 | 行为 |
|---|---|
| `initialize` | 响应 `{ protocolVersion: <原样回显客户端请求值>, capabilities: { tools: {} }, serverInfo: { name: "figma-local-bridge", version: <pkg version> } }`。回显客户端版本是最稳的兼容策略 |
| `notifications/initialized` | 通知，忽略 |
| `tools/list` | 响应工具定义表（见下节），`inputSchema` 为纯 JSON Schema 对象 |
| `tools/call` | 按 `name` 分发到 handler；成功 `{ content, isError?: false }`；失败 `{ content: [{ type: "text", text: <中文错误> }], isError: true }`——工具失败是业务错误不是协议错误 |
| `ping`（协议级） | 响应 `{}` |
| 其余方法 | JSON-RPC error `-32601` method not found |

日志（中继拉起决策、连接断开、重连）一律 `console.error`，**stdout 只允许协议消息**。

## 工具清单（16 个 = 14 个可直连的插件 action + 1 个本地翻译 `import_svg` + 1 个中继状态 `__status`）

所有工具均带可选 `file` 参数（fileKey 精确值或文件名唯一子串，大小写不敏感），语义与 CLI `--file` 完全一致（复用抽取后的 `resolveFileKey`）。单文件在线不传自动路由；多文件不唯一报错并附在线清单——沿用中继现有语义。

| # | 工具 | 对应 action | 参数要点 |
|---|---|---|---|
| 1 | `list_files` | `__status` | 无参；输出精简为 fileName/fileKey/pluginVersion/alive/queued |
| 2 | `ping` | `ping` | 无参；端到端连通验证，返回 fileName/pageName/pageId |
| 3 | `list_pages` | `listPages` | 无参 |
| 4 | `create_page` | `createPage` | `name?` |
| 5 | `goto_page` | `gotoPage` | `pageId` 或 `pageName` 二选一 |
| 6 | `get_structure` | `getStructure` | `depth?`（默认 2） |
| 7 | `inspect_node` | `inspectNode` | `nodeId`，`depth?`（默认 3）；design-to-code 读样式的核心工具（README 未列出但插件已有） |
| 8 | `render` | `render` | `tree`（递归 JSON Schema，见下）、`parentNodeId?`、`x?`、`y?` |
| 9 | `update` | `update` | `nodeId` + 任意节点属性（schema 用宽松 object，描述里给常用键） |
| 10 | `remove` | `remove` | `nodeId` |
| 11 | `export_node` | `exportNode` | `nodeId`、`format?`（PNG/SVG，默认 PNG）、`scale?`（默认 2） |
| 12 | `place_image` | `placeImage` | **`image_path`（本地路径）**、`width?`、`height?`（默认 24）、`name?`、`parentNodeId?`、`x?`、`y?`、`scaleMode?`（默认 FIT） |
| 13 | `import_svg` | （CLI 侧栅格化 → `placeImage`） | `svg`（字符串）、`width?`、`height?`（默认 24）、其余同 place_image；sharp 缺失时报可安装提示 |
| 14 | `set_image_fill` | `setImageFill` | `nodeId`、**`image_path`**、`scaleMode?`（默认 FILL） |
| 15 | `make_component` | `makeComponent` | `nodeId` |
| 16 | `link` | `link` | `fromNodeId`、`toNodeId` |

### 三个关键适配

**图片输入走本地路径**（`place_image`/`set_image_fill`）：AI 手里有的是文件路径不是 base64。MCP server 读文件转 base64 后再发中继，schema 只暴露 `image_path`。文件不存在/不可读 → `isError` 中文报错。

**`export_node` 双通道返回**：PNG → MCP image content（`{ type: "image", data: <base64>, mimeType: "image/png" }`，AI 直接看到画布）+ 同时落盘 `<cwd>/exports/<时间戳>.png`，文本 content 里给绝对路径；落盘失败（cwd 不可写）不报错，文本里注明"已返回图片内容，未落盘"。SVG → 不做 image content（客户端普遍不渲染 SVG），返回 SVG 源码文本 + 落盘路径。

**`render` 的 tree 用递归 JSON Schema**：`$defs.node` 定义 `type`（FRAME/RECTANGLE/ELLIPSE/TEXT/INSTANCE 枚举）、`name`/`width`/`height`/`x`/`y`/`fills`（`#RRGGBB[AA]` 字符串数组）/`cornerRadius`/`stroke`/`layout`/`text`/`component`/`children`（`items: { $ref: "#/$defs/node" }`）。AI 免读 render 规格文档直接拼对结构。

## 中继生命周期管理

```
MCP server 启动
  ├─ 探测 ws://localhost:9741（连接超时 ~500ms）
  ├─ 在线 → 复用（外部中继，退出时不动）
  └─ 不在线 → spawn `node <pkg>/bin/cli.js server`（子进程，stdio ignore，
              FLB_PORT 透传）→ 轮询探测等就绪（200ms 间隔，5s 上限）
              └─ 仍不就绪 → 工具调用时报"中继离线"（与手动模式一致）
```

- **spawn 竞争**（多个 MCP 客户端同时拉起，子进程 EADDRINUSE 退出）：下一次探测发现对方中继已上线 → 自然降级为复用，无需专门处理。
- **退出回收**：stdin end / SIGINT / process exit 时，若中继是自己 spawn 的 → SIGTERM 子进程；复用的不动。
- **孤儿自愈**：客户端 SIGKILL 掉 MCP server 时子中继会残留，但下一个 MCP server 启动探测到它会复用——孤儿无害。
- 端口来源：`FLB_PORT`（默认 9741），与 CLI 同一套环境变量。

## 连接层

**长驻 WS + 串行化命令**。中继协议的命令 id 由中继侧分配、客户端消息不携带 id，因此单连接上并发命令无法做客户端侧关联——MCP server 内用 promise 链把命令串行化（一次一条）。AI 的工具调用本质串行，无实际损失。

- 请求-响应：发送 `{ role: "cli", command }`，等待同连接下一条消息即结果（串行化保证唯一）。
- 命令超时：本层 75s 兜底（中继命令超时 60s / 队列 TTL 60s / CLI 侧 70s，取其上）。
- 断线重连：指数退避 1s→2s→…→30s 封顶；重连后进行中的命令按超时报错，新命令走新连接。
- 工具调用前的解析（`resolveFileKey`）与命令共用同一串行通道。

## 文件结构

```
src/mcp/main.js         — stdio JSON-RPC 循环 + 中继生命周期（spawn/探测/回收）（~150 行）
src/mcp/tools.js        — 工具定义表：name/description/inputSchema/handler（~250 行）
src/mcp/connection.js   — 长驻 WS：串行化、超时、指数退避重连（~100 行）
src/relay-client.js     — 从 bin/cli.js 抽出共享逻辑：resolveFileKey、rasterizeSvg（CLI 与 MCP 共用）
bin/cli.js              — 新增 `mcp` 子命令 → require('../src/mcp/main.js').start()
test/mcp.test.js        — 见测试计划
```

CLI 同步小改造：`resolveFileKey`/`rasterizeSvg` 改为从 `src/relay-client.js` 引入，行为不变（服务本次目标的顺带整理，不做无关重构）。

## 错误处理

- 中继离线（探测+拉起失败）→ `isError: "中继离线：请检查 figma-bridge server 或端口 FLB_PORT"`
- 插件不在线/多文件歧义 → 中继的中文错误信息质量很高，**原样透传**（含在线文件清单）
- 插件执行失败 → 透传插件错误文本
- sharp 缺失（import_svg）→ "import_svg 需要可选依赖 sharp（npm i sharp）"（沿用 CLI 文案）
- 图片路径不可读 → `isError: "无法读取图片文件：<path>"`
- 协议层异常（handler 抛错）兜底捕获 → `isError`，不让 MCP server 进程崩溃

## 测试计划（node:test，沿用现有模式）

1. **协议层纯函数**：initialize 响应形状（版本回显/serverInfo/capabilities）；tools/list 返回 16 个工具且 inputSchema 均为合法 JSON Schema 对象；tools/call 分发到 handler；handler 抛错 → `isError: true` + 文本 content；未知方法 → `-32601`；协议级 `ping` → `{}`。
2. **连接层**（对接真实 `createBridgeServer` 工厂实例）：发命令收结果；两条并发命令被串行化且都拿到正确结果；命令超时报错；中继重启后重连成功。
3. **生命周期**：`FLB_PORT=<ephemeral>` 下中继不在 → MCP server spawn 子进程且端口就绪；中继已在 → 复用不拉起；MCP server 退出 → 自己 spawn 的子中继被回收（复用的不受影响）。
4. **工具 handler**（mock connection）：`file` 选择器解析（精确 fileKey / 唯一子串 / 多义报错）；`place_image` 读本地路径转 base64（tmp 文件）；`import_svg` 走栅格化路径；`export_node` PNG 产 image content + 落盘、SVG 产文本 content；`render` 的 tree 原样透传。
5. **端到端**：spawn 真实 MCP server 子进程（stdin/stdout）+ 测试中继 + fetch 长轮询假插件（沿用 `server.test.js` 的假插件模式）→ initialize → tools/list → tools/call(render) → 断言画布结果与 image content。

## 版本与文档

- `package.json` 升 **0.3.0**（minor，非破坏）；CHANGELOG 记录新入口。
- README 新增「MCP 接入」一节：ZCode / Claude Desktop 配置示例（`{"mcpServers": {"figma": {"command": "npx", "args": ["figma-bridge", "mcp"]}}}`）、工具清单简表、与 CLI 的分工说明（MCP 给 AI，CLI 给人调试）。
- `docs/plugin-setup.md` 不受影响（插件零改动）。
