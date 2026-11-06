# @sfly/web

sfly 的前端：纯 SPA（TanStack Router + TanStack Query、shadcn/ui on Base UI、Tailwind v4、React Flow），构建产物由控制面在同一端口托管（ADR 0006）。

- 架构与页面：`docs/ARCHITECTURE.md` §7
- 设计体系（token、CSS layer、组件清单、状态样式、快捷键注册表、新页面检查清单）：`docs/DESIGN-SYSTEM.md`
- HTTP 契约：`packages/schema/src/http/contract.ts` 文件头；客户端在 `src/lib/api.ts`、`src/lib/sse.ts`

| 命令 | 作用 |
|---|---|
| `pnpm dev` | vite 开发服务器（端口 3000，`/api` 代理到 `SFLY_API_URL`，默认 `http://127.0.0.1:8080`） |
| `pnpm build` | 生成 `dist/`（路由树 `src/routeTree.gen.ts` 在构建时生成） |
| `pnpm test` | 纯逻辑模块的 vitest 单测 |
| `pnpm test:e2e` | 构建后运行 Playwright 端到端测试（`e2e/`，不含视觉回归） |
| `pnpm typecheck` | 源码与 e2e 的类型检查 |

视觉回归只在 Playwright 官方镜像里比对：在仓库根目录运行 `pnpm test:e2e:docker`（加 `--update-snapshots` 更新 `e2e/__screenshots__` 的基线）。
