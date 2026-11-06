# sfly

面向内网测试的自动化任务编排平台：在画布上把用户用 Python SDK 开发的节点编排成链，派发到指定的 Agent 上执行。

## 文档

- [GLOSSARY.md](./GLOSSARY.md)：统一术语
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)：架构设计
- [docs/SEMANTICS.md](./docs/SEMANTICS.md)：场景执行语义规范
- [docs/DESIGN-SYSTEM.md](./docs/DESIGN-SYSTEM.md)：前端设计体系（token、组件、状态样式、快捷键、HTTP 契约用法）
- [docs/adr/](./docs/adr/)：架构决策记录

## 开发

工具链：Node（当前 LTS，主版本只写在 `.node-version`，镜像和打包都读取它）、pnpm 10、Rust stable、protoc、uv；测试需要 PostgreSQL（`DATABASE_URL`，默认 `postgres://sfly:sfly@127.0.0.1:5432/sfly`，需要建库权限）。

| 命令 | 作用 |
|---|---|
| `pnpm bootstrap` | 安装 JS/TS、Rust、Python 依赖，并启用 `.githooks/`：推送分支前运行 gen:check、lint、typecheck、test（跳过用 `git push --no-verify`） |
| `pnpm gen` | 从 `proto/` 生成 TS 代码，从 `packages/schema` 导出 JSON Schema |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 三种语言的 lint、类型检查、测试 |
| `pnpm proto:breaking` | buf breaking 检查 |
| `pnpm check` | CI 执行的全部检查（GitHub Actions：push 到 `main`、`spec/**`、`impl/**`，PR，以及手动触发；`impl/**` 与手动触发供实现分支在合并前跑 CI） |
| `pnpm test:e2e` | 构建前端并运行 Playwright 端到端测试与视觉回归（`apps/web/e2e`；首次需 `pnpm --filter @sfly/web exec playwright install chromium`） |
| `pnpm test:e2e:docker` | 在 Playwright 官方镜像中运行（与 CI 相同，视觉基线以它为准；加 `--update-snapshots` 更新基线） |
| `pnpm test:e2e:stress <spec:行号>` | 复现 e2e 偶发失败：限制在 2 个 CPU 上重复运行（默认 40 次），修复后用同一命令确认失败降到 0。CI 上失败的用例是 check run 注释：`gh api repos/x7yue/sfly/check-runs/<job id>/annotations` |
| `pnpm --filter @sfly/server dev` / `pnpm --filter @sfly/web dev` | 启动控制面 / 前端开发服务器（端口 3000，`/api` 代理到控制面） |
| `pnpm bundle:server` | 构建前端和 SDK wheel，把控制面打成单文件，组装到 `out/server/`（镜像的构建上下文，ADR 0010） |
| `pnpm test:bundle` / `pnpm test:image` | 打包后的控制面与真实 Agent 跑通一条链 / 构建镜像并检查健康检查、页面和 API（都需要先 `pnpm bundle:server`；后者需要 docker 和 psql） |
| `pnpm pack:agent <target>` | 构建并打包 musl 静态链接的 Agent（`x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`，在同架构机器上运行）到 `out/agent/` |
| `pnpm release:version show \| check \| set X.Y.Z` | 查看 / 校验 / 修改版本号（Agent、SDK、控制面共用一个版本号） |

## 发布

推送 `vX.Y.Z` tag 后由 GitHub Actions（`.github/workflows/release.yml`，ADR 0010）发布：

1. 在 `release/X.Y.Z` 分支上运行 `pnpm release:version set X.Y.Z`，开 PR 合入 `main`，等 `main` 上的 CI 通过。
2. `git tag vX.Y.Z <main 上的提交> && git push origin vX.Y.Z`。
3. 工作流检查 tag 与版本号一致、提交在 `main` 上且 CI 已通过，然后构建并发布：
   - 镜像 `ghcr.io/x7yue/sfly-server:X.Y.Z`（另有 `X.Y`、`latest` 标签，linux/amd64 与 linux/arm64）
   - Release 附件：Agent `sfly-agent-X.Y.Z-{x86_64,aarch64}-unknown-linux-musl.tar.gz`、离线镜像 `sfly-server-X.Y.Z-linux-{amd64,arm64}.tar.gz`、SDK `sfly-X.Y.Z-py3-none-any.whl`、`SHA256SUMS`

