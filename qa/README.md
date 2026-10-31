# Nomad Concierge QA

已进入候选验收。当前候选、实际执行范围、缺陷和未完成项以 `reports/summary.md` 为准。只有在集成负责人提供已完成 WP6 的确定候选并通知正式执行后，才运行验收命令；同候选的单轮结果不等于连续三轮通过。

当前修复候选为 `eb2cecbd30571f870876374d429b05ea4eca4a1f`，负责人要求受影响回归加完整业务一轮，环境按影响分析沿用 `39c6bd8`。实际结果、QA自身修正、受阻和人工/交付包待办见 [执行报告](reports/summary.md)、[候选清单](checklists/candidate-eb2cecbd.md) 与 [QA修正记录](checklists/qa-corrections-eb2cecbd.md)。旧候选三轮及环境证据单独保留，不算新候选重新通过。

## 本地浏览器运行（无需候选声明）

全新克隆后，在仓库根目录依次执行：

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

前提是使用项目支持的 Node（22 ≥ 22.13.0、24 或 ≥ 26，推荐 24）及 npm ≥ 10；安装依赖与 Chromium 时需要网络，Linux 还需 Chromium 所需的系统库。无需先启动应用、配置模型、准备数据库、运行构建或创建候选声明。无需 Python、Docker 或 `.env`。

`npm run test:e2e` 等价于 `npm run test:e2e --workspace qa`，固定运行 E2E-001～006 六个核心浏览器场景。入口先复制当前工作树和已安装依赖到自有临时目录（包含未提交的代码改动），按文件名排除所有 `.env` / `.env.*`，再构建产品、编译 QA。每例使用独占应用进程、动态端口、临时 SQLite 和两套假模型服务；模型不会访问真实服务。原工作树不产生构建或数据库文件。运行结束后清理自有应用进程、临时数据库与构建副本；跳过、受阻、失败或实际用例数量不是六条均返回非零退出码。

终端会打印本次目录 `qa/reports/local/<runId>/`，产物为：

| 路径（相对本次目录） | 内容 |
| --- | --- |
| `summary.md`、`metadata.json` | 结果、分步耗时、来源提交与工作树状态、资源清理记录 |
| `round-local/results.json` | 六例逐条结果和证据索引 |
| `round-local/html/index.html` | Playwright HTML 报告 |
| `videos/` | 六个场景的 WebM 录屏 |
| `round-local/artifacts/` | 各场景的 `trace.zip`、附件及失败截图 |
| `build.log`、`compile.log`、`browser.log`、`path-audit.json` | 执行日志与路径规范化核验 |

打开报告：`npm run report --workspace qa -- reports/local/<runId>/round-local/html`。查看轨迹：`npx playwright show-trace qa/reports/local/<runId>/round-local/artifacts/<场景目录>/trace.zip`。报告和录屏由本机保留，默认不提交；其中的路径使用仓库相对路径或临时目录描述。

本地结果统一标注 **“本地运行，不计入正式放行”**，`candidate=null`、`countsTowardRelease=false`。它不读取 `prepared.json`，不修改正式摘要或追踪矩阵。正式验收仍须候选交接和 `prepare:candidate`；原浏览器单独验收入口保留为 `npm run test:e2e:candidate --workspace qa`，覆盖正式完整浏览器集合并校验候选。业务轮次和环境矩阵入口保持不变。

## 准备检查

从仓库根目录运行：

```sh
npm ci
npx playwright install chromium
npm run check --workspace qa
npm run compile --workspace qa
npm run list --workspace qa
```

以上仅安装依赖、准备完整版 Chromium、类型检查、编译和发现用例。`--list` 不创建应用进程。依赖由根锁文件管理；QA 没有新增依赖，也不修改锁文件。

`test-plan.md` 是用例清单，`traceability.md` 是包含具体断言的需求矩阵；`catalog/` 是二者的结构化来源。更新用例后运行 `npm run docs --workspace qa` 生成设计基线；正式执行后按本轮结果回填状态，不能用准备生成命令重置已发布的执行状态。`checklists/acceptance.md` 包含人工操作和内部测试证据的移交步骤；`contract-questions.md` 记录已裁定的契约解释；Q-01～Q-03 均已关闭。

## 单独授权的测试工具自检

收到工具自检授权后，可运行 `npm run self-check --workspace qa`。该入口固定取当时的本地 `main` 提交，克隆到独立临时目录，检查没有环境文件，安装、构建后仅访问 `/api/health`，验证动态端口、临时 SQLite、SIGTERM/SIGKILL 后重启和清理。假模型响应由 QA 直接调用验证，不创建咨询、不发送业务消息、不生成产品计划。

报告自检使用独立配置 `self-check/playwright.config.ts`，仅运行 `TOOLING-REPORT-001`；HTML、JSON、Markdown 及附件写到 `reports/preparation/<runId>/report-preview/`。自检记录 `purpose=tooling-self-check`、`candidate=null`，产品矩阵保持未执行，不覆盖正式摘要或形成放行结论。产品正式入口的候选交接条件保持不变。

