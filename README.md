# dsh-jupyter-notebook

给 **DeepSeek Harness（DSH）** 用的 Jupyter Notebook 集成：Agent 通过 MCP 工具管理 notebook，同时在 Harness 侧栏提供内嵌编辑/查看面板，可浏览、编辑、运行 `.ipynb` 单元格并查看文本和图片输出。Notebook 文件保持标准 `nbformat 4.5`，可继续用 JupyterLab / VS Code 打开。

面板通过 DSH 原生 Client slot 和 Host HTTP 路由提供，另起的面板 Kernel 与 MCP 子进程 Kernel 独立；面板读写的仍是相同磁盘 `.ipynb` 文件。它支持切换 Notebook 根目录、创建文件、增删改 cell、单步或全部运行，以及显示纯文本和 PNG 输出。HTML 输出为安全起见不执行、不渲染。

```
DSH 会话
  └── @deepseek-ai/dsh-mcp-client（DSH 自带）
        └── src/server.mjs        12 个 mcp__jupyter__* 工具，负责 .ipynb 读写与调度
              ├── 本地后端：kernel/dsh_kernel.py   IPython 子进程，零端口、零 token
              └── 服务器后端：src/jupyter-server.mjs
                    REST /api/contents + /api/kernels，执行走 /api/kernels/<id>/channels (WebSocket)
```

## 两种后端

| | 本地后端（默认） | 服务器后端（`connect_server` 后） |
|---|---|---|
| notebook 在哪 | 工作区里的普通文件 | Jupyter Server 上，路径相对 server root |
| 内核 | 本插件起的 IPython 子进程 | 服务器上的内核，**和你 JupyterLab 里打开的是同一个** |
| 变量共享 | 只有本会话 | 与 JupyterLab / 其它客户端共享 |
| 需要什么 | 插件自己的 `.venv` | 一台在跑的 Jupyter Server + token |
| 运行环境 | 固定为本机 venv | 服务器的 Python 环境（`%pip install` 装到那边） |

## 嵌入式面板

面板从侧栏进入，顶部下拉框决定 notebook 的来源：

| 来源 | notebook 在哪 | 内核 |
|---|---|---|
| `本地目录` | 配置根目录或已登记 Workspace 下的文件 | 面板自起的 Python 子进程，与 MCP / JupyterLab 互不共享 |
| `Jupyter 服务` | 本机发现到的 Jupyter Server（读 runtime 文件拿 token），路径相对 server 根目录 | 复用 JupyterLab 已为该 notebook 打开的 kernel；没有则新建。共享时状态栏显示 `与 JupyterLab 共享内核` |
| `连接服务器…` | 手填 URL + token 的 Jupyter Server（远程也行），token 只存在内存里 | 同上 |

两种来源都支持：浏览、新建、打开、重命名、删除、cell 类型切换、保存、插入、删除、上移/下移、清空输出（单格或全部）、单步运行、全部运行、中断、重启内核、停止内核。执行结果写回 notebook（本地写磁盘，服务走 contents API）；PNG 内嵌显示，HTML 只显示安全占位文本。

内核按 notebook 常驻（和 JupyterLab 一样，切走不会丢变量）：工具栏 `停止内核` 主动释放，`重启内核` 清空命名空间，插件卸载时释放面板自己起的那些；服务上共享给 JupyterLab 的内核不会被面板删除。连服务时，没起内核前工具栏提供 kernelspec 下拉，决定这次用哪个内核启动。

执行是流式的：点运行后输出边产生边显示（Host 用 NDJSON 分帧推送，本地内核按行 flush，服务内核走 iopub），单元格标题栏显示 `运行中…`；跑完最后一帧带回整篇 notebook，覆盖运行期间的临时输出。

markdown / raw 单元默认渲染成只读预览（标题、列表、引用、代码块、表格、链接），点正文或标题栏的铅笔图标进入编辑，眼睛图标回到预览。渲染器把内容建成 React 元素，notebook 里的 HTML 永远不会被注入执行；链接只认 http(s) 与相对路径。有未保存修改时，切换 notebook 或来源会先确认。

