#!/usr/bin/env bash
# ADR 的两条规则（CODING_STANDARDS.md「文档」），一个脚本检查：
#   1. 编号只用一次。当前文件里重复，或者这个分支新加的 ADR 用了 origin/main 上已被别的文件占用的编号，都报错。
#      PR 不必基于最新的 main，两个分支各自写出同一个编号都能通过 CI，所以还要和 origin/main 比。
#   2. 已接受的 ADR 不改正文。合并基点（HEAD 与 origin/main 的共同祖先）上就有的 ADR，只允许在末尾追加行：
#      改动中间的内容、删除、改名都报错。
# 没有 origin/main 或没有共同祖先（离线克隆、浅克隆）时，只检查当前文件里的编号重复。
set -euo pipefail
cd "$(dirname "$0")/.."

shopt -s nullglob
files=(docs/adr/[0-9][0-9][0-9][0-9]-*.md)
status=0

number_of() { local name=${1##*/}; echo "${name:0:4}"; }

numbers=$(for f in "${files[@]}"; do number_of "$f"; done)
dupes=$(sort <<<"$numbers" | uniq -d)
for number in $dupes; do
	echo "ADR 编号 $number 被多个文件使用：" >&2
	printf '  %s\n' docs/adr/"$number"-*.md >&2
	status=1
done
next=$(sort -n <<<"$numbers" | tail -1)

if ! git rev-parse --verify -q origin/main^{commit} >/dev/null 2>&1 ||
	! base=$(git merge-base HEAD origin/main 2>/dev/null); then
	echo "没有 origin/main 或与它的共同祖先（离线克隆或浅克隆）：只检查当前文件里的编号重复，不和 main 比较。" >&2
	exit "$status"
fi

main_files=$(git ls-tree -r --name-only origin/main -- docs/adr | grep -E '^docs/adr/[0-9]{4}-.*\.md$' || true)
main_next=$(for f in $main_files; do number_of "$f"; done | sort -n | tail -1)
((10#${main_next:-0} > 10#$next)) && next=$main_next
next=$((10#$next + 1))

base_list=$(git ls-tree -r -- "$base" docs/adr | grep -E $'\tdocs/adr/[0-9]{4}-.*\\.md$' || true)

while IFS=$'\t' read -r meta path; do
	[[ -n $path ]] || continue
	hash=$(awk '{print $3}' <<<"$meta")
	if [[ ! -f $path ]]; then
		echo "已接受的 ADR 不能删除或改名：${path}（合并基点上有它，现在没有了）。" >&2
		echo "  推翻一个决定时，写一份新的 ADR，在旧 ADR 末尾追加一行指向它（例如「已被 ADR 0021 取代」），不动旧 ADR 的原有内容。" >&2
		status=1
		continue
	fi
	[[ $(git hash-object "$path") == "$hash" ]] && continue
	size=$(git cat-file -s "$hash")
	if [[ -n $(git cat-file blob "$hash" | tail -c 1) ]] ||
		! cmp -s <(git cat-file blob "$hash") <(head -c "$size" "$path"); then
		echo "已接受的 ADR 的正文被改动：${path}（合并基点上有它，只允许在末尾追加行）。" >&2
		echo "  CODING_STANDARDS.md「文档」：已接受的 ADR 是当时的决定记录，不回头改正文。" >&2
		echo "  推翻一个决定时，写一份新的 ADR，在旧 ADR 末尾追加一行指向它（例如「已被 ADR 0021 取代」）；现行的说明写在 docs/ARCHITECTURE.md、docs/guide/ 和 GLOSSARY。" >&2
		status=1
	fi
done <<<"$base_list"

for path in "${files[@]}"; do
	git cat-file -e "$base:$path" 2>/dev/null && continue
	number=$(number_of "$path")
	for other in $(grep "^docs/adr/$number-" <<<"$main_files" || true); do
		[[ $other == "$path" || -e $other ]] && continue
		echo "ADR 编号 ${number} 在 origin/main 上已被 ${other} 使用，这个分支新增的 ${path} 撞了号。" >&2
		printf '  把 %s 改成 %04d，并更新引用它的地方（先合入最新的 main 能看到全部已用的编号）。\n' "$path" "$next" >&2
		next=$((next + 1))
		status=1
	done
done

exit "$status"
