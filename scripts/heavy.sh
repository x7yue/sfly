#!/usr/bin/env bash
# 重型命令（完整测试、连 PostgreSQL 的控制面测试、e2e、pnpm linux 整套、perf、TLC）在同一把锁上排队、前台运行：
#   pnpm heavy [--pg] <命令>...
#   pnpm heavy pnpm test
#   pnpm heavy --pg pnpm --filter @sfly/server test      # 这次运行单独起一个 PostgreSQL 容器，不共用 sfly-pg
#   pnpm heavy pnpm test:e2e:stress e2e/run-drawer.spec.ts:119
#   pnpm heavy --clean                                    # 删掉这个工作区的短目录和没清掉的 PostgreSQL 容器
#
# 它替你做三件事（做法见 .agents/skills/sfly-implement-spec/references/parallel-work.md）：
# - 在 flock 锁上排队：同一台机器上所有工作区共用一把锁，一次只跑一个重型命令。用 flock -o，锁不会被命令留下的子进程占着。
#   CI（设置了 CI）上每个 job 独占机器，不加锁。macOS 的 flock 来自 Homebrew（brew install flock）。
# - TMPDIR 指向短目录：Unix socket 的路径不能超过 108 字节，系统默认的临时目录太长。
# - Rust 的 CARGO_TARGET_DIR 指向短目录：Agent 的测试把 socket 放在 target/tmp/ 下。
# 短目录按工作区名区分，保留到用 --clean 删除（Rust 编译结果值得留着）。
#
# --pg：这次运行起一个只给它用的 postgres:18 容器（随机端口、fsync 关闭），把 DATABASE_URL 指过去，结束时删掉。
# 测试支持代码（apps/server/test/support/test-database.ts）本来就只读 DATABASE_URL，并为每个测试文件建一个随机命名的库，
# 所以几个工作区同时跑测试时，各自的连接数不再叠加到共用的 sfly-pg（上限 100）上，不会报 too many clients。
# 需要 docker；`pnpm linux` 用的是它自己的 sfly-linux-pg，不受影响。
#
# 环境变量（都有默认值）：
#   SFLY_HEAVY_LOCK      锁文件，默认 ~/.t/sfly-heavy.lock；设为 none 不加锁
#   SFLY_HEAVY_TMP_ROOT  短目录的父目录，默认 ~/.t
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=$(basename "$root")
tmp_root=${SFLY_HEAVY_TMP_ROOT:-$HOME/.t}
lock=${SFLY_HEAVY_LOCK:-$tmp_root/sfly-heavy.lock}
tmp_dir=$tmp_root/$name
target_dir=$tmp_root/$name-target
pg_label=sfly-heavy-pg=$name

usage() {
	echo "用法：pnpm heavy [--pg] <命令>...，或 pnpm heavy --clean" >&2
	exit 2
}

use_pg=0
while [[ ${1:-} == --* ]]; do
	case $1 in
	--pg) use_pg=1 ;;
	--clean)
		[[ $# -eq 1 ]] || usage
		rm -rf "$tmp_dir" "$target_dir"
		if command -v docker >/dev/null 2>&1; then
			leftover=$(docker ps -aq --filter "label=$pg_label" 2>/dev/null || true)
			# shellcheck disable=SC2086
			[[ -z $leftover ]] || docker rm -f $leftover >/dev/null 2>&1 || true
		fi
		echo "pnpm heavy：已删除 $tmp_dir、$target_dir 和这个工作区没清掉的 PostgreSQL 容器" >&2
		exit 0
		;;
	--) shift; break ;;
	*) usage ;;
	esac
	shift
done
[[ $# -gt 0 ]] || usage

# 先拿锁，再重新运行自己；嵌套的 pnpm heavy 已在锁里（SFLY_HEAVY_LOCKED），不再排队，否则会自己等自己。
if [[ -z ${SFLY_HEAVY_LOCKED:-} && ${SFLY_HEAVY_LOCK:-} != none && -z ${CI:-} ]]; then
	if ! command -v flock >/dev/null 2>&1; then
		echo "pnpm heavy：找不到 flock。macOS 用 brew install flock 安装；不需要锁时设置 SFLY_HEAVY_LOCK=none" >&2
		exit 1
	fi
	mkdir -p "$(dirname "$lock")"
	if ! flock -n -o "$lock" true; then
		echo "pnpm heavy：另一个重型命令在运行，排队等待 $lock" >&2
	fi
	# 空数组在 macOS 自带的 bash 3.2 里配合 set -u 会报错，所以 --pg 用 ${变量:+…} 传。
	pg_flag=
	((use_pg)) && pg_flag=1
	exec flock -o "$lock" env SFLY_HEAVY_LOCKED=1 bash "$0" ${pg_flag:+--pg} -- "$@"
fi

mkdir -p "$tmp_dir" "$target_dir"
export TMPDIR=$tmp_dir CARGO_TARGET_DIR=$target_dir

if ((use_pg)); then
	command -v docker >/dev/null 2>&1 || {
		echo "pnpm heavy：--pg 需要 docker" >&2
		exit 1
	}
	container=sfly-heavy-pg-$name-$$
	docker run -d --rm --name "$container" --label "$pg_label" -p 127.0.0.1::5432 \
		-e POSTGRES_USER=sfly -e POSTGRES_PASSWORD=sfly -e POSTGRES_DB=sfly \
		postgres:18 -c fsync=off -c max_connections=200 >/dev/null
	trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	for _ in $(seq 120); do
		if docker exec "$container" pg_isready -h 127.0.0.1 -U sfly -q; then break; fi
		sleep 0.5
	done
	docker exec "$container" pg_isready -h 127.0.0.1 -U sfly -q || {
		echo "pnpm heavy：PostgreSQL 容器 $container 一分钟内没有就绪（docker logs $container 查看原因）" >&2
		exit 1
	}
	port=$(docker port "$container" 5432/tcp | head -n1 | sed 's/.*://')
	export DATABASE_URL=postgres://sfly:sfly@127.0.0.1:$port/sfly
	echo "pnpm heavy：这次运行的 PostgreSQL 在 $DATABASE_URL" >&2
fi

# 不用 exec：--pg 时要在命令结束后删容器。
"$@"
