#!/usr/bin/env bash
# 重型命令（完整测试、连 PostgreSQL 的控制面测试、e2e、pnpm linux 整套、perf、TLC）在同一把锁上排队、前台运行：
#   pnpm heavy [--pg] <命令>...
#   pnpm heavy pnpm test
#   pnpm heavy --pg pnpm --filter @sfly/server test      # 这次运行单独起一个 PostgreSQL 容器，不共用 sfly-pg
#   pnpm heavy pnpm test:e2e:stress e2e/run-drawer.spec.ts:119
#   pnpm heavy --clean                                    # 删掉这个工作区的短目录，和没人在用的 PostgreSQL 容器
#
# 它替你做三件事（做法见 .agents/skills/sfly-implement-spec/references/parallel-work.md）：
# - 在 flock 锁上排队：同一台机器上所有工作区共用一把锁，一次只跑一个重型命令。用 flock -o，锁不会被命令留下的子进程占着。
#   CI（设置了 CI）上每个 job 独占机器，不加锁。macOS 的 flock 来自 Homebrew（brew install flock）。
# - TMPDIR 指向短目录：Unix socket 的路径不能超过 108 字节，系统默认的临时目录太长。
# - Rust 的 CARGO_TARGET_DIR 指向短目录：Agent 的测试把 socket 放在 target/tmp/ 下。
# 短目录按工作区名（检出目录的名字）区分，保留到用 --clean 删除（Rust 编译结果值得留着）。
# 注意：两个同名、位置不同的检出（例如 ~/a/sfly 和 ~/b/sfly）会共用同一对短目录和同一个容器标签，
# 它们同时跑 heavy 时 TMPDIR 会互相踩；检出目录取不同的名字。
#
# --pg：这次运行起一个只给它用的 postgres:18 容器（随机端口、fsync 关闭），把 DATABASE_URL 指过去，结束时删掉。
# 测试支持代码（apps/server/test/support/test-database.ts）本来就只读 DATABASE_URL，并为每个测试文件建一个随机命名的库，
# 所以几个工作区同时跑测试时，各自的连接数不再叠加到共用的 sfly-pg（上限 100）上，不会报 too many clients。
# 需要 docker；`pnpm linux` 用的是它自己的 sfly-linux-pg，不受影响。
# 容器名里带这次运行的 PID（sfly-heavy-pg-<工作区名>-<PID>），--clean 只删 PID 已经不在的容器。
#
# 环境变量（都有默认值）：
#   SFLY_HEAVY_LOCK      锁文件，默认 ~/.t/sfly-heavy.lock（固定位置，不跟着 SFLY_HEAVY_TMP_ROOT 变：
#                        所有工作区必须在同一把锁上排队）；设为 none 不加锁
#   SFLY_HEAVY_TMP_ROOT  短目录的父目录，默认 ~/.t
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=$(basename "$root")
tmp_root=${SFLY_HEAVY_TMP_ROOT:-$HOME/.t}
lock=${SFLY_HEAVY_LOCK:-$HOME/.t/sfly-heavy.lock}
# 每次运行一个 PID 文件：同一个工作区并行的几个 heavy（SFLY_HEAVY_LOCK=none 或 CI）各管各的，先结束的不会删掉别人的。
pid_file_prefix=$tmp_root/$name.heavy.
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
		# 只删已经没有进程在用的东西：这个工作区还有 heavy 在跑时保留短目录；容器只删 PID 已经不在的。
		alive=
		for file in "$pid_file_prefix"*.pid; do
			[[ -e $file ]] || continue
			pid=${file#"$pid_file_prefix"}
			pid=${pid%.pid}
			if kill -0 "$pid" 2>/dev/null; then alive="$alive $pid"; else rm -f "$file"; fi
		done
		if [[ -n $alive ]]; then
			echo "pnpm heavy：这个工作区还有 heavy 在运行（PID$alive），保留 $tmp_dir 和 $target_dir" >&2
		else
			rm -rf "$tmp_dir" "$target_dir"
			echo "pnpm heavy：已删除 $tmp_dir 和 $target_dir" >&2
		fi
		if command -v docker >/dev/null 2>&1; then
			stale=
			for container in $(docker ps -a --filter "label=$pg_label" --format '{{.Names}}' 2>/dev/null || true); do
				if kill -0 "${container##*-}" 2>/dev/null; then
					echo "pnpm heavy：容器 $container 的运行（PID ${container##*-}）还在，保留" >&2
				else
					stale="$stale $container"
				fi
			done
			# shellcheck disable=SC2086
			[[ -z $stale ]] || docker rm -f $stale >/dev/null 2>&1 || true
			[[ -z $stale ]] || echo "pnpm heavy：已删除没人用的 PostgreSQL 容器：$stale" >&2
		fi
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

# 收尾：删这次运行的容器和「有 heavy 在运行」的记号。容器名在 docker run 之前就定好，所以 trap 也要在 docker run 之前设。
container=
docker_pid=
pid_file=
cleanup() {
	# docker run 还在跑（Ctrl-C 落在这期间）：等它跑完，容器建出来之后才删得掉。
	if [[ -n $docker_pid ]]; then wait "$docker_pid" 2>/dev/null || true; fi
	if [[ -n $container ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
	if [[ -n $pid_file ]]; then rm -f "$pid_file"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# 记下这个工作区有 heavy 在运行，--clean 据此保留短目录。嵌套的 pnpm heavy 不记（SFLY_HEAVY_OWNER 已设）。
if [[ -z ${SFLY_HEAVY_OWNER:-} ]]; then
	pid_file=$pid_file_prefix$$.pid
	echo $$ >"$pid_file"
	export SFLY_HEAVY_OWNER=$$
fi

if ((use_pg)); then
	command -v docker >/dev/null 2>&1 || {
		echo "pnpm heavy：--pg 需要 docker" >&2
		exit 1
	}
	# 容器名先记进 container，收尾的 trap 在上面已经设好：Ctrl-C 会让脚本退出并按名字删容器。
	# docker run 放进它自己的进程组（set -m）后台运行：Ctrl-C 发给整个前台进程组，docker CLI 不在里面，不会被先杀掉。
	# 先被杀掉的话，daemon 仍会把容器建出来，那时按名字删已经晚了，--rm 又管不到没启动过的容器。
	# （只忽略 SIGINT 不行：Go 写的 docker CLI 自己注册了 SIGINT 的处理，照样会收到。）
	# 脚本自己收到 SIGINT 时 wait 立刻返回，trap 退出，收尾（cleanup）等 docker run 结束后再删容器。
	container=sfly-heavy-pg-$name-$$
	set -m
	docker run -d --rm --name "$container" --label "$pg_label" -p 127.0.0.1::5432 \
		-e POSTGRES_USER=sfly -e POSTGRES_PASSWORD=sfly -e POSTGRES_DB=sfly \
		postgres:18 -c fsync=off -c max_connections=200 >/dev/null &
	docker_pid=$!
	set +m
	wait "$docker_pid"
	docker_pid=
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
