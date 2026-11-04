# sfly Python SDK

- `sfly`：节点运行时，只依赖 Python 标准库（会被安装到 Agent 的共享 venv）。
- `sfly[cli]`：开发者使用的 CLI（`sfly build` / `publish` / `dev`）。
- `sfly/schemas/*.schema.json`：由 `packages/schema`（zod）导出的 JSON Schema，不要手改，运行 `pnpm gen:schema` 重新生成。
