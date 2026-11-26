#!/usr/bin/env bash
# 助手镜像冒烟（ADR 0027、#549）：用 out/assistant（先运行 `pnpm bundle:assistant`）构建本机架构（linux/amd64 或 linux/arm64）的镜像，
# 不靠模拟运行别的架构；不带模型文件起一个容器（助手服务不会因为模型没配好而拒绝启动），检查：
# 健康检查转为 healthy；没有共享密钥的请求是 401；带共享密钥的 GET /health 返回助手服务的版本（等于仓库的版本号）和 pi 的版本，
# 并写明没有配置模型；非 root；/data 和 /work 可写；容器没有发布任何端口；共享密钥太短时拒绝启动。
#   scripts/release/assistant-image-smoke.sh [镜像标签，默认 sfly-assistant:smoke]
# 需要 docker。共享密钥是这一次随机生成的，不打印；容器的 /health 经 docker exec 里的 node 请求（镜像不映射端口）。
set -euo pipefail
cd "$(dirname "$0")/../.."

image=${1:-sfly-assistant:smoke}
version=$(bash scripts/release/version.sh check)
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
container=sfly-assistant-smoke-$suffix
volume=sfly-assistant-smoke-$suffix
secret=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')

if [[ ! -f out/assistant/main.mjs ]]; then
	echo "out/assistant/main.mjs 不存在，先运行 pnpm bundle:assistant" >&2
	exit 1
fi

cleanup() {
	docker rm -f -v "$container" "$container-short" >/dev/null 2>&1 || true
	docker volume rm "$volume" >/dev/null 2>&1 || true
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
docker build --quiet --platform "$platform" -f apps/assistant/Dockerfile \
	--build-arg NODE_MAJOR="$(cat .node-version)" -t "$image" out/assistant >/dev/null

fail() {
	echo "助手镜像冒烟失败：$1" >&2
	docker logs "$container" 2>&1 | tail -n 50 >&2 || true
	exit 1
}

# 共享密钥只经环境变量名交给 docker 命令（`-e 名字`），不出现在参数里。
SFLY_ASSISTANT_SECRET=$secret docker run -d --init --name "$container" -v "$volume:/data" \
	-e SFLY_ASSISTANT_SECRET "$image" >/dev/null

for _ in $(seq 60); do
	status=$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo exited)
	[[ $status == healthy ]] && break
	[[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]] || fail "容器已退出"
	sleep 2
done
[[ $status == healthy ]] || fail "健康检查没有转为 healthy（$status）"

# 容器里用 node 请求 /health：status 参数 anonymous 不带密钥，否则带上容器自己的 SFLY_ASSISTANT_SECRET。
request() {
	docker exec "$container" node -e '
		const headers = process.argv[1] === "anonymous" ? {} : { authorization: `Bearer ${process.env.SFLY_ASSISTANT_SECRET}` };
		fetch("http://127.0.0.1:8090/health", { headers }).then(async (r) => {
			process.stdout.write(`${r.status} ${await r.text()}`);
		}, () => process.exit(2));
	' "$1"
}
[[ $(request anonymous | cut -d ' ' -f 1) == 401 ]] || fail "不带共享密钥的 /health 应当是 401"
body=$(request authenticated)
[[ ${body%% *} == 200 ]] || fail "带共享密钥的 /health 返回 ${body%% *}"
json=${body#* }
# 先取完整输出再检查，不用 `cmd | grep -q`：grep -q 匹配到就退出，还在输出的 cmd 收到 SIGPIPE，在 pipefail 下整条管道失败。
contains() { grep -q "${@:2}" <<<"$1"; }
contains "$json" "\"assistant\":\"$version\"" || fail "/health 里助手服务的版本不是 $version：$json"
contains "$json" '"pi":"[0-9][0-9.]*' || fail "/health 里没有 pi 的版本：$json"
contains "$json" '"configured":false' || fail "没有挂模型文件时 /health 应当写没有配置模型：$json"

[[ $(docker exec "$container" id -u) != 0 ]] || fail "容器以 root 运行"
docker exec "$container" sh -c 'touch /data/.write-test && rm /data/.write-test' || fail "/data 不可写"
docker exec "$container" sh -c 'touch /work/.write-test && rm /work/.write-test' || fail "/work 不可写"
[[ -z $(docker port "$container") ]] || fail "容器发布了端口：$(docker port "$container")"

# 共享密钥短于 32 个字符：助手服务拒绝启动（控制面把它当作没有配置）。
SFLY_ASSISTANT_SECRET=too-short docker run -d --init --name "$container-short" \
	-e SFLY_ASSISTANT_SECRET "$image" >/dev/null
for _ in $(seq 30); do
	[[ $(docker inspect --format '{{.State.Running}}' "$container-short") == true ]] || break
	sleep 1
done
[[ $(docker inspect --format '{{.State.Running}}' "$container-short") == false ]] ||
	fail "共享密钥太短时助手服务没有拒绝启动"
[[ $(docker inspect --format '{{.State.ExitCode}}' "$container-short") != 0 ]] ||
	fail "共享密钥太短时助手服务应当以非零退出码退出"

echo "助手镜像冒烟通过：$image（助手服务 $version）"
