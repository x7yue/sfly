# @sfly/web

sfly 前端：纯 SPA（TanStack Router + TanStack Query，vite 构建，ADR 0006）。

- `pnpm dev`：vite 开发服务器（端口 3000），`/api/*` 代理到控制面（`SFLY_API_URL`，默认 http://127.0.0.1:8080）。
- `pnpm build`：构建到 `dist/`，由控制面托管（`SFLY_WEB_DIR`，默认 `apps/web/dist`），页面、API、SSE 同源同端口。
- `pnpm test:e2e`：Playwright 端到端测试与视觉回归（`e2e/`，ADR 0005）。每个测试启动自己的真实控制面
  （独立数据库、手动时钟，托管 `dist/`），可连接假 Agent，fixture 见 `e2e/fixtures.ts`。视觉基线
  （`e2e/__screenshots__`）只在 Playwright 官方镜像中生成与比对：在仓库根目录 `pnpm test:e2e:docker`
  （加 `--update-snapshots` 更新基线），CI 使用同一镜像；
  直接在本机 `pnpm test:e2e` 时跳过视觉回归（`SFLY_VISUAL=1` 才运行）。
