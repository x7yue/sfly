#!/usr/bin/env bash
# 在 Playwright 官方镜像中运行前端端到端测试与视觉回归（与 CI 相同的浏览器和字体，视觉基线才可比）。
# 先在本机构建 API 客户端（packages/client/dist，跨域用例里的自建页面加载它）和前端（apps/web/dist），参数原样传给 `playwright test`，例如：
#   pnpm test:e2e:docker                       # 比对
#   pnpm test:e2e:docker --update-snapshots    # 更新视觉基线
# 需要 docker；容器使用宿主网络访问 DATABASE_URL 指向的 PostgreSQL。macOS 上（Docker Desktop）`--network host` 指的是它的虚拟机、
# 不是这台电脑，数据库地址里的 127.0.0.1 / localhost 连不上本机的 PostgreSQL，所以在那里换成 host.docker.internal（Docker Desktop 提供的本机地址）。
# SFLY_VISUAL=0 只跑功能用例（默认 1，含视觉回归）；E2E_DOCKER_FLAGS 给 docker run 加参数（例如 --cpus=2，`pnpm test:e2e:stress` 用）。
# 设置 CI=1，让 playwright.config.ts 采用与 CI 相同的 worker 数、forbidOnly 和报告格式。
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$root/apps/web/node_modules/@playwright/test/package.json').version")

pnpm --dir "$root" --filter @sfly/client --filter @sfly/web build
database_url="${DATABASE_URL:-postgres://sfly:sfly@127.0.0.1:5432/sfly}"
if [[ $(uname) == Darwin ]]; then
	database_url=$(printf '%s' "$database_url" | sed -E 's#@(127\.0\.0\.1|localhost)([:/]|$)#@host.docker.internal\2#')
fi
# E2E_DOCKER_FLAGS 按空白拆成多个参数，所以不加引号。
# shellcheck disable=SC2086
exec docker run --rm --network host --ipc host ${E2E_DOCKER_FLAGS:-} \
	--user "$(id -u):$(id -g)" -e HOME=/tmp -e CI=1 -e SFLY_VISUAL="${SFLY_VISUAL:-1}" \
	-e DATABASE_URL="$database_url" \
	-v "$root:$root" -w "$root/apps/web" \
	"mcr.microsoft.com/playwright:v$version-noble" \
	npx playwright test "$@"
