#!/usr/bin/env bash
# 每个 ADR 的四位编号只用一次。两个分支各自从同一个编号开始写 ADR 时，后合入的那个在这里报错，
# 改成 docs/adr/ 里下一个没用过的编号。
set -euo pipefail
cd "$(dirname "$0")/.."

dupes=$(find docs/adr -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.md' -printf '%f\n' | cut -c1-4 | sort | uniq -d)
if [[ -n $dupes ]]; then
	for number in $dupes; do
		echo "ADR 编号 $number 被多个文件使用：" >&2
		find docs/adr -maxdepth 1 -name "$number-*.md" -printf '  %p\n' | sort >&2
	done
	next=$(find docs/adr -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.md' -printf '%f\n' | cut -c1-4 | sort -n | tail -1)
	printf '把后加的那个改成 %04d，并更新引用它的地方。\n' $((10#$next + 1)) >&2
	exit 1
fi
