# sfly Python SDK

- `sfly`：节点运行时，只依赖 Python 标准库（会被安装到 Agent 的共享 venv）。
- `sfly[cli]`：开发者使用的 CLI（`sfly init` / `build` / `publish` / `dev` / `run` / `skill update`）。
- 本地调试：`sfly.testing.run_node` 在 pytest 里执行节点，`sfly debug <节点> --params '<JSON>'` 在命令行执行节点；两者都用 Agent 同一个执行器（`sfly.local`）。
- `sfly/schemas/*.schema.json`：由 `packages/schema`（zod）导出的 JSON Schema，不要手改，运行 `pnpm gen:schema` 重新生成。
- `sfly/cli/skills/sfly-node-dev/`：`sfly init` 写进项目的节点开发 skill。两个文件是指向用户文档 `docs/guide/` 的软链接（`SKILL.md` → `skills/sfly-node-dev/SKILL.md`，`reference.md` → SDK 参考页 `sdk-reference.md`），构建 wheel 时打进内容；改 skill 或 SDK 参考只改 `docs/guide/` 里的源文件。