文件被外部改动时会拒绝用旧 revision 覆盖：本地文件显示 `从磁盘重载`，服务上的 notebook 同样提示冲突，重载即重新读服务。面板只在检测到本机 Jupyter Server 时列出该选项；连不上或 token 不对会在面板顶部报错（错误提示可关闭）。

移动 notebook 到别的目录会释放面板自己起的那个内核（内核的工作目录停在旧目录，继续用会写错相对路径）；同一目录内改名则保留内核。共享给 JupyterLab 的内核只解绑、不删除。

### 已知边界

- 一次只打开一个 notebook，没有多标签页；内核按 notebook 保留，切回不需要重跑。
- HTML 输出只显示占位文本，不渲染（避免把 notebook 里的 HTML 注入页面）。
- markdown 渲染是子集：标题、列表、引用、代码块、表格、链接、粗斜/行内代码；不处理图片、脚注、嵌套列表。
- 单元格只能按按钮上下移动，不支持拖拽排序。
- 与 JupyterLab 同时编辑同一文件时，靠 revision 挡住「基于旧版本保存」；两边都基于同一 revision 时后写的一方生效。
- 远程服务器要手填 token，没有 OAuth / 密码登录流程。
- 面板不提供 notebook 的上传/下载。

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile desktop add dsh-jupyter-notebook
```

或者在 DSH 的 **插件 → 添加插件** 里输入包名 `dsh-jupyter-notebook`。安装后重启 DSH，侧栏就会出现 Notebook 图标。

插件自己起的 Python 内核需要本机有一套 Python 环境（`ipython` + `matplotlib`，数据类 notebook 再加 `pandas`）。默认优先用插件目录下的 `.venv`，找不到时用 `DSH_JUPYTER_PYTHON`：

```bash
python -m venv .venv
.venv/Scripts/python -m pip install ipython matplotlib pandas   # Windows
.venv/bin/python -m pip install ipython matplotlib pandas       # macOS / Linux
```

### 从源码安装

```bash
git clone https://github.com/alice0721021-web/dsh-jupyter-notebook.git
cd dsh-jupyter-notebook
npm install          # MCP 服务端 SDK（只在用 MCP 工具时需要）
```

然后在 Plugin Manager 里安装这个目录。

### 配置

`cordis.patch.yml` 里的 `config.root` 决定面板能浏览的默认根目录，`config.python` 决定面板内核使用的解释器；两者省略时回退到 `DSH_JUPYTER_ROOT` / 进程工作目录 / 包内 `.venv`。要改配置就在 **你的 profile** 的 `cordis.patch.yml` 里覆盖同名 row：

```yaml
- id: dsh-jupyter-notebook
  config:
    root: F:\notebooks
    python: F:\notebooks\.venv\Scripts\python.exe