`node qa/harness/prepare-node.mjs` 准备 Node 22.13.0/24：优先复用已有版本；缺少最低版本时下载官方发行包并核对 SHA256，文件放在 `qa/reports/toolchains/`，不修改默认 Node 或 shell 配置。环境路径及版本见 `reports/preparation/node-environments.json`，Docker 证据见 `reports/preparation/docker-environment.json`，本次结果见 `checklists/preparation-status.md`。这些准备结果不能代替最终候选的环境矩阵验收。

## 候选交接

1. 集成负责人组装产品提交与 QA 提交，提供候选完整 SHA、两者的 SHA、WP6 完成声明、声明人以及 SPEC 版本。
2. 在 `qa/candidate.json` 填入 `candidate.example.json` 所示字段。README 与锁文件哈希按候选文件的原始字节计算 SHA-256。模板不是可执行候选声明。候选契约复核若仅需调整 QA，可额外指定 `reviewedQaCommit`：准备副本只应用该提交的 `qa/` 树，每轮验证产品仍属原候选、QA 与冻结提交完全相同，并分别记录候选内 QA 和实际执行 QA。
3. 将最终 README 操作命令逐字转录为 `qa/environment-recipe.json`（结构见下文），每一步附原文片段及同一 README 的哈希。模板 README 不能代替最终运行说明。此转录属于 QA 准备工作，不要求开发方读取用例。
4. 准备 macOS Node 22.13.0 和 24 的独立安装，分别设置 `QA_NODE22_BIN`、`QA_NODE24_BIN` 为绝对 node 路径；对应目录中的 npm 必须能使用该 node。准备 Docker、`node:24-bookworm-slim` 镜像及离线 npm/构建缓存。安装及下载阶段可联网，验收过程不调用真实模型。
5. 指定 `QA_ENV_RECIPE` 为配方绝对路径，`QA_LINUX_NPM_CACHE` 为已预热的 Linux npm 缓存目录；提供 `QA_SUBMISSION_ARCHIVE`（tar 可列出的最终提交包）。未提供的环境项记受阻，不跳过、不算通过。
6. 通知正式执行后先执行 `npm run prepare:candidate --workspace qa`。它克隆声明的候选至本轮临时目录，验证提交关系、README/锁文件/SPEC、禁止环境文件，安装锁定依赖与浏览器。此命令仍不运行产品验收。

环境命令配方结构（字段值必须来自最终 README；此处不给尚未交付的文档编造命令）：

```json
{
  "readmeSha256": "<同候选 README 哈希>",
  "node": {
    "install": {"command": "npm", "args": ["<README 参数>"], "readmeText": "<原文>"},
    "initialize": {"command": "npm", "args": ["<README 参数>"], "readmeText": "<原文>"},
    "check": {"command": "npm", "args": ["<README 参数>"], "readmeText": "<原文>"},
    "test": {"command": "npm", "args": ["<README 参数>"], "readmeText": "<原文>"},
    "build": {"command": "npm", "args": ["<README 参数>"], "readmeText": "<原文>"},
    "start": {"command": "npm", "args": ["<README 参数>"], "readmeText": "<原文>"},
    "port": 3001
  },
  "docker": {
    "up": {"command": "docker", "args": ["compose", "up", "--build"], "readmeText": "<原文>"},
    "service": "<README 或 compose 中的服务名>",
    "port": 3001
  }
}
```

自动初始化时可省略 `initialize`，在 MAN-001 登记 README 的说明。若 README 需要复合 shell、其他工具或新的启动布局，QA 应先补适配并编译；不得静默换成猜测的命令。环境子流程只调用根开发自测，不递归调用完整 QA 入口。

## 正式执行

```sh
npm test --workspace qa
```

完整入口在本轮候选副本中 `npm run build`，执行 API/WS/E2E 三轮，再执行环境矩阵一轮，生成 HTML 报告、逐例 JSON、含完整矩阵的 `reports/summary.md`。单轮业务命令及环境命令都使用同样的候选交接前置：

| 命令 | 范围 |
| --- | --- |
| `npm run test:business --workspace qa` | API + WS + E2E，三轮 |
| `npm run test:api --workspace qa` | API，一轮，仅定位 |
| `npm run test:ws --workspace qa` | WS，一轮，仅定位 |
| `npm run test:e2e:candidate --workspace qa` | 完整浏览器集合，一轮，仅定位 |
| `npm run test:env --workspace qa` | 环境，一轮 |

每次执行结束清理本轮候选副本；下一次执行重新准备。`npm run report --workspace qa -- <HTML 报告目录>` 打开指定轮次报告。根 `npm test` 不包括 QA。

## 隔离、时序与证据

