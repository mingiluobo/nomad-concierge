# Nomad Concierge

Nomad Concierge 帮准备出国生活的个人或家庭理清头绪：用户先用一段话描述自己的情况，系统主动追问缺少的关键信息，整理成一份结构化档案，最后生成一份初步行动计划。默认不需要任何大模型 Key；目前只有葡萄牙的详细示例资料，内容仅作演示，不能替代持牌专业人士的意见。

**启动与体验**：按"方式一：Node 直接启动"安装并启动，操作步骤见"逐步验收"。

| 文档 | 内容 |
| --- | --- |
| [DISCOVERY.md](DISCOVERY.md) | 澄清问题和收到的答复 |
| [DECISIONS.md](DECISIONS.md) | 范围、假设、技术选型理由、重要决策、已知限制 |
| [AI_USAGE.md](AI_USAGE.md) | 怎么用 AI 开发，以及怎么检查 AI 的结果 |
| [docs/verification.md](docs/verification.md) | 做了哪些验证、发现了什么问题、怎么处理的 |
| [docs/eval-results.md](docs/eval-results.md) | 规则、DeepSeek、本地模型的效果对比 |
| [docs/SPEC.md](docs/SPEC.md) | 完整技术方案，包括接口（第 11、12 节）和多 agent 开发的分工与关口（第 25、26 节） |

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

如果默认端口已被其他程序占用，可以把页面改为 **5273**、API 改为 **3201**。先按 Ctrl+C 停止已经启动的开发服务，在仓库根目录按自己的系统复制下面整组命令。

macOS / Linux（Bash 或 zsh）：

```bash
export PORT=3201
export VITE_PORT=5273
export API_URL=http://localhost:3201
export WEB_ORIGIN=http://localhost:5273
npm run dev
```

Windows PowerShell：

```powershell
$env:PORT = '3201'
$env:VITE_PORT = '5273'
$env:API_URL = 'http://localhost:3201'
$env:WEB_ORIGIN = 'http://localhost:5273'
npm.cmd run dev
```

这组设置下，打开 <http://localhost:5273>，健康检查地址为 <http://localhost:3201/api/health>。四项设置会保留在当前终端中，按 Ctrl+C 停止后再次启动也会沿用。后面的验收第 7～8 步请继续使用这个终端和页面地址；如果另开终端，先重新执行这四项设置，再执行重启命令。设置只影响当前终端，不会修改系统配置。

安装时可能出现依赖审计提示：本次锁文件有 14 个受影响依赖节点（13 moderate、1 high），已执行一次不带 `--force` 的 `npm audit fix`；剩余修复涉及主版本升级，尚未进行。此数字不是已确认的业务漏洞数量。

生产模式先停止开发服务，再执行：

```bash
npm run build
npm start
```

打开 <http://localhost:3001>；如果当前终端仍保留上面示例的 `PORT=3201`，则打开 <http://localhost:3201>。生产模式由 API 同时提供页面、静态资源和 WebSocket；直接打开或刷新 `/c/...`、`/plans/...` 路径也能恢复页面。用 Ctrl+C 停止服务。

启动时自动创建数据目录和 SQLite 文件并执行版本化迁移，不需要额外初始化命令。默认数据库位于仓库根目录下的 `apps/api/data/nomad.sqlite`（相对 API 工作区为 `./data/nomad.sqlite`）；停止再启动会保留咨询、消息和计划。已有数据库版本高于代码支持版本时拒绝启动。需要隔离数据时，通过 `DATABASE_PATH` 指定另一个文件，不要删除已有数据来排查普通启动问题。

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

本地浏览器端到端测试推荐使用 Node 24，npm 需为 10 或更高版本。安装依赖和 Chromium 时需要联网；Linux 还需预先具备 Chromium 所需的系统依赖。在全新克隆的仓库根目录依次执行：

```bash
npm ci
npx playwright install chromium
npm run test:e2e
```

无需 `.env`、候选声明或预先启动服务，也不调用真实模型；命令会自动准备构建、临时数据库和测试服务。六个覆盖场景：主流程、刷新恢复、多标签同步、停止与补充、专业/无关意图、假远程服务失败后的规则回退。QA 在 macOS、Node 24 的全新克隆中实测三条命令合计约 35 秒，六个场景全部通过；此耗时不含首次浏览器下载，实际耗时因环境和网络而异。

终端会打印本次产物目录 `qa/reports/local/<runId>/`，以下路径均相对于该目录：

| 路径 | 内容 |
| --- | --- |
| `summary.md` | 本次执行结果 |
| `round-local/html/` | HTML 报告，打开其中的 `index.html` 查看 |
| `videos/` | 场景录屏 |
| `round-local/artifacts/` | 执行轨迹及附件 |

