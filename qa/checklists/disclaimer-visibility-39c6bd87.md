# 免责声明可见性补充回归

故障注入反馈指出：仅检查 DOM 文本，无法发现免责声明被 CSS 隐藏。现有三个 E2E 用例增加 7 处 `toBeVisible()`，保留原文字校验；未新增编号，未修改产品代码。

- 候选：`39c6bd879eb147e568bb92530423d687bd674601`；产品：`bed75ee8e0a8c9e098a8e7a395dd65030f548a64`；执行 QA：`8899c38cbacee2b6c479960b1b794aa67859ca0d`。
- 依据：候选 SPEC §13.5 的工作台常驻免责声明条及计划详情免责声明；使用共享 TID。
- 独立副本无环境文件；完成 npm ci、QA 编译、生产构建。每例使用自有进程、动态端口、临时数据库和本地假服务。执行前后核对产品未改、QA 树与冻结提交一致。
- 类型检查、修改文件的 ESLint 及 diff 检查通过。运行命令（候选 qa 工作目录）：`npx --no-install playwright test --project=e2e --grep 'E2E-(001|007|016)\b'`。
- 结果：3/3 通过，失败/受阻/跳过/不稳定均为 0，retries=0。仅受影响用例补充回归，不新增或改写此前正式三轮统计；新增可见性断言仅在本次补充执行一次。

| 用例 | 新增可见性检查点 | 结果 | trace 与视频 |
| --- | --- | --- | --- |
| E2E-001 | 空状态、咨询中、结束后的工作台免责声明条；完整计划页免责声明。 | 通过 | `qa/reports/videos/2026-10-31T12-58-09.778Z-9021514b-rvisibility-E2E-001-1.webm`<br>`qa/reports/2026-10-31T12-58-09.778Z-9021514b/round-visibility/artifacts/e2e-journeys-E2E-001-登录、示例、快捷回答、修正与完整计划-e2e/trace.zip` |
| E2E-007 | 提前生成的通用计划页免责声明。 | 通过 | `qa/reports/videos/2026-10-31T12-58-09.778Z-9021514b-rvisibility-E2E-007-1.webm`<br>`qa/reports/2026-10-31T12-58-09.778Z-9021514b/round-visibility/artifacts/e2e-journeys-E2E-007-提前生成确认、未知项与通用国家清单-e2e/trace.zip` |
| E2E-016 | 计划详情首次载入及真实整体重同步后的免责声明。 | 通过 | `qa/reports/videos/2026-10-31T12-58-09.778Z-9021514b-rvisibility-E2E-016-1.webm`<br>`qa/reports/2026-10-31T12-58-09.778Z-9021514b/round-visibility/artifacts/e2e-synchronization-E2E-016-计划详情页首次连接和整体重同步内容完整-e2e/trace.zip` |

证据：`qa/reports/2026-10-31T12-58-09.778Z-9021514b/round-visibility/results.json`、`qa/reports/2026-10-31T12-58-09.778Z-9021514b/metadata.json`、`qa/reports/2026-10-31T12-58-09.778Z-9021514b/execution.log`；清理：`qa/reports/2026-10-31T12-58-09.778Z-9021514b/cleanup.json`。三个 API 进程、数据库目录及本轮候选副本均已清理。路径规范化审计：`qa/reports/2026-10-31T12-58-09.778Z-9021514b/path-apply.json`、`qa/reports/2026-10-31T12-58-09.778Z-9021514b/path-check.json`。

本次结果覆盖上述检查点的元素可见性和既有文字要求；不替代既定人工验收与最终交付包检查。整体放行状态保持原报告中的待办结论。