```

MCP 服务与面板互不替代：`scripts/install.mjs` 只负责写 profile 里那段 `mcp-jupyter` 配置并做一次握手自检，**不装 bundle**；只要 MCP 工具就够时可以只跑脚本，要面板就必须装 bundle。

### 面板 API 的边界

Host 路由 `/api/dsh-jupyter-notebook` 只接受来自本机回环地址、且 `Content-Type: application/json` 的请求；带 `Origin` 头的请求必须也是本机来源。这样别的网站无法用一个简单表单把请求发进来（跨站写文件/执行代码），而面板自身的 `fetch` 不受影响。根目录永远限制在配置目录与已登记 Workspace 之内，服务目标只允许「本机发现到的」或回环地址。

## 工具

| 工具 | 作用 |
|---|---|
| `list_servers` | 发现本机在跑的 Jupyter Server（读 jupyter runtime 目录并探活），列出已连接的服务 |
| `connect_server` | 用 URL（本机可省略 token，自动用 runtime 里的）连上，得到连接名 |
| `disconnect_server` | 忘记一个连接；notebook 和内核都不动 |
| `list_notebooks` | 列目录下的文件夹与 `.ipynb`（带 `server` 时走 contents API） |
| `open_notebook` | 打开或 `create: true` 新建，返回 revision 与 cell 列表（`id`/`rev`） |
| `read_notebook` | 读 cell 全文与输出，可按 `cellIds` 精确读 |
| `edit_notebook` | `insert`/`update`/`move`/`delete`/`set_type`/`clear_outputs`，整批原子生效后立即保存 |
| `execute_cells` | 按顺序或 `all: true` 执行，输出写回 notebook；默认 300s 预算，超时转后台继续 |
| `interrupt_kernel` | 尽力中断当前 cell（本地注入异常；服务器发 `POST /interrupt`） |
| `restart_kernel` | 重启内核清空状态，可 `runAll: true` 直接重跑整篇 |
| `kernel_status` | 打开的 notebook、内核 pid / kernel id、是否与 JupyterLab 共享、已连接的服务 |
| `export_notebook` | 导出 Markdown 或自包含 HTML（图片内嵌），配合 `present` 给用户看 |

## 连接已有的 Jupyter Server

```text
list_servers                       # 本机自动发现：http://localhost:8888/ pid 43188 token: found
connect_server { url: "http://localhost:8888/" }            # 本机：token 从 runtime 文件里取
connect_server { url: "https://host/user/me/", token: "…" } # 远程：token 自己带
list_notebooks { server: "localhost:8888" }
open_notebook { server: "localhost:8888", path: "analysis.ipynb" }
execute_cells { server: "localhost:8888", path: "analysis.ipynb", all: true }
```

细节：

- **发现**：读 `%APPDATA%\jupyter\runtime\jpserver-*.json`（或 `$JUPYTER_RUNTIME_DIR`），
  逐个 `GET /api/status` 探活，死掉的 PID 直接跳过。token 只留在 MCP 服务进程里，不回显。
- **共享内核**：执行前先查 `GET /api/sessions`，如果这个 notebook 已经有会话（JupyterLab 里
  开着），直接用它的 kernel id——所以你在 JupyterLab 里定义的变量，Agent 也能用，反之亦然。
  没会话时才 `POST /api/kernels` 起一个。`kernel_status` 会标 `(shared with JupyterLab)`。
- **执行协议**：`ws(s)://<base>api/kernels/<id>/channels`，发 `execute_request`，
  按 `parent_header.msg_id` 收集 `stream`/`execute_result`/`display_data`/`error`，
  收到 `execute_reply` + iopub `idle` 才算结束。图片（`image/png`）照旧回聊天。
- **保存**：`PUT /api/contents/<path>`，JupyterLab 那边会看到文件变化。
- **base_url**：粘贴 `.../lab?token=xxx` 或 `.../tree` 都能识别，自动裁成 base 并把 token 取出来。
- 连不上/令牌错会明确报「server rejected the token (401/403)」，不会静默换成别的服务器。

## 设计要点

- **cell 身份与乐观锁**：每个 cell 有稳定 `id`，`rev` 是源码的 sha1 前 10 位；`update` 可带
  `expectedRevision`，对不上返回 `revision_conflict` 而不是覆盖。notebook 级 `revision` 同理。
- **整批原子**：`edit_notebook` 的多个操作在内存里全部成功才写盘，任何一步抛错都不落盘。
- **内核按 notebook 隔离**（本地后端）：一个 notebook 一个 Python 进程，cwd 是该 notebook 所在目录，
  所以 `pd.read_csv("data.csv")` 这类相对路径和 Jupyter 里一致；不同 notebook 不会互相污染变量。
- **协议通道防污染**（本地后端）：Python 侧把真正的 stdout `dup` 出来当协议通道，再把 fd 1 指向 stderr，
  用户代码 `os.write(1, ...)` 也破坏不了 JSON 流。
- **输出取舍**：`.ipynb` 里保留 Jupyter 原样的 MIME bundle（`text/plain` + `text/html` +
  `image/png`），聊天侧只取可读的部分：HTML 表格转 Markdown（两条后端各有一份转换器，
  因为本地后端在 Python 里转、服务器后端在 Node 里转），图片转 PNG。
