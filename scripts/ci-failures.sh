#!/usr/bin/env bash
# 只看 CI 里失败的测试：取一次运行失败步骤的日志，去掉每行的 job、步骤、时间戳前缀和颜色码，
# 只打印 vitest、Playwright、pytest、cargo test 的失败块（测试名和断言差异）。
#   scripts/ci-failures.sh <运行 ID> [gh run view 的其他参数，例如 --attempt 1]
# 运行 ID 在 `gh pr checks <PR>` 列出的链接里（.../actions/runs/<运行 ID>/job/...）。
# 一个失败块都没认出来时，打印日志的最后 60 行。
set -euo pipefail

if [[ $# -lt 1 ]]; then
	echo "用法：scripts/ci-failures.sh <运行 ID> [gh run view 的其他参数]" >&2
	exit 2
fi
run=$1
shift

log=$(gh run view "$run" --log-failed "$@" |
	sed -E 's/^[^\t]*\t[^\t]*\t[0-9TZ:.-]+ //; s/\x1b\[[0-9;]*m//g; s/\^\[\[[0-9;]*m//g')

blocks=$(awk '
	# vitest：「Failed Tests N」到汇总行
	/⎯+ Failed Tests [0-9]+ ⎯+/ { on = 1 }
	# Playwright：最后的失败清单「  1) [chromium] ›」到「  N failed」
	/^ *[0-9]+\) \[[a-z]+\] › / && !/##\[error\]/ { on = 1 }
	# pytest：「= FAILURES =」到简短汇总
	/^=+ FAILURES =+$/ { on = 1 }
	# cargo test：「failures:」块
	/^failures:$/ { on = 1 }
	on { print }
	on && (/ Test Files / || /^ *[0-9]+ failed$/ || /^=+ short test summary/ || /^test result: FAILED/) { on = 0; print "" }
' <<<"$log")

if [[ -n $blocks ]]; then
	printf '%s\n' "$blocks"
else
	printf '%s\n' "$log" | tail -60
fi
