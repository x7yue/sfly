# sfly Python SDK

- `sfly`：节点运行时，只依赖 Python 标准库（会被安装到 Agent 的共享 venv）。
- `sfly[cli]`：开发者使用的 CLI（`sfly build` / `publish` / `dev` / `run`）。
- 本地调试：`sfly.testing.run_node` 在 pytest 里执行节点，`sfly run <节点> --params '<JSON>'` 在命令行执行节点；两者都用 Agent 同一个执行器（`sfly.local`）。
- `sfly/schemas/*.schema.json`：由 `packages/schema`（zod）导出的 JSON Schema，不要手改，运行 `pnpm gen:schema` 重新生成。
