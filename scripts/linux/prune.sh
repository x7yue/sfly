#!/usr/bin/env bash
# 清理 `pnpm linux` 的卷里已经没有主人的工作区副本（#579）。
#
# 卷里每个工作区一个目录 /vol/<工作区路径的哈希>/，里面是工作区副本（work）和 Rust 的编译结果（target），
# 每个 0.7 GB 起、编译过之后几个 GB。工作区（git worktree）删掉之后，这个目录没有人再用，也没有人能再对它
# `pnpm linux --clean`（`--clean` 只清当前工作区自己的）：临时的审查用工作区、做完的任务用的工作区，一个个留下来，
# 一天里攒出几个 GB。
#
# 这里清掉的：
# - 记录了工作区路径（run.sh 每次运行把它写进目录里的 root）、而这个路径在本机已经不存在的；
# - 没有记录路径（这个脚本出现之前建的）、files（每次运行都会更新）超过 SFLY_LINUX_STALE_DAYS 天（默认 14）
#   没动过的：不知道主人是谁，只能按多久没用过判断，删了也只是下次用的时候重新同步、重新编译。
# 不碰：卷里不是工作区副本的目录（cache/ 共享缓存、别人手工放的目录）、`--keep` 指定的那个（当前工作区）。
#
# 用法：prune.sh <卷> <镜像> [--dry-run] [--quiet] [--keep <工作区目录名>]
#   --dry-run  只列出会清理什么，不删
#   --quiet    没有可清理的就什么也不输出（run.sh 每次运行前自动调用时用）
# 在宿主上判断路径还在不在，在一个临时容器里读卷、删目录（和 `pnpm linux --clean` 一样用 postgres 镜像，已经在本机）。
set -euo pipefail

if [[ $# -lt 2 ]]; then
	echo "用法：prune.sh <卷> <镜像> [--dry-run] [--quiet] [--keep <工作区目录名>]" >&2
	exit 2
fi
volume=$1
image=$2
shift 2
dry_run=false
quiet=false
keep=
while [[ $# -gt 0 ]]; do
	case $1 in
	--dry-run) dry_run=true ;;
	--quiet) quiet=true ;;
	--keep)
		keep=${2:?--keep 需要工作区目录名}
		shift
		;;
	*)
		echo "prune.sh：不认识的参数 $1" >&2
		exit 2
		;;
	esac
	shift
done
stale_days=${SFLY_LINUX_STALE_DAYS:-14}

# 卷不存在（还没用过 pnpm linux）：没有可清理的，也不要因为这里把卷建出来。
docker volume inspect "$volume" >/dev/null 2>&1 || exit 0

# 每个工作区副本一行：目录名、files 的修改时间（Unix 秒）、记录的路径（可能是空的）。不统计大小：每次运行都要列，
# 只有真要清理的才数大小。目录名是 12 位十六进制，且有 work 和 files 才算工作区副本。
listing=$(docker run --rm -v "$volume:/vol:ro" --entrypoint sh "$image" -c '
	cd /vol
	for d in *; do
		case $d in *[!0-9a-f]* | "") continue ;; esac
		[ ${#d} -eq 12 ] && [ -d "$d/work" ] && [ -f "$d/files" ] || continue
		root=
		[ -f "$d/root" ] && root=$(cat "$d/root")
		printf "%s\t%s\t%s\n" "$d" "$(stat -c %Y "$d/files")" "$root"
	done')

now=$(date +%s)
stale_before=$((now - stale_days * 86400))
# 要清理的：「目录名:截止时间」。删之前在容器里再看一次 files 的修改时间，早于截止时间才删：
# 路径已经不存在的工作区不会再有运行（截止时间取 now+1，等于不看）；按「多久没用」清理的，列出来之后又有人用了就不删。
targets=()
reasons=()
while IFS=$'\t' read -r name mtime root; do
	[[ -n $name && $name != "$keep" ]] || continue
	if [[ -n $root ]]; then
		[[ -d $root ]] && continue
		targets+=("$name:$((now + 1))")
		reasons+=("工作区 $root 已经不存在")
	else
		((mtime < stale_before)) || continue
		targets+=("$name:$stale_before")
		reasons+=("没有记录工作区路径，$stale_days 天以上没用过")
	fi
done <<<"$listing"

if [[ ${#targets[@]} -eq 0 ]]; then
	$quiet || echo "pnpm linux：卷 $volume 里没有要清理的工作区副本" >&2
	exit 0
fi

# 1 GB 以上写 GB，不到写 MB。
kb_text() {
	awk -v kb="$1" 'BEGIN { if (kb >= 1024 * 1024) printf "%.1f GB", kb / 1024 / 1024; else printf "%d MB", kb / 1024 }'
}

# 清理（或 --dry-run 时只数大小）：容器里先数大小再删，逐行输出「目录名 大小(KB) 状态」。
# 下面两段单引号里的 $d、$kb 是在容器里的 sh 展开的，不是这里。
# shellcheck disable=SC2016
if $dry_run; then
	action='printf "%s\t%s\t%s\n" "$d" "$(du -sk "/vol/$d" | cut -f1)" would-remove'
	mount="$volume:/vol:ro"
else
	action='kb=$(du -sk "/vol/$d" | cut -f1); rm -rf -- "/vol/$d"; printf "%s\t%s\t%s\n" "$d" "$kb" removed'
	mount="$volume:/vol"
fi
result=$(docker run --rm -v "$mount" --entrypoint sh "$image" -c '
	for t; do
		d=${t%%:*}; cutoff=${t#*:}
		case $d in *[!0-9a-f]* | "") continue ;; esac
		[ ${#d} -eq 12 ] && [ -d "/vol/$d/work" ] && [ -f "/vol/$d/files" ] || continue
		[ "$(stat -c %Y "/vol/$d/files")" -lt "$cutoff" ] || continue
		'"$action"'
	done' sh "${targets[@]}")

total=0
count=0
lines=()
while IFS=$'\t' read -r name kb _; do
	[[ -n $name ]] || continue
	for i in "${!targets[@]}"; do
		if [[ ${targets[$i]%%:*} == "$name" ]]; then
			lines+=("  $name  $(kb_text "$kb")  ${reasons[$i]}")
			break
		fi
	done
	total=$((total + kb))
	count=$((count + 1))
done <<<"$result"

if ((count == 0)); then
	$quiet || echo "pnpm linux：卷 $volume 里没有要清理的工作区副本" >&2
	exit 0
fi
if $dry_run; then
	echo "pnpm linux：会清理 $count 个已经没有主人的工作区副本，释放约 $(kb_text "$total")（--dry-run，没有删）：" >&2
else
	echo "pnpm linux：清理了 $count 个已经没有主人的工作区副本，释放约 $(kb_text "$total")：" >&2
fi
printf '%s\n' "${lines[@]}" >&2
