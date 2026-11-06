#!/usr/bin/env bash
# 控制面镜像冒烟：用 out/server（先运行 `pnpm bundle:server`）构建 linux/amd64 镜像，连本机 PostgreSQL 的
# 临时数据库启动容器，检查健康检查转为 healthy、页面、API、SDK wheel、非 root 运行、数据卷可写。
#   scripts/release/image-smoke.sh [镜像标签，默认 sfly-server:smoke]
# 需要 docker 和 psql；DATABASE_URL 指向的服务器需要建库权限（与测试相同）。
set -euo pipefail
cd "$(dirname "$0")/../.."

image=${1:-sfly-server:smoke}
admin_url=${DATABASE_URL:-postgres://sfly:sfly@127.0.0.1:5432/sfly}
version=$(bash scripts/release/version.sh check)
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
db=sfly_image_smoke_$suffix
container=sfly-image-smoke-$suffix
volume=sfly-image-smoke-$suffix
http_port=$((20000 + RANDOM % 10000))
grpc_port=$((http_port + 10000))

if [[ ! -f out/server/main.mjs ]]; then
	echo "out/server/main.mjs 不存在，先运行 pnpm bundle:server" >&2
	exit 1
fi

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	docker volume rm "$volume" >/dev/null 2>&1 || true
	psql "$admin_url" -qc "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --quiet --platform linux/amd64 -f apps/server/Dockerfile \
	--build-arg NODE_MAJOR="$(cat .node-version)" -t "$image" out/server >/dev/null
psql "$admin_url" -qc "CREATE DATABASE \"$db\""
db_url=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.href)' "$admin_url" "$db")

# 用主机网络直接访问本机（或 CI 服务容器映射到本机）的 PostgreSQL。
docker run -d --init --name "$container" --network host -v "$volume:/data" \
	-e DATABASE_URL="$db_url" -e SFLY_HTTP_PORT="$http_port" -e SFLY_GRPC_PORT="$grpc_port" \
	"$image" >/dev/null

fail() {
	echo "镜像冒烟失败：$1" >&2
	docker logs "$container" 2>&1 | tail -n 50 >&2
	exit 1
}

for _ in $(seq 60); do
	status=$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo exited)
	[[ $status == healthy ]] && break
	[[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]] || fail "容器已退出"
	sleep 2
done
[[ $status == healthy ]] || fail "健康检查没有转为 healthy（$status）"

# 先取完整输出再检查，不用 `cmd | grep -q`：grep -q 匹配到就退出，还在输出的 cmd 收到 SIGPIPE，
# 在 pipefail 下整条管道失败（匹配到了反而报失败）。
contains() { grep -q "${@:2}" <<<"$1"; }
base=http://127.0.0.1:$http_port
contains "$(curl -fsS "$base/api/health")" '"status":"ok"' || fail "/api/health"
contains "$(curl -fsS -H 'accept: text/html' "$base/")" -i '<!doctype html>' || fail "页面"
curl -fsS "$base/api/agents" >/dev/null || fail "/api/agents"
contains "$(curl -fsS "$base/sdk/python")" "\"version\":\"$version\"" || fail "SDK wheel $version"
[[ $(docker exec "$container" id -u) != 0 ]] || fail "容器以 root 运行"
docker exec "$container" sh -c 'touch /data/.write-test && rm /data/.write-test' || fail "/data 不可写"
contains "$(docker logs "$container" 2>&1)" "sfly control plane $version" ||
	fail "启动日志里没有版本号 $version"

echo "镜像冒烟通过：$image（sfly $version）"
