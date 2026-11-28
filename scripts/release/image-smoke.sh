#!/usr/bin/env bash
# 控制面镜像冒烟：用 out/server（先运行 `pnpm bundle:server`）构建本机架构（linux/amd64 或 linux/arm64）的镜像，
# 不靠模拟运行别的架构（开发机有 x86_64 也有 arm64）；连本机 PostgreSQL 的
# 临时数据库启动容器，检查健康检查转为 healthy、页面、API（不带凭据是 401，初始管理员登录后可读）、SDK wheel、
# API 客户端安装包、两个架构的 Agent 与 install.sh、非 root 运行、数据卷可写。
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
# 初始管理员：项目里的接口不带凭据是 401（#494），登录之后读。密码是这一次随机的，只经环境变量名交给 docker、经标准输入交给 curl。
admin_login=smoke_admin
admin_password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
jar=$(mktemp)

if [[ ! -f out/server/main.mjs ]]; then
	echo "out/server/main.mjs 不存在，先运行 pnpm bundle:server" >&2
	exit 1
fi

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	docker volume rm "$volume" >/dev/null 2>&1 || true
	psql "$admin_url" -qc "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 || true
	rm -f "$jar"
}
trap cleanup EXIT

case $(uname -m) in
x86_64 | amd64) platform=linux/amd64 ;;
aarch64 | arm64) platform=linux/arm64 ;;
*)
	echo "不支持的架构：$(uname -m)" >&2
	exit 2
	;;
esac
docker build --quiet --platform "$platform" -f apps/server/Dockerfile \
	--build-arg NODE_MAJOR="$(cat .node-version)" -t "$image" out/server >/dev/null
psql "$admin_url" -qc "CREATE DATABASE \"$db\""
db_url=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.href)' "$admin_url" "$db")

# 用主机网络直接访问本机（或 CI 服务容器映射到本机）的 PostgreSQL。
SFLY_ADMIN_PASSWORD=$admin_password docker run -d --init --name "$container" --network host -v "$volume:/data" \
	-e DATABASE_URL="$db_url" -e SFLY_HTTP_PORT="$http_port" -e SFLY_GRPC_PORT="$grpc_port" \
	-e SFLY_ADMIN_LOGIN="$admin_login" -e SFLY_ADMIN_PASSWORD "$image" >/dev/null

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
# 项目里的接口：不带凭据是 401（#494）；初始管理员登录（登录 Cookie，同源的请求）之后可读。
anonymous=$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/projects/default/agents") || fail "/api/projects/default/agents 连不上"
[[ $anonymous == 401 ]] || fail "不带凭据的 /api/projects/default/agents 应当是 401，实际是 $anonymous"
printf '{"login_name":"%s","password":"%s"}' "$admin_login" "$admin_password" |
	curl -fsS -c "$jar" -H 'content-type: application/json' -H 'sec-fetch-site: same-origin' --data-binary @- \
		"$base/api/auth/login" >/dev/null || fail "初始管理员登录"
contains "$(curl -fsS -b "$jar" "$base/api/projects/default/agents")" '"agents":' || fail "/api/projects/default/agents（登录之后）"
contains "$(curl -fsS "$base/sdk/python")" "\"version\":\"$version\"" || fail "SDK wheel $version"
contains "$(curl -fsS "$base/client")" "\"version\":\"$version\"" || fail "API 客户端安装包 $version"
tarball=sfly-client-$version.tgz
expected=$(docker exec "$container" sha256sum "/app/client/$tarball" | cut -d ' ' -f 1) ||
	fail "镜像里没有 /app/client/$tarball"
actual=$(curl -fsS "$base/client/$version/$tarball" | sha256sum | cut -d ' ' -f 1)
[[ $actual == "$expected" ]] || fail "下载的 API 客户端安装包与镜像里的不同"
# 镜像里带着两个架构的同版本 Agent（ADR 0011），控制面提供下载和 install.sh。
binaries=$(curl -fsS "$base/agent/binaries")
for arch in x86_64 aarch64; do
	contains "$binaries" "\"arch\":\"$arch\",\"version\":\"$version\"" || fail "/agent/binaries 里没有 $arch 的 Agent $version"
	expected=$(docker exec "$container" sha256sum "/app/agent/$arch/sfly-agent" | cut -d ' ' -f 1) ||
		fail "镜像里没有 /app/agent/$arch/sfly-agent"
	actual=$(curl -fsS "$base/agent/binaries/$version/$arch" | sha256sum | cut -d ' ' -f 1)
	[[ $actual == "$expected" ]] || fail "下载的 $arch Agent 与镜像里的不同"
	contains "$(curl -fsS "$base/install.sh")" "SHA256_${arch^^}='$expected'" || fail "install.sh 里 $arch 的 sha256"
done
contains "$(curl -fsS "$base/install.sh")" "SFLY_VERSION='$version'" || fail "install.sh 里的版本号"
[[ $(docker exec "$container" id -u) != 0 ]] || fail "容器以 root 运行"
docker exec "$container" sh -c 'touch /data/.write-test && rm /data/.write-test' || fail "/data 不可写"
contains "$(docker logs "$container" 2>&1)" "sfly control plane $version" ||
	fail "启动日志里没有版本号 $version"

echo "镜像冒烟通过：$image（sfly $version）"
