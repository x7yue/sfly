#!/usr/bin/env bash
# 复现 e2e 偶发失败：限制在 2 个 CPU 上（接近 CI 的 2 核 runner）重复运行指定用例。
#   pnpm test:e2e:stress <spec[:行号]>... [playwright 参数]
#   pnpm test:e2e:stress e2e/run-drawer.spec.ts:119 --repeat-each=100
# 默认重复 40 次、4 个 worker。偶发失败在这里通常能以 1%–10% 的比例复现；
# 修复后用同样的命令确认失败次数降到 0。只跑功能用例（不设置 SFLY_VISUAL）；需要 taskset（util-linux）。
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)

if [[ $# -eq 0 ]]; then
	echo "用法：pnpm test:e2e:stress <spec[:行号]>... [playwright 参数]" >&2
	exit 2
fi
pnpm --dir "$root" --filter @sfly/client --filter @sfly/web build >/dev/null
cd "$root/apps/web"
# 后面的参数覆盖前面的默认值（例如 --repeat-each=100）。
exec taskset -c 0,1 npx playwright test --repeat-each=40 --workers=4 --reporter=line "$@"
