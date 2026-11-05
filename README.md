# sfly

面向内网测试的自动化任务编排平台：在画布上把用户用 Python SDK 开发的节点编排成链，派发到指定的 Agent 上执行。

## 文档

- [GLOSSARY.md](./GLOSSARY.md)：统一术语
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)：架构设计
- [docs/SEMANTICS.md](./docs/SEMANTICS.md)：场景执行语义规范
- [docs/DESIGN-SYSTEM.md](./docs/DESIGN-SYSTEM.md)：前端设计体系（token、组件、状态样式、快捷键、HTTP 契约用法）
- [docs/adr/](./docs/adr/)：架构决策记录

## 开发

工具链：Node 24+（见 `.node-version`）、pnpm 10、Rust stable、protoc、uv；测试需要 PostgreSQL（`DATABASE_URL`，默认 `postgres://sfly:sfly@127.0.0.1:5432/sfly`，需要建库权限）。

| 命令 | 作用 |
|---|---|
| `pnpm bootstrap` | 安装 JS/TS、Rust、Python 依赖 |
| `pnpm gen` | 从 `proto/` 生成 TS 代码，从 `packages/schema` 导出 JSON Schema |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 三种语言的 lint、类型检查、测试 |
| `pnpm proto:breaking` | buf breaking 检查 |
| `pnpm check` | CI 执行的全部检查（GitHub Actions：push 到 `main`、`spec/**`、`impl/**`，PR，以及手动触发；`impl/**` 与手动触发供实现分支在合并前跑 CI） |
| `pnpm test:e2e` | 构建前端并运行 Playwright 端到端测试与视觉回归（`apps/web/e2e`；首次需 `pnpm --filter @sfly/web exec playwright install chromium`） |
| `pnpm test:e2e:docker` | 在 Playwright 官方镜像中运行（与 CI 相同，视觉基线以它为准；加 `--update-snapshots` 更新基线） |
| `pnpm --filter @sfly/server dev` / `pnpm --filter @sfly/web dev` | 启动控制面 / 前端开发服务器（端口 3000，`/api` 代理到控制面） |

## 部署与运维

控制面：`pnpm --filter @sfly/web build` 生成前端构建产物 `apps/web/dist`，控制面在 HTTP 端口上同时提供页面、API 与 SSE（`SFLY_WEB_DIR` 可指定目录），不需要 vite 或额外的 Web 服务器；`pnpm --filter @sfly/server build` 会把 `sdk/python` 打成 SDK 运行时 wheel 放进 `apps/server/dist/sdk/`（或用 `SFLY_SDK_DIR` 指定目录），控制面通过 `GET /sdk/python/<版本>/<wheel>` 提供下载；其余配置见 `apps/server/src/main.ts` 顶部注释（`DATABASE_URL`、`SFLY_PUBLIC_URL`、`SFLY_AGENT_TOKEN`、保留天数与大小上限等）。

Agent：机器上只需要 [uv](https://docs.astral.sh/uv/)。启动参数见 `sfly-agent --help`（`--server`、`--name`、`--token`、`--slots`、`--venv`、`--index-url`、`--python` 等，均可用 `SFLY_*` 环境变量设置）。

- 共享 venv（`--venv`，默认 `./venv`）不存在时，Agent 启动时用 `uv venv` 自动创建（`--python` 指定 Python 版本或解释器，默认由 uv 选择）。
- 连上控制面后，若 venv 里的 SDK 运行时版本与 Agent 自身版本不一致，Agent 从控制面下载同版本的 wheel，校验 sha256 后用 `uv pip install` 安装；版本一致时不重装。控制面没有对应版本的 wheel 时保留现状并在日志里告警。
- 节点包依赖从 `--index-url`（内网 PyPI 镜像）安装。

## 约定

- 主分支：`main`
- 提交信息使用祈使句，简洁说明改动意图
