# Changelog

## 0.1.1（2026-10-13）

内存与稳定性修复（长时间运行场景）：

- 插件：`placeImage` / `setImageFill` 后调用 `figma.cleanAllImages()` 清理不再被引用的图片字节（此前只增不删，Figma 内存随使用单调上涨）
- 中继：WS 连接补 `error` 监听与 30s ping/pong 心跳（此前 CLI 连接 RST 会以 uncaughtException 打崩进程；半开连接永久滞留）
- 中继：插件长轮询由单槽位改为 Set 登记，多插件实例并存互不覆盖（此前并发 poll 会互相清掉注册并向已断开的连接写响应）
- 中继：队列条目增加 60s TTL 扫描（此前插件失联前入队的命令连同 cliSocket 引用永久滞留）
- 中继：重构为 `createBridgeServer()` 工厂（`require` 不再有启动副作用），新增零依赖 `node:test` 测试套件（9 例）

## 0.1.0（2026-09-22）

首个公开版本：从 OPC 社区平台项目抽取的通用 Figma 本地插件桥。

- 本地中继（WebSocket + 插件侧 fetch 长轮询）
- 声明式节点树渲染（自动布局 / 文本 / 组件实例）
- 结构读取、节点导出（PNG/SVG）、组件化、原型连线、图片/SVG 图标
- `figma-bridge` CLI：server / send / render / export / install-plugin / doctor
