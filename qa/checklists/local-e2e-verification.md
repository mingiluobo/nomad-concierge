# 本地浏览器入口验证

本地运行，不计入正式放行。2026-10-31 在 macOS arm64、Node 24.22.1、npm 12.1.0 下，仓库外的全新克隆按以下三条命令完成，退出码均为 0，E2E-001～006 共 6/6 通过，失败、跳过、受阻均为 0。

| 顺序 | 在全新克隆根目录执行的命令 | 实测耗时 |
| --- | --- | --- |
| 1 | `npm ci` | 3.816 秒 |
| 2 | `npx playwright install chromium` | 1.059 秒 |
| 3 | `npm run test:e2e` | 29.330 秒 |
| 合计 | 三条命令，无额外构建或候选准备命令 | 34.205 秒 |

Chromium 使用本机已有缓存；上述下载耗时不代表首次下载。npm 安装输出中的依赖审计和安装脚本提示原样保存在安装日志中，本次未改变依赖或执行自动修复。

## 验证来源

QA 分支工作树的产品基线与 main 不同，因此先在临时仓库组装当前 main 产品和本次冻结 QA，再从该提交全新克隆。组装属于验证前的源代码准备，不在验证克隆中覆盖文件或预先安装、构建。验证克隆没有 `.env`、候选声明或 `prepared.json`，开始及三条命令结束后的 Git 工作树均干净。

- 产品来源：`9f35f08d54b9daa307aacc9592d555ddd84a4ba2`（当时 main）。
- QA 来源：`5dde1918c6041f37aa516de3a2777cab5360e976`。
- 临时组装提交：`fb118cf7ec9676abe1f48cf0f4d74d9a6196c4cd`。
- QA 树：`84b905a3982ddc8a0003c6c9324761656d44e11c`。
- 组装相对产品来源仅改变 `qa/`；根 README、SPEC、锁文件哈希见验证 JSON。
- 验证后的交付提交只补充本清单及 README 的实际结果，运行代码与冻结 QA 相同。

## 入口与隔离核验

- 根 `test:e2e` 经 QA 工作区进入本地模式；不读取候选准备指针，不生成正式摘要或放行结果。
- 本地模式按名称排除 `.env` 和 `.env.*`，复制当前代码和安装依赖到临时目录；构建及 QA 编译均由第三条命令完成。验证克隆本身没有新增产品或 QA 的 `dist`。
- 6 个独占应用实例使用动态端口和临时 SQLite，两套模型地址均指向本例的本地假服务；E2E-006 实际执行坏 JSON 回退场景。浏览器请求限制为本例应用地址。
- 6 个应用 PID 均已退出，6 个临时实例目录和构建副本均已清理；内部资源登记文件已移除。仓库外的验证克隆和组装目录也已清理。
- 6 例各有 trace 和录屏，共 6 份 trace、7 段录屏（多标签场景产生两段）。结果、实例证据、HTML 和摘要标注“本地运行，不计入正式放行”；逐例结果为 `candidate=null`、`countsTowardRelease=false`。
- 正式 `prepare:candidate`、业务轮次、环境矩阵及其运行配置未改。原浏览器候选入口保留为 `npm run test:e2e:candidate --workspace qa`。正式报告文件哈希保持不变，本次不更新正式追踪矩阵。
- QA 类型检查、ESLint、恰好 6 例的 `--list` 检查及 Node 路径规范化工具自检通过。路径检查覆盖 110 个文件、13 个 ZIP（含报告附件副本）、1 个 HTML 嵌入 ZIP，没有未处理的本机路径。

- 规范化后实际打开 HTML，六例均可见；抽查 E2E-001 的 trace 展示 354 个动作且 QA Source 可读。7 段视频均已加载并开始播放，原件、集中录屏、HTML 附件字节一致；页面错误为 0。证据查看使用的浏览器和静态服务已关闭，未再运行产品用例。

## 证据位置

- 三命令执行记录：`qa/reports/local-verification/2026-10-31/verification.json`。
- 三命令日志：同目录 `01-command.log`、`02-command.log`、`03-command.log`。
- 本地执行目录：`qa/reports/local/2026-10-31T15-24-46-828Z-2dd41a49/`。
- 本地摘要：本地执行目录的 `summary.md`，分步耗时和资源清理见 `metadata.json`。
- 逐例结果：本地执行目录的 `round-local/results.json`。
- HTML：本地执行目录的 `round-local/html/index.html`。
- 录屏：本地执行目录的 `videos/`；轨迹及附件：`round-local/artifacts/`。
- 路径规范化：本地执行目录及三命令记录目录各自的 `path-audit.json`。
- 报告、轨迹及视频可读性：`qa/reports/local-verification/2026-10-31/artifact-readability.json`。

详细产物默认由 Git 忽略并留存本机；本清单保留可审阅的执行范围、来源、命令与结果。
