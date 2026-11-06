#!/usr/bin/env bash
# 发布前检查：提交在 main 上，并且 CI（.github/workflows/ci.yml）对它在 main 上的运行已经成功。
# CI 还在运行时等它结束（最多约 40 分钟）；没有运行记录、失败或被取消时直接失败。
#   scripts/release/wait-ci.sh <提交 SHA>
# 需要 gh（GH_TOKEN 需要 actions: read）和包含 origin/main 的完整克隆。
set -euo pipefail
cd "$(dirname "$0")/../.."

sha=${1:?用法：wait-ci.sh <提交 SHA>}
git fetch --quiet origin main
if ! git merge-base --is-ancestor "$sha" origin/main; then
	echo "提交 $sha 不在 main 上；只发布已合入 main 的提交" >&2
	exit 1
fi

for attempt in $(seq 120); do
	run=$(gh run list --workflow ci.yml --branch main --event push --commit "$sha" --limit 1 \
		--json databaseId,status,conclusion,url --jq '.[0] // empty')
	if [[ -z $run ]]; then
		if ((attempt > 6)); then
			echo "main 上没有提交 $sha 的 CI 运行记录（可能被后续推送取消，或没有触发）" >&2
			exit 1
		fi
	else
		status=$(jq -r .status <<<"$run")
		conclusion=$(jq -r .conclusion <<<"$run")
		url=$(jq -r .url <<<"$run")
		if [[ $status == completed ]]; then
			if [[ $conclusion == success ]]; then
				echo "CI 已通过：$url"
				exit 0
			fi
			echo "CI 没有通过（$conclusion）：$url" >&2
			exit 1
		fi
		echo "CI 运行中（$status），等待：$url"
	fi
	sleep 20
done
echo "等待 CI 超时" >&2
exit 1
