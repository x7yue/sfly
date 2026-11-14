#!/usr/bin/env bash
# `pnpm linux <命令>`：在与 CI 相同工具链的 Linux 容器里运行命令。Agent 只能在 Linux 上编译（inotify），
# 它的测试、clippy 检查测试代码、在 Agent 上运行的节点，在 macOS 上都要这样验证。例如：
#   pnpm linux pnpm test:rust
#   pnpm linux pnpm lint:rust
#   pnpm linux bash -c 'cargo test --locked -p sfly-agent --test file_write'
#   pnpm linux --clean            # 删掉这个工作区在容器卷里的副本和编译结果
#
# - 镜像（scripts/linux/Dockerfile）按需构建，Dockerfile、版本或镜像源变了自动重建；Node、pnpm、Python 的版本取自仓库。
#   官方源访问不了时，在 ~/.config/sfly/linux.env 里每行写一个 `键=地址`，键是 Dockerfile 里带默认值的 ARG。
# - 每次运行把工作区里已提交和未提交（未被忽略）的文件同步进 docker 卷 sfly-linux 里这个工作区的副本，命令在副本里运行：
#   宿主的工作区只读挂载，不会被改动，命令产生的文件也留在副本里。依赖装在副本里，Rust 的编译结果按工作区保留。
# - 测试用的 PostgreSQL 是单独的容器 sfly-linux-pg（与 CI 相同的 postgres:18 和账号）。命令和它共用网络，
#   DATABASE_URL 是 postgres://sfly:sfly@127.0.0.1:5432/sfly，与 CI 一致。
# - 默认限制在 4 个 CPU（与 CI 的 runner 相同），用 SFLY_LINUX_CPUS 改。
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

volume=sfly-linux
pg=sfly-linux-pg
pg_image=postgres:18
# 每个工作区（worktree）一份副本。
id=$(printf '%s' "$root" | git hash-object --stdin | cut -c1-12)

if [[ $# -eq 0 ]]; then
	echo "用法：pnpm linux <命令> [参数…]，或 pnpm linux --clean" >&2
	exit 2
fi
if [[ $1 == --clean ]]; then
	docker run --rm -v "$volume:/vol" --entrypoint rm "$pg_image" -rf "/vol/$id"
	echo "pnpm linux：已删除 $root 在卷 $volume 里的副本" >&2
	exit 0
fi

node_major=$(tr -d '[:space:]' <.node-version)
python_version=$(tr -d '[:space:]' <.python-version)
pnpm_version=$(sed -nE 's/.*"packageManager": *"pnpm@([^"]+)".*/\1/p' package.json)
actionlint_image=$(sed -n 's/^image=//p' scripts/lint-actions.sh)
args=(
	--build-arg "NODE_MAJOR=$node_major" --build-arg "PYTHON_VERSION=$python_version"
	--build-arg "PNPM_VERSION=$pnpm_version" --build-arg "ACTIONLINT_IMAGE=$actionlint_image"
)
mirrors=${XDG_CONFIG_HOME:-$HOME/.config}/sfly/linux.env
if [[ -f $mirrors ]]; then
	while IFS= read -r line || [[ -n $line ]]; do
		[[ $line =~ ^[[:space:]]*(#|$) ]] && continue
		args+=(--build-arg "$line")
	done <"$mirrors"
fi
image=sfly-linux:$({
	cat scripts/linux/Dockerfile
	printf '%s\n' "${args[@]}"
} | git hash-object --stdin | cut -c1-12)
if ! docker image inspect "$image" >/dev/null 2>&1; then
	echo "pnpm linux：构建镜像 $image（第一次要几分钟）" >&2
	docker build -t "$image" "${args[@]}" - <scripts/linux/Dockerfile >&2
fi

if ! docker container inspect "$pg" >/dev/null 2>&1; then
	docker run -d --name "$pg" -e POSTGRES_USER=sfly -e POSTGRES_PASSWORD=sfly -e POSTGRES_DB=sfly "$pg_image" >/dev/null
elif [[ $(docker container inspect -f '{{.State.Running}}' "$pg") != true ]]; then
	docker start "$pg" >/dev/null
fi
for _ in $(seq 120); do
	if docker exec "$pg" pg_isready -h 127.0.0.1 -U sfly -q; then break; fi
	sleep 0.5
done
docker exec "$pg" pg_isready -h 127.0.0.1 -U sfly -q || {
	echo "pnpm linux：PostgreSQL 容器 $pg 一分钟内没有就绪（docker logs $pg 查看原因）" >&2
	exit 1
}

# 要同步的文件：已提交和未提交、未被忽略的文件（已经从工作区删掉的不算）。
sync=$(mktemp -d)
trap 'rm -rf "$sync"' EXIT
git ls-files -z -co --exclude-standard | while IFS= read -r -d '' file; do
	if [[ -e $file || -L $file ]]; then printf '%s\0' "$file"; fi
done >"$sync/files"

tty=()
[[ -t 0 ]] && tty+=(-i)
[[ -t 1 ]] && tty+=(-t)
status=0
docker run --rm --init ${tty[@]+"${tty[@]}"} --cpus "${SFLY_LINUX_CPUS:-4}" --network "container:$pg" \
	-v "$root:/src:ro" -v "$sync:/sync:ro" -v "$volume:/vol" \
	-e SFLY_LINUX_ID="$id" -e DATABASE_URL=postgres://sfly:sfly@127.0.0.1:5432/sfly \
	"$image" bash /src/scripts/linux/entry.sh "$@" || status=$?
exit "$status"