这些产物已被 Git 忽略。本地结果标注“本地运行，不计入正式放行”，只覆盖上述六个浏览器场景，不能代替完整 QA。正式浏览器验收入口为 `npm run test:e2e:candidate --workspace qa`，需要先完成候选声明和准备；具体操作、完整业务轮次和环境验收入口见 [QA 说明](qa/README.md)。

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
| `DATABASE_PATH` | 默认数据库位于仓库根目录下的 `apps/api/data/nomad.sqlite`（相对 API 工作区为 `./data/nomad.sqlite`）；Docker 为 `/data/nomad.sqlite` |
| `SERVE_WEB_DIST` | 生产模式默认 `true` |
| `DEMO_DELAY_MS` | 默认 `0`，最大 `10000`；给任务阶段加入演示延迟，便于操作停止、补充和重启续跑 |
| `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY` | 远程默认地址 `https://api.deepseek.com`、模型 `deepseek-chat`；Key 为空时不可用 |
| `LOCAL_LLM_BASE_URL`、`LOCAL_LLM_MODEL` | 默认地址 `http://localhost:11434/v1`；模型名为空时不启用 |

远程模型由使用者在自己的环境中设置有效 `LLM_API_KEY` 后启动，页面选择“DeepSeek”或“自动”。自动测试使用假服务，不需要真实 Key。

没有配置远程或本地模型时，"自动"会使用规则引擎。同一浏览器中，新建咨询会沿用该账号在当前页面地址下上次主动选择的理解方式；在还没有选过的页面地址（例如第一次从开发端口换到生产端口）默认是"自动"。已有咨询沿用各自保存的理解方式。

可选本地模型需要 Ollama 已启动，并已下载 `qwen2.5:7b-instruct`。先按 Ctrl+C 停止正在运行的应用，再在仓库根目录执行下面对应系统的命令；无需 Key，也无需创建配置文件。若之前修改了端口，请继续使用设置过四个端口变量的同一终端。

macOS / Linux（Bash 或 zsh）：

```bash
export LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1
export LOCAL_LLM_MODEL=qwen2.5:7b-instruct
npm run dev
```

Windows PowerShell：

```powershell
$env:LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:LOCAL_LLM_MODEL = 'qwen2.5:7b-instruct'
npm.cmd run dev
```

打开页面并登录，在咨询顶部的“理解方式”中选择“本地模型”，再发送消息。回复下方的处理信息应显示本地模型；如果出现回退提示，则这一轮未由本地模型完成。模型探测异步进行，不阻塞应用启动；刚启动时可稍等再刷新页面。未安装指定模型或服务不可达时，选项置灰并显示原因。以上配置会保留在当前终端，后续重启或运行评估命令时继续生效。真实模型可能返回不合格结果并触发回退；本次三种理解方式的实测对比及局限见 `docs/eval-results.md`。

例如在 Bash/zsh 的当前命令启用演示延迟（PowerShell 可用 `$env:DEMO_DELAY_MS = '1500'` 后运行 npm）：

```bash
DEMO_DELAY_MS=1500 npm run dev
```

## 逐步验收

以下操作无需大模型。要完整照做第 1～7 步，请先按上面的 Node 方式启动，打开启动时的页面地址：默认是 <http://localhost:5173>，自定义端口示例是 <http://localhost:5273>；第 7 步的重启命令也是 Node 方式。使用 Docker 启动时，第 1～6 步的浏览器操作相同，页面地址为 <http://localhost:3001>。