只支持 `X.Y.Z`，不支持预发布版本（见 ADR 0010）。不使用 Actions Artifacts；失败时直接重新运行工作流，草稿 Release 会被复用。

## 部署与运维

控制面以 Docker 镜像部署（`deploy/docker-compose.yml`，数据库用已有的 PostgreSQL）：

```sh
cd deploy && cp .env.example .env   # 填好 DATABASE_URL、SFLY_PUBLIC_URL 等
docker login ghcr.io                 # 私有镜像：用有 read:packages 权限的个人令牌登录
docker compose up -d
```

- 镜像里是打成单文件的控制面、前端产物、数据库迁移和同版本的 SDK 运行时 wheel；以 `node` 用户运行，数据（节点包、日志、产物）在卷 `/data`，启动时自动执行迁移，健康检查请求 `/api/health`。
- 无法访问 ghcr.io 时，用 Release 附件里的离线镜像：`gunzip -c sfly-server-X.Y.Z-linux-amd64.tar.gz | docker load`。
- 控制面是单进程设计，**同一个数据库只能运行一个实例**；控制面与 Agent 要升级到同一版本（镜像只带同版本的 SDK wheel）。
- 其余配置见 `apps/server/src/main.ts` 顶部注释（保留天数与大小上限等）。
- 需要 TLS 或统一入口时，按 Fastify 官方建议在前面加反向代理。SSE 要关闭代理缓冲；Agent 网关是 gRPC（HTTP/2），要么单独开放 50051，要么用 `grpc_pass` 转发。nginx 示例：

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_buffering off;          # SSE
      proxy_read_timeout 1h;
      client_max_body_size 1g;      # 节点包与产物上传
  }
  ```

不用 Docker 时，在 `.node-version` 指定的 Node 上直接运行 `pnpm bundle:server` 的产物：`node --enable-source-maps out/server/main.mjs`（前端、SDK、迁移目录自动取 `main.mjs` 旁边的 `web/`、`sdk/`、`drizzle/`）。

Agent：从 Release 附件下载对应架构的 `sfly-agent-X.Y.Z-<arch>-unknown-linux-musl.tar.gz`，静态链接，不依赖 glibc 版本（已在 CentOS 7 上验证）。机器上只需要 [uv](https://docs.astral.sh/uv/)，老系统上用 uv 的 musl 版本。启动参数见 `sfly-agent --help`（`--server`、`--name`、`--token`、`--slots`、`--venv`、`--index-url`、`--python` 等，均可用 `SFLY_*` 环境变量设置）。

- Agent 的文件都在 `SFLY_HOME`（默认 `~/.sfly`）下：共享 venv 默认 `$SFLY_HOME/venv`，任务工作目录默认 `$SFLY_HOME/work`，`sfly dev` 用的本地 socket 默认 `$SFLY_HOME/work/agent.sock`，从哪个目录启动都一样。
- 启动时读取 `$SFLY_HOME/agent.env`：每行一个 `KEY=VALUE`，键是参数对应的环境变量名（如 `SFLY_SERVER`、`SFLY_AGENT_NAME`、`SFLY_TOKEN`），`#` 开头的行是注释；命令行参数和环境变量优先于它。`sfly publish` 在没有 `--server` 和 `SFLY_SERVER` 时使用其中的 `SFLY_CONTROL_PLANE_URL`（控制面 HTTP 地址）。
- 连上控制面、收到 Welcome 之后，共享 venv 不存在时用 `uv venv` 自动创建（`--python` 指定 Python 版本或解释器，默认由 uv 选择）。
- 随后若 venv 里的 SDK 运行时版本与 Agent 自身版本不一致，Agent 从控制面下载同版本的 wheel，校验 sha256 后用 `uv pip install` 安装；版本一致时不重装。控制面没有对应版本的 wheel 时保留现状并在日志里告警。
- 节点包依赖从 `--index-url`（内网 PyPI 镜像）安装。

## 约定

- 主分支：`main`，受保护，只能经 PR 以 squash 方式合入；分支命名、PR 与发版规范见 [docs/agents/branching-and-release.md](./docs/agents/branching-and-release.md)
- 提交信息使用祈使句，简洁说明改动意图
