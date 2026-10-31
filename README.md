# Nomad Concierge

## 运行环境与特殊条件

优先使用 Node.js 直接启动；Node 环境有问题时使用下方 Docker 方式。

- 推荐 Node.js 24；支持 Node 22（至少 22.13.0）、24、26。npm 至少 10。
- 数据库使用 Node 内置 SQLite，不需要另装数据库、Python、make 或 C++ 编译器。Node 方式不需要管理员权限。
- 默认没有大模型配置也能完整运行，理解方式选择“规则”即可。基础操作不需要创建 `.env`。
- 浏览器建议桌面窗口至少 1024px 宽。开发使用 5173（页面）和 3001（API）；生产和 Docker 使用 3001。
- 端到端测试需要先下载 Chromium（约 150 MB）；默认 `npm test` 不需要浏览器。
- Docker 方式需要已安装并运行的 Docker Desktop 或 Docker Engine，以及支持可选 `env_file` 的 Compose 插件。安装 Docker Desktop 本身可能需要管理员权限。
- 可选本地模型需要另外安装 Ollama，并下载约 4.7 GB 的 `qwen2.5:7b-instruct`，预留约 5 GB 模型空间；它不是默认启动条件。

操作验证记录（2026-10-31；完整候选 QA 另行执行）：

| 系统 / 环境 | 实际验证范围 |
| --- | --- |
| macOS arm64，Node 22.13.0 / 24.22.2 | 全新克隆的安装、检查、测试、构建，以及开发和生产模式的浏览器主流程、刷新恢复 |
| Debian 12 arm64，Node 24.22.2，干净 `node:24-bookworm-slim` 容器 | 按 Node 方式安装、检查、测试、构建；生产页面、API、登录、规则回复、SQLite 写入与停机 |
| Debian 12 arm64，Node 24.22.2，干净 `node:24-bookworm` 容器 | 开发页面、API、代理登录、热重载；真实终端 Ctrl+C 后自然退出，未完成的回复在重启后继续且只生成一次 |
| macOS Docker Desktop，Docker Engine 29.8.1 / Compose 5.5.1 | README Compose 路径、生产浏览器主流程、非 root 写库、卷持久化、在途任务停机后续跑且不重复回复 |

Linux 开发模式的进程管理使用系统 `ps` 命令，上述 `bookworm` 环境已提供；极简 `bookworm-slim` 环境的验证范围为 Node 生产模式和 Docker 生产镜像。开发聚合命令在 Ctrl+C 后可能报告 SIGINT/SIGTERM 并返回非零退出状态；上述 Linux 最终实测以 SIGINT 结束，进程自然退出，没有原生崩溃或强杀提示。生产容器停机实测返回 0。Windows 预期兼容，未实测。真实大模型不属于自动测试。

## 方式一：Node 直接启动

在全新克隆的仓库根目录执行。默认无需复制环境配置文件，也无需 Key。

```bash
node --version
npm --version
npm install
npm run dev
```

等待终端首次编译完成、API 和页面服务就绪后，打开 <http://localhost:5173>。健康检查地址为 <http://localhost:3001/api/health>。Vite 将 `/api` 和 `/ws` 转发给 API；用终端的 Ctrl+C 停止开发服务。

安装时可能出现依赖审计提示：本次锁文件有 14 个受影响依赖节点（13 moderate、1 high），已执行一次不带 `--force` 的 `npm audit fix`；剩余修复涉及主版本升级，尚未进行。此数字不是已确认的业务漏洞数量。

生产模式先停止开发服务，再执行：

```bash
npm run build
npm start
```

打开 <http://localhost:3001>。API 同时提供页面、静态资源和 WebSocket；直接打开或刷新 `/c/...`、`/plans/...` 路径也能恢复页面。用 Ctrl+C 停止服务。

启动时自动创建数据目录和 SQLite 文件并执行版本化迁移，不需要额外初始化命令。默认数据库位于 `apps/api/data/nomad.sqlite`（相对 API 工作区）；停止再启动会保留咨询、消息和计划。已有数据库版本高于代码支持版本时拒绝启动。需要隔离数据时，通过 `DATABASE_PATH` 指定另一个文件，不要删除已有数据来排查普通启动问题。

## 方式二：Docker 启动