1. 在登录页输入一个 2～32 字符的用户名，点击“进入咨询空间 →”。在右上方“理解方式”中选择“规则”，点击“全家移居葡萄牙”示例卡片，再点击输入框旁的“发送 ↑”。应看到自己的消息、助手回复和需要继续回答的问题。
2. 在“你的国籍是哪个国家？”下面点击“中国”；等下一条回复出现后，在配偶国籍问题下面点击“同本人国籍”。右栏的本人国籍和配偶国籍都应显示“中国”。先把配偶国籍答成中国，下一步再修正它。
3. 在底部输入框输入“不对，配偶是葡萄牙籍。”，点击“发送 ↑”。等回复后，右栏配偶国籍应显示“葡萄牙”，回复中应出现“中国 → 葡萄牙”。刷新浏览器，确认消息、右栏档案和回复下方的过程记录仍在。
4. 复制当前页面地址，在另一个浏览器标签页打开。在其中一页输入“我目前住在中国。”并点击“发送 ↑”，另一页应同步出现这条消息和回复。点击回复下方带“规则”和耗时的摘要，可展开查看处理用时。
5. 等回复完成后，点击右栏底部的“信息不全也可以先生成”。弹窗应列出尚未了解的信息，并提示“生成后这个咨询会结束，不能再补充”。点击“仍然生成”，在计划页面查看第一步、未知项、专业确认边界和资料来源。刷新计划页面，内容应保留；再从左栏“已完成”中打开刚才的咨询，底部应显示“这个咨询已生成计划”，不再显示输入框。
6. 异常场景一：点击左栏“＋ 新建咨询”，输入“我能申请哪个签证”，点击“发送 ↑”，应看到局限说明和影响判断的条件。等回复完成，再输入“今天午饭吃什么”并发送，应看到引导回到咨询主题的提示。
7. 异常场景二：先回到启动服务的终端，按 **Ctrl+C** 停止应用。保持终端位于**仓库根目录**，按自己的系统复制执行以下命令，启用 1500 毫秒的演示延迟。若使用自定义端口，请留在设置了四项端口变量的原终端；以下命令会沿用同一组设置。若另开了终端，先重新执行上面的四项端口设置。

   macOS / Linux（Bash 或 zsh）：

   ```bash
   DEMO_DELAY_MS=1500 npm run dev
   ```

   Windows PowerShell：

   ```powershell
   $env:DEMO_DELAY_MS = '1500'
   npm.cmd run dev
   ```

   等启动完成后，在浏览器重新打开同一个页面地址（默认 <http://localhost:5173>；自定义端口示例 <http://localhost:5273>）；若出现登录页，使用刚才的用户名进入。点击“＋ 新建咨询”，输入“我想一个人搬到葡萄牙生活。”并点击“发送 ↑”。出现“理解中”等处理提示时，点击旁边的“停止”，应看到“这一轮回复已中断”和“重试”。点击“重试”，等待回复完成。再输入“我是中国籍。”并发送，趁正在回复时输入“我目前住在中国。”并发送；应重新处理补充内容，聊天中两条输入都保留。
8. 可选恢复检查：保持演示延迟开启，正在回复时回到同一终端按 Ctrl+C，再用第 7 步的同一命令启动，四项端口设置保持不变；刷新原页面后，先前的回复应继续完成。若换了终端，先重新执行相同的四项端口设置。然后点击“＋ 新建咨询”→“暂未覆盖的国家”示例→“发送 ↑”，再输入“我是中国籍，想了解居留。”并发送。等回复完成后，点击“信息不全也可以先生成”→“仍然生成”，应看到通用准备清单。

## CI

`.github/workflows/ci.yml` 在 push 和 pull request 时运行，环境为 `ubuntu-latest`，Node 矩阵为精确的 `22.13.0` 和 `24`：`npm ci` → `npm run check` → `npm test` → `npm run build`。不运行浏览器端到端测试，不需要真实模型配置。目前未关联远程仓库，未执行在线 CI，因此不展示执行状态徽标。

## 技术选型

前端沿用参考模板的 React 18 + Vite + TypeScript；服务端沿用 Node.js + Express 5 + TypeScript，用 WebSocket 做实时同步；数据库用 Node 内置的 SQLite（`node:sqlite`），不需要另装数据库或编译工具。大模型只负责从用户的话里提取信息，回复和计划由代码生成，结果可控、可测试。选择理由和考虑过的替代方案见 [DECISIONS.md](DECISIONS.md)。

## 新增依赖与第三方服务

| 名称 | 用途 |
| --- | --- |
| `ws` | 服务端 WebSocket，实时推送消息和回复进度 |
| `cookie-parser` | 读取登录 Cookie |
| `react-router-dom` | 前端页面路由 |
| `@playwright/test` | 浏览器端到端测试（只在 `qa/` 中使用） |
| DeepSeek（可选） | 远程大模型，配置 Key 后才会使用 |
| Ollama + `qwen2.5:7b-instruct`（可选） | 本地大模型，需要自己安装并显式开启 |

模板里的 `better-sqlite3` 已移除（它在模板指定的 Node 22.13 上会崩溃，安装还需要编译工具）。

## 说明与已知限制

- **没有认证**：用户名免密进入，只用来区分数据，输入同一个用户名就能看到对应的记录，仅用于演示。
- **规则模式**（不配大模型时）：只认识常见说法和约 45 个国家的名称，可能无法识别复杂句式、错别字和词典外的国家名。
- **HTTPS**：应用本身不提供 HTTPS，部署时需要在前面放一层反向代理。
- **安装时的提示**：`npm ci` 会显示 14 个依赖安全提示（实际对应 4 条公告），npm 11 还会提示跳过了部分依赖的安装脚本。已验证环境下安装和启动成功；依赖风险见 [DECISIONS.md](DECISIONS.md)。

完整的已知限制和改进方向见 [DECISIONS.md](DECISIONS.md)。
