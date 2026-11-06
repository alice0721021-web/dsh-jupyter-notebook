# Changelog

## 0.4.1 — 2026-11-07

- Host 路由接入 DSH Connection 认证（`connection.requestRejection`），并对未提供 Connection 服务的环境 **fail-closed**：面板 API 不再只靠来源判断。
- 路由测试补充认证闸门用例（缺服务 401、Connection 拒绝透传、通过后继续）。
- README 的安全边界说明同步更新。

## 0.4.0 — 2026-11-06

- 面板新增「Jupyter 服务」来源：自动发现本机 Jupyter Server，复用 JupyterLab 已打开的 kernel；也可手填 URL + token 连接远程服务。
- 执行改为流式输出（Host 用 NDJSON 分帧，本地内核按行 flush，服务内核走 iopub）。
- 新增内核控制：停止内核、kernelspec 选择；切换到别的目录时自动释放已失效的内核。
- 新增 cell 级操作：上移 / 下移、清空单格或全部输出。
- 新增 notebook 级操作：重命名、删除。
- markdown / raw 单元渲染预览（安全子集，不注入 HTML），支持点击进入编辑。
- 未保存修改在切换 notebook / 来源时二次确认；错误提示可关闭。
- Host 路由增加请求闸门：仅接受本机回环 + `application/json`，`Origin` 必须是本机来源。
- 两个后端共用 `src/notebook-view.mjs` 的输出投影，避免视图漂移。
- 测试：markdown 渲染、执行流式时序、Host 路由（含安全闸门与流式），本地 / 服务两套端到端冒烟。

## 0.3.0

- 首个带内嵌面板的版本：本地目录浏览、cell 编辑与运行、PNG 输出、revision 冲突保护。
- 保留原有 12 个 MCP 工具（`mcp__jupyter__*`）与本地 / Jupyter Server 两种后端。
