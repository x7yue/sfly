# sfly

面向内网测试的自动化任务编排平台：在画布上把用户用 Python SDK 开发的节点编排成链，派发到指定的 Agent 上执行。

## 文档

- [GLOSSARY.md](./GLOSSARY.md)：统一术语
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)：架构设计
- [docs/SEMANTICS.md](./docs/SEMANTICS.md)：编排执行语义规范
- [docs/adr/](./docs/adr/)：架构决策记录

## 开发

工具链：Node 24+（见 `.node-version`）、pnpm 10、Rust stable、protoc、uv；测试需要 PostgreSQL（`DATABASE_URL`，默认 `postgres://sfly:sfly@127.0.0.1:5432/sfly`，需要建库权限）。

| 命令 | 作用 |
|---|---|
| `pnpm bootstrap` | 安装 JS/TS、Rust、Python 依赖 |
| `pnpm gen` | 从 `proto/` 生成 TS 代码，从 `packages/schema` 导出 JSON Schema |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 三种语言的 lint、类型检查、测试 |
| `pnpm proto:breaking` | buf breaking 检查 |
| `pnpm check` | CI 执行的全部检查 |
| `pnpm --filter @sfly/server dev` / `pnpm --filter @sfly/web dev` | 启动控制面 / 前端 |

## 约定

- 主分支：`main`
- 提交信息使用祈使句，简洁说明改动意图
