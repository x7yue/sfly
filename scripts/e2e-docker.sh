#!/usr/bin/env bash
# 在 Playwright 官方镜像中运行前端端到端测试与视觉回归（与 CI 相同的浏览器和字体，视觉基线才可比）。
# 先在本机构建前端（apps/web/dist），参数原样传给 `playwright test`，例如：
#   pnpm test:e2e:docker                       # 比对
#   pnpm test:e2e:docker --update-snapshots    # 更新视觉基线
# 需要 docker；容器使用宿主网络访问 DATABASE_URL 指向的 PostgreSQL。
# 设置 CI=1，让 playwright.config.ts 采用与 CI 相同的 worker 数、forbidOnly 和报告格式。
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$root/apps/web/node_modules/@playwright/test/package.json').version")

pnpm --dir "$root" --filter @sfly/web build
exec docker run --rm --network host --ipc host \
	--user "$(id -u):$(id -g)" -e HOME=/tmp -e CI=1 -e SFLY_VISUAL=1 \
	-e DATABASE_URL="${DATABASE_URL:-postgres://sfly:sfly@127.0.0.1:5432/sfly}" \
	-v "$root:$root" -w "$root/apps/web" \
	"mcr.microsoft.com/playwright:v$version-noble" \
	npx playwright test "$@"
