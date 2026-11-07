#!/usr/bin/env bash
# 输出同一系列里上一个发布 tag，作为 Release 变更列表的起点（gh release create --notes-start-tag）；没有时不输出。
#   scripts/release/previous-tag.sh <vX.Y.Z | std-vX.Y.Z>
#
# 平台（vX.Y.Z，release.yml）与 sfly-std（std-vX.Y.Z，std-release.yml）的版本号各自独立：
# 不指定起点时 GitHub 自己挑上一个 tag，可能跨系列选到另一边的 tag，变更列表的范围就错了（#121）。
# 所以只在同一前缀的 X.Y.Z tag 里，按语义版本取比当前小的最大者（0.0.10 > 0.0.9）；其他形式的 tag 忽略。
# 在当前目录所在的 git 仓库里查 tag（工作流里 checkout 要 fetch-depth: 0 才有全部 tag）。
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
	git tag --list "${prefix}*" |
		sed -nE "s/^${prefix}([0-9]+\.[0-9]+\.[0-9]+)\$/\1/p" |
		{ cat; echo "$version"; } | sort -uV | sed -n "/^${version//./\\.}\$/q;p" | tail -n1
)
if [[ -n $previous ]]; then
	echo "$prefix$previous"
fi
