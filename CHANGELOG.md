# Changelog

## 0.2.0（2026-10-22）

多文件路由（破坏性协议变更，插件与中继需一起升级）：

- 中继：插件会话化（hello 携带 fileKey/instanceId，下发 sessionId），命令按 `target.fileKey` 路由；无 target 时恰好一个文件在线自动路由、多个在线报错并附清单
- 中继：session TTL 驱逐（默认 90s）与每会话队列上限（默认 50），失联会话的排队/在途命令即时释放
- 中继：/result 按 sessionId 校验归属，防跨会话串话；无 sessionId 的 poll 返回 400
- CLI：新增 list-files；send/render/export 支持 --file <fileKey 或文件名唯一子串>；doctor 逐文件检查版本一致性
- 插件：hello/poll/result 携带会话标识，sessionExpired 或 relayBootId 变化自动重握手
- 升级动作：`figma-bridge install-plugin` 后重启插件；doctor 可验证
- 中继：查询串安全解码（畸形编码返回 400，不再可能崩溃进程）；会话数上限（64）防异常堆积
- CLI：--file 精确 fileKey 命中多个会话时投递最近活跃会话（对齐中继路由语义）
- 插件：握手未获 sessionId（如对接旧版本中继）时退避重试，不再热循环

## 0.1.2（2026-10-13）

- 中继：`/poll` 响应携带 `relayBootId`（每次启动随机生成的实例标识）
- 插件：检测到 `relayBootId` 变化即重新 `/hello` 握手（修复中继秒级重启时插件观察不到断线、导致 doctor 版本一致性检查显示 null 的问题；hello 失败自动重试；旧插件忽略新字段，完全兼容）

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
