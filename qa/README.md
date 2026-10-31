# Nomad Concierge QA

当前阶段是准备。测试代码已编写，产品用例全部未执行。只有在集成负责人提供已完成 WP6 的确定候选并通知正式执行后，才运行验收命令。

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

`test-plan.md` 是用例清单，`traceability.md` 是包含具体断言的需求矩阵；`catalog/` 是二者的结构化来源。更新用例后运行 `npm run docs --workspace qa` 重新生成两份文档。`checklists/acceptance.md` 包含人工操作和内部测试证据的移交步骤；`contract-questions.md` 记录已裁定的契约解释；Q-01～Q-03 均已关闭。

## 候选交接

1. 集成负责人组装产品提交与 QA 提交，提供候选完整 SHA、两者的 SHA、WP6 完成声明、声明人以及 SPEC 版本。
2. 在 `qa/candidate.json` 填入 `candidate.example.json` 所示字段。README 与锁文件哈希按候选文件的原始字节计算 SHA-256。模板不是可执行候选声明。
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
| `npm run test:e2e --workspace qa` | 浏览器，一轮，仅定位 |
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

通过、失败、受阻、未执行、跳过、不稳定分别报告；重试通过算不稳定。默认 `retries: 0`，不通过重试掩盖问题。准备报告没有产品通过率。适用人工检查未签认不算通过。MAN-007 按 Q-02 记为不适用，注明不提供 HTTPS 入口且不信任代理头，排除在通过数及通过率分母之外；Secure 四种组合由开发单元测试覆盖，QA 不另建 HTTPS 环境。完整入口产生自动化结果后，还需登记缺陷和人工结果；不能用零缺陷代替执行证据。

缺陷模板见 `defects/TEMPLATE.md`。记录发现时间、优先级、关联需求/用例、候选、复现、预期、实际、证据、开发自测是否已发现及处理状态。报告摘要受版本控制，录屏、日志、HTML、临时编译产物与本地候选声明均忽略。

正式入口固定注入 `QA_READ_OVERFLOW_POLICY=clamp`，API-014 直接断言超界序号返回 200 并夹到 lastSeq，不再提供拒绝分支。

人工登记可通过 `QA_MANUAL_RESULTS` 指向 JSON 文件导入，结构为 `{candidateCommit, results:[{id:"MAN-001", result:"通过", executedAt, executedBy, evidence:["证据路径"], notes}]}`。MAN-005 如确认扫描线索是安全占位，另填 `reviewedClues:[{path,line}]`；只认可同候选、逐条对应的复核。缺陷审阅由 `QA_DEFECT_REVIEW` 指向 `{candidateCommit,reviewedBy,reviewedAt,items:[{id,priority,status,evidence}]}`，`status` 为 `closed` 或经负责人确认的 `accepted`（仅 P2/P3）；无缺陷也须显式登记空数组。适用项缺少登记时报告不可放行。MAN-007 的不适用状态直接来自已裁定目录，无需另行签认，也不允许用未裁定的不适用状态绕过其他检查。

Linux 安装验收容器使用 `--network=none`。Docker 验收保留 README 的 `compose up --build` 命令，通过本轮独立 override 限制构建 RUN 网络、禁止自动拉镜像、使用 internal 网络并清空模型配置；完整缓存必须在准备阶段建立。override 与实际命令属于环境证据，需和未经隔离的人工 README 检查区分。若本机 builder 不能保证基镜像解析也完全离线，应先解决隔离条件并登记受阻，不能把联网构建写作离线验收。
