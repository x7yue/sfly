#!/usr/bin/env bash
# 从标准输入读候选 tag（每行一个），输出同一系列里比当前版本小的最大者；没有时不输出。
#   gh release list --exclude-drafts --exclude-pre-releases --limit 1000 --json tagName --jq '.[].tagName' |
#     scripts/release/previous-tag.sh <vX.Y.Z | std-vX.Y.Z>
#
# 用途：
# - Release 变更列表的起点（release.yml / std-release.yml，gh release create --notes-start-tag 等）。
#   平台（vX.Y.Z）与 sfly-std（std-vX.Y.Z）的版本号各自独立：不指定起点时 GitHub 自己挑上一个 tag，
#   可能跨系列选到另一边的 tag，变更列表的范围就错了（#121）。
# - previous-agent.sh 选「上一个 Release 的 Agent」。
# 候选应是已发布（非草稿、非预发布）的 Release 的 tag，而不是所有 git tag：v* tag 推送后不能删除，
# 发版失败被放弃的 tag 不能当起点，否则那段改动不会出现在任何已发布 Release 的说明里。
# 只看同一前缀的 X.Y.Z tag，按语义版本比较（0.0.10 > 0.0.9）；其他形式的 tag 忽略。
set -euo pipefail

current=${1:-}
current=${current#refs/tags/}
if [[ $current =~ ^(std-v|v)([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
	prefix=${BASH_REMATCH[1]}
	version=${BASH_REMATCH[2]}
else
	echo "tag 必须是 vX.Y.Z 或 std-vX.Y.Z：$current" >&2
	exit 1
fi

# 当前版本混进列表一起排序，取排在它前面的最后一个。
previous=$(
	sed -nE "s/^${prefix}([0-9]+\.[0-9]+\.[0-9]+)\$/\1/p" |
		{ cat; echo "$version"; } | sort -uV | sed -n "/^${version//./\\.}\$/q;p" | tail -n1
)
if [[ -n $previous ]]; then
	echo "$prefix$previous"
fi