只需要 Docker，不需要主机安装 Node。先确认 3001 没有被其他服务占用，然后在仓库根目录执行：

```bash
docker compose up --build
```

打开 <http://localhost:3001>。首次构建需要联网下载基础镜像及 npm 依赖。容器使用 Node 24，以 `node` 用户运行；数据库存放在命名卷的 `/data/nomad.sqlite`。

Ctrl+C 停止前台服务；移除容器但保留数据：

```bash
docker compose down
```

再次 `docker compose up` 会使用原有数据。只有明确要清空本项目数据库时，才使用 `docker compose down --volumes`。

Compose 支持可选的 `apps/api/.env` 配置文件，不存在也能启动。访问宿主机 Ollama 时，使用 `LOCAL_LLM_BASE_URL=http://host.docker.internal:11434/v1`；配置已含 Linux 需要的 `extra_hosts: host.docker.internal:host-gateway`，Ollama 仍需允许容器访问其监听地址。

## 检查、测试与评估

在仓库根目录执行：

```bash
npm run check
npm test
npm run build
```

`check` 包括 ESLint 和 TypeScript；`test` 仅运行 shared、API、Web 单元和集成测试，使用临时数据库、随机端口和假的模型服务。

浏览器端到端测试：

```bash
npx playwright install chromium
npm run test:e2e
```

六个覆盖场景：主流程、刷新恢复、多标签同步、停止与补充、专业/无关意图、假远程服务失败后的规则回退。浏览器测试保存录屏和执行轨迹；操作说明及完整业务/环境验收入口见 `qa/README.md`。`test:e2e` 只代表浏览器子集，不能代替完整 QA。

评估规则方案，不调用模型：

```bash
npm run eval --workspace @nomad/api -- --engines rules
```

比较已配置的引擎：

```bash
npm run eval --workspace @nomad/api -- --engines rules,remote,local
```

评估命令与开发、生产启动一样，会加载存在的 `apps/api/.env`；文件不存在时继续运行，进程环境变量优先于文件中的同名配置。未配置或不可用的引擎会明确跳过。报告打印到终端并更新 `docs/eval-results.md`，包含各指标分母、模型与提示词版本；关键标准用例的人工审核状态另列，不把未审核当作已审核。

## 配置与可选模型

环境变量在启动或评估前设置，优先于 API 可选的 `apps/api/.env` 文件。`npm run dev`、`npm start` 和 `npm run eval --workspace @nomad/api` 都会加载该文件；文件不存在也能运行。完整默认值见 `apps/api/.env.example` 和 `docs/SPEC.md` 第 16 节。

| 变量 | 默认值 / 用途 |
| --- | --- |
| `PORT` | API 端口，默认 `3001` |
| `VITE_PORT`、`API_URL` | 开发页面端口与代理目标，默认 `5173`、`http://localhost:3001` |
| `WEB_ORIGIN` | 允许的页面来源，默认 `http://localhost:5173`，多个用逗号分隔 |
| `DATABASE_PATH` | API 工作区下的 `./data/nomad.sqlite`；Docker 为 `/data/nomad.sqlite` |
| `SERVE_WEB_DIST` | 生产模式默认 `true` |
| `DEMO_DELAY_MS` | 默认 `0`，最大 `10000`；给任务阶段加入演示延迟，便于操作停止、补充和重启续跑 |
| `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY` | 远程默认地址 `https://api.deepseek.com`、模型 `deepseek-chat`；Key 为空时不可用 |
| `LOCAL_LLM_BASE_URL`、`LOCAL_LLM_MODEL` | 默认地址 `http://localhost:11434/v1`；模型名为空时不启用 |

远程模型由使用者在自己的环境中设置有效 `LLM_API_KEY` 后启动，页面选择“DeepSeek”或“自动”。开发和自动验收只使用假服务，不需要真实 Key。

可选本地模型由使用者先启动 Ollama 并准备 `qwen2.5:7b-instruct`，再设置 `LOCAL_LLM_MODEL=qwen2.5:7b-instruct` 后启动应用。模型探测异步进行，不阻塞应用启动；未安装模型或服务不可达时，页面显示不可用原因。

例如在 Bash/zsh 的当前命令启用演示延迟（PowerShell 可用 `$env:DEMO_DELAY_MS = '1500'` 后运行 npm）：

