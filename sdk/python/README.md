# sfly Python SDK

- `sfly`：节点运行时，只依赖 Python 标准库（会被安装到 Agent 的共享 venv）。
- `sfly[cli]`：开发者使用的 CLI（`sfly init` / `build` / `publish` / `dev` / `debug` / `skill update`，以及操作平台的 `scenario` / `run` / `agent` / `package` / `api`）。
- 本地调试：`sfly.testing.run_node` 在 pytest 里执行节点，`sfly debug <节点> --params '<JSON>'` 在命令行执行节点；两者都用 Agent 同一个执行器（`sfly.local`）。
- `sfly/schemas/*.schema.json`：由 `packages/schema`（zod）导出的 JSON Schema，不要手改，运行 `pnpm gen:schema` 重新生成。
- `sfly/cli/skills/<名称>/`：`sfly init` 写进项目的两份 skill（`sfly-node-dev` 节点开发、`sfly-platform` 操作平台）。里面的文件是指向用户文档 `docs/guide/` 的软链接（`SKILL.md` → `skills/<名称>/SKILL.md`；`reference.md` → 对应的文档页：`sdk-reference.md` 或 `platform-cli.md`），构建 wheel 时打进内容；改 skill 或这两页文档只改 `docs/guide/` 里的源文件。