- 每个业务用例独占 API 进程、临时 SQLite 文件、动态端口和两套假模型服务。API 进程按允许读取的 package start 命令直接启动 node；SIGKILL/SIGTERM 发给实际 PID。macOS 另核对监听端口归属。不会复用本机未知服务；采用自管 fixture，未启用 Playwright `webServer`。
- 仅继承环境变量白名单；默认清空 `LLM_API_KEY` 和 `LOCAL_LLM_MODEL`，两个模型 URL 强制指向本轮假服务。模型测试只能使用固定假 Key。候选中发现环境文件即拒绝启动，只检查文件名，不读取内容。
- 假服务支持合法 JSON、任意原文、围栏、非法值、HTTP 错误、延迟、挂起、请求队列及模型列表；记录收到的请求。不会代理外部服务。
- 浏览器 HTTP 与 WS 只允许本轮应用地址；同步测试仅延迟真实响应/帧，所有状态来自真实服务。准备后安装命令使用离线缓存；Docker 镜像和完整构建缓存须提前准备，缺缓存应登记受阻，不在验收中下载依赖。
- 业务同步等待公开状态/事件。熔断、上限、重启等通过独占实例隔离。禁止把超时参数不合法导致启动失败报成任务超时。
- 所有 E2E 使用 `channel: 'chromium'`、`video: 'on'`、`trace: 'on'`。核心六场景为 E2E-001～006。视频复制到 `reports/videos/<runId>-r<round>-<case>-<index>.webm`；每轮 artifacts 保留 trace、截图、HTTP 附件、假请求和实际进程配置。
- Docker 固定 3001，串行执行；占用时受阻，不停止别人的进程。容器、项目和数据卷用本轮唯一名字；失败先收集日志再只清理本轮资源。

## 状态与放行

通过、失败、受阻、未执行、跳过、不稳定分别报告；重试通过算不稳定。默认 `retries: 0`，不通过重试掩盖问题。确定属于 QA 断言或工具错误时，保留原始失败、契约依据和修正提交，再完成受影响用例；不能把产品失败改写成 QA 错误。`writeSummary` 的 `round` 模式仅统计一次完整或分段完成的当前轮次，永不据此放行；默认完整模式仍要求三轮。准备报告没有产品通过率。适用人工检查未签认不算通过。MAN-007 按 Q-02 记为不适用，注明不提供 HTTPS 入口且不信任代理头，排除在通过数及通过率分母之外；Secure 四种组合由开发单元测试覆盖，QA 不另建 HTTPS 环境。完整入口产生自动化结果后，还需登记缺陷和人工结果；不能用零缺陷代替执行证据。

缺陷模板见 `defects/TEMPLATE.md`。记录发现时间、优先级、关联需求/用例、候选、复现、预期、实际、证据、开发自测是否已发现及处理状态。报告摘要受版本控制，录屏、日志、HTML、临时编译产物与本地候选声明均忽略。

正式入口固定注入 `QA_READ_OVERFLOW_POLICY=clamp`，API-014 直接断言超界序号返回 200 并夹到 lastSeq，不再提供拒绝分支。

人工登记可通过 `QA_MANUAL_RESULTS` 指向 JSON 文件导入，结构为 `{candidateCommit, results:[{id:"MAN-001", result:"通过", executedAt, executedBy, evidence:["证据路径"], notes}]}`。MAN-005 如确认扫描线索是安全占位，另填 `reviewedClues:[{path,line}]`；只认可同候选、逐条对应的复核。缺陷审阅由 `QA_DEFECT_REVIEW` 指向 `{candidateCommit,reviewedBy,reviewedAt,items:[{id,priority,status,evidence}]}`，`status` 为 `closed` 或经负责人确认的 `accepted`（仅 P2/P3）；无缺陷也须显式登记空数组。适用项缺少登记时报告不可放行。MAN-007 的不适用状态直接来自已裁定目录，无需另行签认，也不允许用未裁定的不适用状态绕过其他检查。

Linux 安装验收容器使用 `--network=none`。Docker 验收保留 README 的 `compose up --build` 命令及运行时网络，只在本轮 override 中禁止自动拉镜像、清空模型配置并把模型地址固定到本地关闭端口；浏览器只访问本轮应用，不宣称运行容器全程强制断网。构建缓存必须提前准备。可用 `QA_DOCKER_BUILDER` 指定准备好的专用 builder，harness 验证其无网络连接且不是 host 网络；`QA_DOCKER_BASE_CONTEXT` 可提供同一 Node 镜像的本地 OCI 布局及 digest，避免基镜像标签解析访问外网。未设置专用 builder 时构建 RUN 使用 `network=none`。本轮 override、镜像哈希、隔离核验与实际命令均留证；离线构建前置不满足时记受阻，不能在验收中下载依赖。

## 本轮追加约定

- 负责人指定 2026-10-31 22:17（Asia/Shanghai）代码冻结。39c6bd8 已按既定三轮执行；其后的修复候选按“受影响用例回归 + 1 轮完整业务套件”执行并在报告注明调整，业务不沿用旧候选通过结果；不受影响的环境按负责人授权沿用并单列来源。
- P0/P1 登记提交后立即通知编号及摘要，继续剩余用例；P2/P3 在轮次结束统一汇报。
- 报告、缺陷、清单、JSON、trace 和 HTML 附件使用仓库相对路径或临时目录描述。规范化及可读性检查见 [路径约定](checklists/path-portability.md)。运行内部指针清理后再处理产物，最终校验值重新生成。
