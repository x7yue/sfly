#!/usr/bin/env bash
# 把这个分支相比基准新增或改动的端到端 spec 重复运行几次，让不稳定的用例在合入前暴露，而不是之后在 CI 或 main 上随机失败。
# CI 的 e2e job 在 pull_request 上、完整的一遍测试之后运行它；本地同样可用。
#   pnpm test:e2e:changed [基准，默认 origin/main [Playwright 参数...]]
#   bash scripts/e2e-changed.sh --list [基准 [提交]]    只打印选出的 spec（相对 apps/web，一行一个），不运行
# 基准后面的参数原样交给 Playwright：CI 分片时传 `--shard=i/N`，每片跑重复后的用例里属于自己的那一份。
# 选法：基准与提交（默认 HEAD）的共同祖先到提交之间新增、修改、改名的 apps/web/e2e/**/*.spec.ts（删掉的不算）。
# 只看 spec 文件本身：改了 fixtures.ts、support.ts 之类的公共文件时，自己再加上受影响的 spec。
# 没有选出 spec 时说明原因后成功退出。
#
# 重复次数最多 5，同时让重复运行的用例执行总数不超过 250（视觉回归每条约 0.9 秒，CI 分 4 片时每片约 1 分钟）：
# 改动的用例多时次数减少，但不少于 2。次数按全部改动的用例算，分片只决定每片跑其中哪些。
# 要更多次数、更紧的 CPU 限制，用 `pnpm test:e2e:stress <spec>...`。
# 不构建：CI 里紧跟在 `pnpm test:e2e` 之后；本地先运行一次 `pnpm test:e2e`，或构建 @sfly/client 和 @sfly/web。
# 视觉回归（visual.spec.ts）只在设置了 SFLY_VISUAL=1（CI 已设置）时运行，本地用 `pnpm test:e2e:docker`。
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)

list_only=0
if [[ ${1:-} == --list ]]; then
	list_only=1
	shift
fi
base=${1:-origin/main}
head=HEAD
playwright_args=()
if ((list_only)); then
	head=${2:-HEAD}
elif (($# > 1)); then
	playwright_args=("${@:2}")
fi

# 三个点：与共同祖先比较，基准上后来的提交不算这个分支的改动。
changed=$(git -C "$root" diff --name-only --diff-filter=ACMR "$base...$head" -- ':(glob)apps/web/e2e/**/*.spec.ts')
specs=()
while IFS= read -r path; do
	if [[ -n $path ]]; then
		specs+=("${path#apps/web/}")
	fi
done <<<"$changed"

if ((list_only)); then
	if ((${#specs[@]} > 0)); then
		printf '%s\n' "${specs[@]}"
	fi
	exit 0
fi
if ((${#specs[@]} == 0)); then
	echo "e2e-changed：相比 $base 没有新增或改动的 e2e spec，跳过重复运行。"
	exit 0
fi

cd "$root/apps/web"
tests=$(npx playwright test --list --reporter=list "${specs[@]}" | sed -nE 's/^Total: ([0-9]+) tests? in .*/\1/p')
repeat=$((250 / tests))
if ((repeat > 5)); then repeat=5; fi
if ((repeat < 2)); then repeat=2; fi

echo "e2e-changed：重复运行相比 $base 改动的 ${#specs[@]} 个 spec（共 $tests 条用例）× $repeat 次 ${playwright_args[*]-}："
printf '  %s\n' "${specs[@]}"
exec npx playwright test --repeat-each="$repeat" ${playwright_args[@]+"${playwright_args[@]}"} "${specs[@]}"
