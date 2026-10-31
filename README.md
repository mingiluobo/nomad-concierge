# Nomad Concierge Starter

这是全栈开发测试的可选参考模板。它只包含可运行的前后端工程、SQLite 连接和健康检查，不包含考试业务实现。

使用本模板不是考试要求，也不会获得额外分数。你可以使用自己熟悉的任意语言、框架和数据库，只需满足 `ASSIGNMENT.md` 的技术中立交付要求。

## 环境要求

- Node.js 22.13 或更高版本
- npm 10 或更高版本

项目使用嵌入式 SQLite，无需另外安装或启动数据库服务。

## 启动

```bash
npm install
npm run dev
```

启动后访问：

- Web：`http://localhost:5173`
- API 健康检查：`http://localhost:3001/api/health`

Vite 开发服务器会将 `/api` 请求代理到后端。

## 常用命令

```bash
npm run check
npm test
npm run build
```

单独启动某个应用：

```bash
npm run dev --workspace @nomad/api
npm run dev --workspace @nomad/web
```

## 目录

```text
apps/
  api/   Express、TypeScript、SQLite
  web/   React、TypeScript、Vite
```

## 配置

后端默认配置见 `apps/api/.env.example`。开发环境不复制该文件也能启动。

可用环境变量：

- `PORT`：API 端口，默认 `3001`
- `DATABASE_PATH`：SQLite 文件路径，默认 `./data/nomad.sqlite`
- `WEB_ORIGIN`：允许访问 API 的 Web 地址，默认 `http://localhost:5173`

## 如果选择本模板

请根据题面和需求澄清结果，自行设计业务表、API、Agent 逻辑和页面。你可以调整当前结构或替换辅助库，但需在 `DECISIONS.md` 中说明理由，并保持本地运行步骤清楚可靠。
## 已知限制：HTTPS 部署

部署到 HTTPS 需要反向代理。应用不设置 `trust proxy`，不信任代理头；Cookie 的 `Secure` 仅在生产环境且请求本身是 HTTPS 时添加。
