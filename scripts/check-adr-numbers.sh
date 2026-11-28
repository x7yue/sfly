#!/usr/bin/env bash
# ADR 的三条规则（CODING_STANDARDS.md「文档」），一个脚本检查：
#   1. 编号只用一次。当前文件里重复，或者这个分支新加的 ADR 用了基准分支上已被别的文件占用的编号，都报错。
#      PR 不必基于最新的基准分支，两个分支各自写出同一个编号都能通过 CI，所以还要和基准分支比。
#   2. 已接受的 ADR 不改正文。合并基点（HEAD 与基准分支的共同祖先）上就有的 ADR，只允许在末尾追加行：
#      改动中间的内容、删除、改名都报错。
#   3. 推翻要留指针。这个分支新加的 ADR 写了「取代 / 推翻 / 修订 ADR 00NN」（「不会取代」「无意取代」这类否定不算，
#      「见 ADR 00NN」这类普通引用也不算；只认动词和编号连着写的句子，别的写法抓不到），ADR 00NN 就要在末尾追加一行
#      提到新编号（例如「已被 ADR 0027 取代」，部分取代的写清是哪一部分）。
#      那句话其实不需要指针时，在新 ADR 里写一行 `<!-- 不加指针 ADR 00NN：原因 -->` 放行（原因必填）。
# 基准分支：环境变量 ADR_BASE_REF（CI 中为 PR 的目标分支），默认 origin/main。
# 没有基准分支或没有共同祖先（离线克隆、浅克隆）时，只检查当前文件里的编号重复。
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

base_ref=${ADR_BASE_REF:-origin/main}
if ! git rev-parse --verify -q "$base_ref^{commit}" >/dev/null 2>&1 ||
	! base=$(git merge-base HEAD "$base_ref" 2>/dev/null); then
	echo "没有 ${base_ref} 或与它的共同祖先（离线克隆或浅克隆）：只检查当前文件里的编号重复，不和它比较。" >&2
	exit "$status"
fi

main_files=$(git ls-tree -r --name-only "$base_ref" -- docs/adr | grep -E '^docs/adr/[0-9]{4}-.*\.md$' || true)
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

# 「取代 / 推翻 / 修订 ADR 00NN」，可以连着写几个（顿号和「和 / 与 / 及」连起来的，「取代 ADR 0001 和 ADR 0002」；
# 逗号之后不再算，「修订 ADR 0001，ADR 0002 不受影响」只管 0001），ADR 前面可以有 ** 、「 、[ 。
# 动词前面、同一个分句里（上一个标点之后）出现 不 / 未 / 没 / 无 / 非 / 勿 的，当作否定，不检查
# （不会取代、无意取代、不是要推翻、并非修订）。别的写法（「ADR 0001 已被本决定取代」、动词和编号隔得远）抓不到：
# 这是个弱检查，宁可漏报不误报。
# 汉字后面的 ? 和 * 要先放进括号（`(了)?`），中文标点不放进方括号（用 `(：|:)`）：C 语言环境里 macOS 的 grep 按字节算，
# `了?` 只管最后一个字节，`[：:]` 是三个字节各算一个字符，表达式就匹配不上或者多匹配。
supersede_re='(取代|推翻|修订)(了)?[[:space:]]*((\*\*|「|\[)[[:space:]]*)*ADR[[:space:]]*[0-9]{4}([[:space:]]*(、|和|与|及)[[:space:]]*(ADR[[:space:]]*)?[0-9]{4})*'
clause_end='，|。|；|：|,|;|:|！|？|!|\?'

# 新 ADR（$1）写了取代、推翻或修订哪些合并基点上已有的 ADR，那些 ADR 的全文里有没有一行提到它（编号 $2）。
# 看全文而不只是合并基点之后追加的行：指针可能在更早合入的提交里就写好了。新编号比所有旧 ADR 都大，旧正文不会无故提到它。
check_pointers() {
	local path=$1 number=$2 hit line rest match before clause phrase target old seen=" "
	while IFS= read -r hit; do
		line=${hit%%:*}
		rest=${hit#*:}
		while match=$(grep -oE "$supersede_re" <<<"$rest" | head -n 1 || true); [[ -n $match ]]; do
			before=${rest%%"$match"*}
			rest=${rest#*"$match"}
			clause=$(sed -E "s/.*($clause_end)//" <<<"$before")
			case $clause in *不* | *未* | *没* | *无* | *非* | *勿*) continue ;; esac
			phrase=$match
			while IFS= read -r target; do
				[[ $target == "$number" || $seen == *" $line:$target "* ]] && continue
				seen+="$line:$target "
				old=(docs/adr/"$target"-*.md)
				# 没有这个编号的 ADR（写错了），或者它也是这个分支新加的（想怎么改都行）：没有旧 ADR 要留指针。
				if [[ ! -e ${old[0]:-} ]] || ! git cat-file -e "$base:${old[0]}" 2>/dev/null; then continue; fi
				grep -qE "<!--[[:space:]]*不加指针[[:space:]]+ADR[[:space:]]*${target}[[:space:]]*(：|:)[[:space:]]*[^[:space:]>-]" "$path" && continue
				grep -qE "ADR[[:space:]-]*${number}([^0-9]|$)" "${old[0]}" && continue
				echo "${path}:${line} 写了「${phrase}」，但 ${old[0]} 末尾没有指向 ADR ${number} 的一行。" >&2
				echo "  在 ${old[0]} 末尾追加一行（只追加，不改正文），写明是 ADR ${number} 取代、推翻还是修订了它，部分取代的写清是哪一部分，例如「已被 ADR ${number} 取代」。" >&2
				echo "  这句话只是普通引用、不需要指针时，在 ${path} 里加一行 <!-- 不加指针 ADR ${target}：原因 -->（原因必填）；普通引用写「见 ADR ${target}」，不会触发这条检查。" >&2
				status=1
			done < <(grep -oE '[0-9]{4}' <<<"$phrase")
		done
	done < <(grep -nE "$supersede_re" "$path" || true)
}

for path in "${files[@]}"; do
	git cat-file -e "$base:$path" 2>/dev/null && continue
	number=$(number_of "$path")
	for other in $(grep "^docs/adr/$number-" <<<"$main_files" || true); do
		[[ $other == "$path" || -e $other ]] && continue
		echo "ADR 编号 ${number} 在 ${base_ref} 上已被 ${other} 使用，这个分支新增的 ${path} 撞了号。" >&2
		printf '  把 %s 改成 %04d，并更新引用它的地方（先合入最新的 %s 能看到全部已用的编号）。\n' "$path" "$next" "$base_ref" >&2
		next=$((next + 1))
		status=1
	done
	check_pointers "$path" "$number"
done

exit "$status"