```bash
DEMO_DELAY_MS=1500 npm run dev
```

## 逐步验收

以下操作无需大模型。要完整照做第 1～7 步，请先按上面的 Node 方式启动，并打开 <http://localhost:5173>；第 7 步的重启命令也是 Node 方式。使用 Docker 启动时，第 1～6 步的浏览器操作相同，页面地址为 <http://localhost:3001>。

1. 在登录页输入一个 2～32 字符的用户名，点击“进入咨询空间 →”。在右上方“理解方式”中选择“规则”，点击“全家移居葡萄牙”示例卡片，再点击输入框旁的“发送 ↑”。应看到自己的消息、助手回复和需要继续回答的问题。
2. 在“你的国籍是哪个国家？”下面点击“中国”；等下一条回复出现后，在配偶国籍问题下面点击“同本人国籍”。右栏的本人国籍和配偶国籍都应显示“中国”。先把配偶国籍答成中国，下一步再修正它。
3. 在底部输入框输入“不对，配偶是葡萄牙籍。”，点击“发送 ↑”。等回复后，右栏配偶国籍应显示“葡萄牙”，回复中应出现“中国 → 葡萄牙”。刷新浏览器，确认消息、右栏档案和回复下方的过程记录仍在。
4. 复制当前页面地址，在另一个浏览器标签页打开。在其中一页输入“我目前住在中国。”并点击“发送 ↑”，另一页应同步出现这条消息和回复。点击回复下方带“规则”和耗时的摘要，可展开查看处理用时。
5. 等回复完成后，点击右栏底部的“信息不全也可以先生成”。弹窗应列出尚未了解的信息，并提示“生成后这个咨询会结束，不能再补充”。点击“仍然生成”，在计划页面查看第一步、未知项、专业确认边界和资料来源。刷新计划页面，内容应保留；再从左栏“已完成”中打开刚才的咨询，底部应显示“这个咨询已生成计划”，不再显示输入框。
6. 异常场景一：点击左栏“＋ 新建咨询”，输入“我能申请哪个签证”，点击“发送 ↑”，应看到局限说明和影响判断的条件。等回复完成，再输入“今天午饭吃什么”并发送，应看到引导回到咨询主题的提示。
7. 异常场景二：先回到启动服务的终端，按 **Ctrl+C** 停止应用。保持终端位于**仓库根目录**，按自己的系统复制执行以下命令，启用 1500 毫秒的演示延迟。

   macOS / Linux（Bash 或 zsh）：

   ```bash
   DEMO_DELAY_MS=1500 npm run dev
   ```

   Windows PowerShell：

   ```powershell
   $env:DEMO_DELAY_MS = '1500'
   npm.cmd run dev
   ```

   等启动完成后，在浏览器重新打开 <http://localhost:5173>；若出现登录页，使用刚才的用户名进入。点击“＋ 新建咨询”，输入“我想一个人搬到葡萄牙生活。”并点击“发送 ↑”。出现“理解中”等处理提示时，点击旁边的“停止”，应看到“这一轮回复已中断”和“重试”。点击“重试”，等待回复完成。再输入“我是中国籍。”并发送，趁正在回复时输入“我目前住在中国。”并发送；应重新处理补充内容，聊天中两条输入都保留。
8. 可选恢复检查：保持演示延迟开启，正在回复时回到终端按 Ctrl+C，再用第 7 步的同一命令启动；刷新浏览器后，先前的回复应继续完成。然后点击“＋ 新建咨询”→“暂未覆盖的国家”示例→“发送 ↑”，再输入“我是中国籍，想了解居留。”并发送。等回复完成后，点击“信息不全也可以先生成”→“仍然生成”，应看到通用准备清单。

## CI

`.github/workflows/ci.yml` 在 push 和 pull request 时运行，环境为 `ubuntu-latest`，Node 矩阵为精确的 `22.13.0` 和 `24`：`npm ci` → `npm run check` → `npm test` → `npm run build`。不运行浏览器端到端测试，不需要真实模型配置。目前未关联远程仓库，未执行在线 CI，因此不展示执行状态徽标。

## 已知限制：HTTPS 部署

部署到 HTTPS 需要反向代理。应用不设置 `trust proxy`，不信任代理头；Cookie 的 `Secure` 仅在生产环境且请求本身是 HTTPS 时添加。
