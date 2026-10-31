# 证据路径规范化

提交中的 QA 文档与证据只保留仓库相对路径；执行时的系统临时根改写为“临时目录”，保留独占目录标识和文件名；用户工具安装根改写为“用户目录”，保留工具版本。路径替换不改变请求、响应、事件 ID、时间、状态、缺陷结论或执行计数。

历史证据中记录的 SHA-256 对应执行时的原始文件，不能用于声明路径规范化后文件的字节未变。正式运行完成后应对最终发布证据重新生成校验值。运行中的内部目录指针不属于发布证据，不能在执行期间改写。

`qa/harness/sanitize-paths.ts` 提供纯文本与递归 JSON 规范化函数；CLI 只处理显式列出的 `qa/` 文本产物，默认不遍历目录，不处理压缩包。`--check` 只检查，`--apply` 写回；必须提供 `--repository-root`，额外执行根通过 `--map FROM=TO` 传入。

`qa/harness/sanitize-artifacts.py` 用 Python 标准库递归处理指定运行目录：普通文本、JSON/JSONL、trace ZIP 内文本、HTML 中的 base64 报告 ZIP 及其数据附件。图片、视频和其他二进制内容保持原字节；HTTP 路由和信号名称不作为文件路径改写。容器仓库根、缓存和系统工具路径在证据中描述化，源码中的正常系统路径常量保留。

Trace Viewer 根据栈帧文件名的 SHA-1 查找 `src/<hash>.<ext>` 或 `resources/src@<hash>.txt`。改写源文件显示路径时，同步重映射相应压缩包条目，保留资源引用；每个处理后的 ZIP 都检查 CRC，原为 JSON 的内容保持可解析。

工具自检只创建合成产物，不启动产品、不计入产品用例或放行轮次：

```sh
python3 qa/harness/sanitize-artifacts.py self-test --target qa/reports/path-portability-self-test
```

全部执行结束并清理运行资源后，从仓库根目录对明确的产物目录运行；`QA_BUILD_ROOT` 用于提供该次候选根的映射，`QA_EVIDENCE_DIR` 指向待发布运行目录：

```sh
python3 qa/harness/sanitize-artifacts.py check --repository-root "$PWD" --candidate-root "$QA_BUILD_ROOT" --target "$QA_EVIDENCE_DIR"
python3 qa/harness/sanitize-artifacts.py apply --repository-root "$PWD" --candidate-root "$QA_BUILD_ROOT" --target "$QA_EVIDENCE_DIR"
python3 qa/harness/sanitize-artifacts.py check --repository-root "$PWD" --candidate-root "$QA_BUILD_ROOT" --target "$QA_EVIDENCE_DIR"
```

`check` 不改产物，但写检查记录；退出码 1 表示仍有待规范化内容，2 表示规范化后还有未解决路径。`apply` 写回并记录各文件前后哈希。两种审计文件分开保存，避免复检覆盖改写记录。仍在使用的运行配置不得处理；脚本遇到 `prepared.json` 会拒绝执行。最终发布文件的校验值须在规范化后生成，并以独占本地报告服务复核 HTML 和 trace 可读取性。

## eb2cecbd 修复候选

业务实际执行 QA 为 `77bfd88`，完整业务一轮；产物整理阶段另修正了路径工具对 CLI“相对父目录 + 已知绝对根”的处理，避免替换后留下错误的 `..qa/` 前缀。同时保留源文件中合法相对 import。该修改只影响报告路径，不改变产品用例或执行结果。

工具自检：`qa/reports/path-portability-tool/self-test-relative-root/self-test-result.json`；本轮路径审计、HTML/trace 查看器验证及最终证据哈希均在 `qa/reports/2026-10-31T13-36-03.597Z-122febfa/`。首次定向失败、修正后复验与完整业务结果分目录保留；不以规范化操作抹去失败或受阻。