- **图片双通道**：既作为 MCP image 内容回到会话（deepseek-flash 能直接看），也写到
  `<notebook 目录>/.dsh-jupyter/figures/`（服务器后端写到 `<workspace>/.dsh-jupyter/figures/`），
  方便 `present` 或后续引用。

## 环境注记

- **信任边界**：`execute_cells` 能在内核里跑任意代码，权限等于运行 DSH 的那个用户，和原插件
  一样。DSH 的审批策略对 MCP 工具调用同样生效（当前会话是 `never`，即自动放行，相当于免确认）。
  只在你信任的机器与工作区里开这个集成。
- 内核写文件只落在工作区/插件目录。本机上 **Python 子进程写 `%USERPROFILE%` 会被拒绝**
  （`PermissionError: WinError 5`，Node/PowerShell 不受限），所以 `MPLCONFIGDIR` 默认放
  `<插件>/.data/mpl`，图片放 notebook 同目录，不使用用户目录。
- PyPI 直连很慢，装 `ipython`/`matplotlib` 用了清华镜像；`pip install` 卡住时先换源。
- 内核认证：`DSH_JUPYTER_PYTHON` 指定解释器；没设置时按 `--python` → 环境变量 →
  `<插件>/.venv` 的顺序找。

## 开发与测试

```powershell
npm run smoke        # 本地后端：用 @modelcontextprotocol/client 2.2.0（与 DSH 同代）跑完整链路
node scripts/smoke-server.mjs http://127.0.0.1:8899/ smoke-token test   # 服务器后端：连真 Jupyter Server
node scripts/kernel-probe.mjs .\.venv\Scripts\python.exe               # 只测内核协议
```
`scripts/smoke.mjs` 覆盖：建 notebook、批量插入、执行整篇、错误 cell、revision 冲突、
restart、interrupt，最后校验落盘 `nbformat 4.5` 与图片文件。

`scripts/smoke-server.mjs` 覆盖：发现/连接（含错 token 的报错）、contents 读写、经 WebSocket
执行、表格转 Markdown、图片回传、跨工具调用复用内核、restart 后变量确实消失、
复用 JupyterLab 已开会话的内核（`shared with JupyterLab`）、导出、断开。

起一个测试服务器（独立 runtime/data 目录，避免污染真实 JupyterLab）：

```powershell
$env:JUPYTER_RUNTIME_DIR="$PWD\.data\jupyter-runtime"; $env:JUPYTER_DATA_DIR="$PWD\.data\jupyter-data"
.\.venv\Scripts\jupyter-server.exe --no-browser --port 8899 --ServerApp.root_dir="$PWD\.data\server-workspace" --IdentityProvider.token=smoke-token
```

## 目录

```
src/server.mjs         MCP 工具与调度（独立 stdio 服务入口）
index.js               Host 插件：localhost 面板 API bridge
src/panel-service.mjs  面板操作：本地文件读写与独立 Kernel 会话
src/panel-server.mjs   面板操作：Jupyter Server 上的文件与共享 Kernel
client.js              Client 侧栏 Notebook 编辑/查看面板
src/notebook.mjs       nbformat 4.5 读写、cell id、revision
src/kernel.mjs         本地后端：Python 子进程管理、JSON 行协议客户端
src/jupyter-server.mjs 服务器后端：runtime 发现、REST contents/kernels、WebSocket 执行
kernel/dsh_kernel.py   IPython 内核侧车（执行 / 输出捕获 / matplotlib / 中断）
skill/SKILL.md         给 Agent 的工作流提示词
scripts/smoke-panel.mjs  面板本地后端冒烟（真实 Python Kernel）
scripts/smoke-panel-server.mjs 面板服务后端冒烟（临时起一个 Jupyter Server）
scripts/test-markdown.mjs 面板 markdown 渲染器单测
scripts/test-streaming.mjs 面板执行流式输出时序测试
scripts/test-route.mjs 面板 Host 路由：来源校验、分发、流式响应
scripts/smoke.mjs      本地后端端到端冒烟
scripts/smoke-server.mjs 服务器后端端到端冒烟
scripts/install.mjs    写入/更新 profile 里的 MCP 服务配置块
examples/tour.ipynb    测试时生成的演示 notebook
```
