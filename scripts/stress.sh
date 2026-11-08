#!/usr/bin/env bash
# 复现偶发失败：限制在 2 个 CPU 上（接近 CI 的 2 核 runner）把同一条测试命令重复跑多次，统计失败次数。
#   pnpm test:stress [-n 次数] <命令>...
#   pnpm test:stress -n 60 cargo test --locked -p sfly-agent --test retention
#   pnpm test:stress uv run --locked pytest std/tests/test_stop_process.py
#   pnpm test:stress pnpm --filter @sfly/server exec vitest run test/run-view.test.ts
# 默认跑 30 次；失败那几次的完整输出留在临时目录，看得到断言差异。e2e 用 `pnpm test:e2e:stress`。
# 修复前用它确认能复现，修复后用同样的命令确认失败次数降到 0。需要 taskset（util-linux）。
set -euo pipefail

runs=30
if [[ ${1:-} == -n ]]; then
	runs=$2
	shift 2
fi
[[ ${1:-} == -- ]] && shift
if [[ $# -eq 0 ]]; then
	echo "用法：pnpm test:stress [-n 次数] <命令>..." >&2
	exit 2
fi

logs=$(mktemp -d "${TMPDIR:-/tmp}/sfly-stress.XXXXXX")
failed=0
for ((i = 1; i <= runs; i++)); do
	if taskset -c 0,1 "$@" >"$logs/run-$i.log" 2>&1; then
		rm "$logs/run-$i.log"
	else
		failed=$((failed + 1))
		echo "第 $i 次失败，输出：$logs/run-$i.log" >&2
	fi
done

echo "失败 $failed / $runs 次" >&2
if ((failed == 0)); then
	rmdir "$logs"
else
	exit 1
fi
