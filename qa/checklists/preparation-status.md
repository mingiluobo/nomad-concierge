# 测试工具自检与环境准备记录

日期：2026-10-31（Asia/Shanghai）。范围：用户单独授权的工具自检和环境准备。候选尚未交接；产品用例执行数 0，产品缺陷判定数 0。

## 测试工具自检

- main 快照：`ff46ab7ad9388165769cf0f99eb5b22dadb28f75`；QA 准备基线：`0825d1c`；运行 Node `v24.22.1`。
- 独立克隆检查未含环境文件，`npm ci` 和 `npm run build` 完成。没有运行根开发自测或产品 QA 套件。
- 应用在动态端口 `60064` 启动；核对实际 API PID 和监听归属。临时文件具有 SQLite 文件头，重启保留同一文件。
- 实际 API PID：`66465 → 66468 → 66471`；分别验证 SIGTERM 后重启、SIGKILL 后启动，旧 PID 已退出。访问产品的唯一接口为 `/api/health`。
- 假模型服务的 JSON、原文、HTTP 500、模型列表响应及请求记录均检查完成，未访问真实模型。
- 独立 `TOOLING-REPORT-001` 验证 body/file 两种附件、HTML 和 JSON；再检查 Markdown 摘要生成。报告明确自检用途，产品矩阵仍未执行，未授予放行。
- 本轮 API、假服务、数据库及克隆目录已清理，证据保留。没有工具阻塞；没有据此判定产品缺陷。

证据目录：`qa/reports/preparation/tooling-2026-10-31T09-29-15.060Z-c73815da/`。含 `self-check.json`、安装/构建日志、假服务记录、实例配置和进程日志、`report-preview/`。最新入口为 `qa/reports/preparation/latest-self-check.json`。

## 运行环境

| 环境 | 实际结果 | 版本与路径/证据 |
| --- | --- | --- |
| macOS Node 22.13.0 | 已准备 | Node `v22.13.0` / npm `10.9.2`；`qa/reports/toolchains/node-v22.13.0-darwin-arm64/bin/node`；官方发行包 SHA256 与 SHASUMS 一致 |
| macOS Node 24 | 已准备 | Node `v24.22.1` / npm `12.1.0`；`/Users/zcm/.nvm/versions/node/v24.22.1/bin/node`；复用已有安装 |
| Docker | 可用 | Docker Engine `29.8.1`，Docker Desktop `4.93.0`，`desktop-linux` / `linux/arm64` |
| node:24-bookworm-slim | 已拉取并验证可启动 | digest `sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`；无网络、自动删除容器内 Node `v24.22.2` / npm `11.19.1`；确认本轮容器已删除 |

默认 Node 仍为 `v26.13.0`，未修改默认运行环境、全局配置或依赖锁文件。Node 的完整绝对路径及校验值见 `qa/reports/preparation/node-environments.json`；Docker 命令、镜像和清理证据见 `qa/reports/preparation/docker-environment.json`。

环境受阻项：无。本次只准备了工具、Node 运行环境和 Docker 基础镜像，最终候选的 Linux 离线依赖缓存、Docker 产品构建缓存及四项环境验收仍须在候选交接后单独记录，不能复用为产品通过结果。

状态：继续等待候选交接通知。
