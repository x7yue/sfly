#!/usr/bin/env bash
# 工作台镜像冒烟（ADR 0027、#549）：构建 deploy/workbench 的镜像（本机架构，不靠模拟运行别的架构），在一个临时网络里起 PostgreSQL 和
# 控制面（镜像见第二个参数，没有时用 out/server 构建，先运行 `pnpm bundle:server`），给工作台 Agent 签发 Agent 凭据，
# 用 compose 同样的环境变量起工作台容器，检查：
#   - 镜像里没有 Node 和 pi，有 git、rg、fd、jq、curl、python；以非 root 运行；容器没有发布端口；
#   - 工作台在控制面的 Agent 页上在线、准备好了环境，用的是它自己的 Agent 凭据（auth_kind 为 agent），版本和控制面一致，
#     是按开发方式（--dev）装的（uv 和 sfly 命令行都在），对外地址是服务名、能力端口同一个网络里连得到；
#   - 凭据没有出现在容器日志、进程参数里，Agent 的环境里没有 SFLY_WORKBENCH_TOKEN；
#   - 删掉容器再建（同样的卷）：工作区里的文件还在、Agent 二进制没有被换过（不重装）、入口脚本说「已经装好」；
#   - 上次装到一半被打断（卷里留着半套）：重新启动之后重装，并且在线。
#   scripts/release/workbench-image-smoke.sh [工作台镜像标签，默认 sfly-workbench:smoke] [控制面镜像标签，默认 sfly-server:smoke]
# 需要 docker 和 node。联网：控制面的安装脚本要从镜像下载 uv 和 sfly 的依赖；要用镜像站时在环境里设置 SFLY_PYPI_MIRROR 和
# SFLY_GITHUB_RELEASE_MIRROR（原样交给控制面，deploy/.env.example）；DEBIAN_MIRROR 是构建工作台镜像时 apt 用的镜像站。
set -euo pipefail
cd "$(dirname "$0")/../.."

workbench_image=${1:-sfly-workbench:smoke}
server_image=${2:-sfly-server:smoke}
version=$(bash scripts/release/version.sh check)
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
prefix=sfly-wb-smoke-$suffix
network=$prefix
pg=$prefix-pg
cp=$prefix-cp
wb=$prefix-wb
home_volume=$prefix-home
work_volume=$prefix-work
agent=workbench
admin_login=smoke_admin
admin_password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
jar=$(mktemp)

cleanup() {
	docker rm -f -v "$wb" "$cp" "$pg" >/dev/null 2>&1 || true
	docker volume rm "$home_volume" "$work_volume" >/dev/null 2>&1 || true
	docker network rm "$network" >/dev/null 2>&1 || true
	rm -f "$jar"
}
trap cleanup EXIT

fail() {
	echo "工作台镜像冒烟失败：$1" >&2
	for container in "$wb" "$cp"; do
		echo "--- $container 的日志（最后 40 行；凭据不会出现在里面）" >&2
		docker logs "$container" 2>&1 | tail -n 40 >&2 || true
	done
	exit 1
}

case $(uname -m) in
x86_64 | amd64) platform=linux/amd64 ;;
aarch64 | arm64) platform=linux/arm64 ;;
*)
	echo "不支持的架构：$(uname -m)" >&2
	exit 2
	;;
esac

docker build --quiet --platform "$platform" ${DEBIAN_MIRROR:+--build-arg "DEBIAN_MIRROR=$DEBIAN_MIRROR"} \
	-t "$workbench_image" deploy/workbench >/dev/null
if ! docker image inspect "$server_image" >/dev/null 2>&1; then
	if [[ ! -f out/server/main.mjs ]]; then
		echo "没有控制面镜像 $server_image，out/server/main.mjs 也不存在，先运行 pnpm bundle:server" >&2
		exit 1
	fi
	docker build --quiet --platform "$platform" -f apps/server/Dockerfile \
		--build-arg NODE_MAJOR="$(cat .node-version)" -t "$server_image" out/server >/dev/null
fi

# 先查镜像本身：没有 Node 和 pi，有助手要用的工具，非 root。--entrypoint 绕过入口脚本。
inside() { docker run --rm --entrypoint "$1" "$workbench_image" "${@:2}"; }
for missing in node npm pi; do
	if docker run --rm --entrypoint sh "$workbench_image" -c "command -v $missing" >/dev/null 2>&1; then
		fail "工作台镜像里有 $missing：镜像里不该有 Node 和 pi"
	fi
done
for tool in git rg fd jq curl pgrep python python3; do
	docker run --rm --entrypoint sh "$workbench_image" -c "command -v $tool" >/dev/null 2>&1 ||
		fail "工作台镜像里没有 $tool"
done
[[ $(inside id -u) != 0 ]] || fail "容器以 root 运行"
inside python --version | grep -q '^Python 3' || fail "python 命令不是 Python 3"

docker network create "$network" >/dev/null
docker run -d --name "$pg" --network "$network" \
	-e POSTGRES_USER=sfly -e POSTGRES_PASSWORD=sfly -e POSTGRES_DB=sfly --tmpfs /var/lib/postgresql \
	postgres:18 >/dev/null
for _ in $(seq 60); do
	docker exec "$pg" pg_isready -U sfly -d sfly >/dev/null 2>&1 && break
	sleep 1
done

# 控制面：网络别名 sfly，SFLY_PUBLIC_URL 写成这个别名（工作台容器里也连得到，README「助手和工作台」）；
# 管理员的密码只经环境变量名交给 docker。
env_args=()
for name in SFLY_PYPI_MIRROR SFLY_GITHUB_RELEASE_MIRROR; do
	[[ -z ${!name:-} ]] || env_args+=(-e "$name")
done
SFLY_ADMIN_PASSWORD=$admin_password docker run -d --init --name "$cp" --network "$network" --network-alias sfly \
	-p 127.0.0.1::8080 \
	-e DATABASE_URL=postgres://sfly:sfly@"$pg":5432/sfly -e SFLY_PUBLIC_URL=http://sfly:8080 \
	-e SFLY_ADMIN_LOGIN="$admin_login" -e SFLY_ADMIN_PASSWORD ${env_args[@]+"${env_args[@]}"} "$server_image" >/dev/null
for _ in $(seq 60); do
	status=$(docker inspect --format '{{.State.Health.Status}}' "$cp" 2>/dev/null || echo exited)
	[[ $status == healthy ]] && break
	[[ $(docker inspect --format '{{.State.Running}}' "$cp") == true ]] || fail "控制面容器已退出"
	sleep 2
done
[[ $status == healthy ]] || fail "控制面的健康检查没有转为 healthy（$status）"
base=http://127.0.0.1:$(docker port "$cp" 8080/tcp | head -n 1 | sed 's/.*://')

# 管理员登录（登录 Cookie 只对同源的请求有效，所以带 Sec-Fetch-Site），再给工作台签发 Agent 凭据（只显示这一次）。
# 密码经标准输入给 curl，凭据只放在这个脚本的变量里，不打印。
json_post=(-H 'content-type: application/json' -H 'sec-fetch-site: same-origin')
printf '{"login_name":"%s","password":"%s"}' "$admin_login" "$admin_password" |
	curl -fsS -c "$jar" "${json_post[@]}" --data-binary @- "$base/auth/login" >/dev/null || fail "管理员登录"
token=$(curl -fsS -b "$jar" "${json_post[@]}" -d '{}' "$base/agents/$agent/credentials" |
	node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).token)') ||
	fail "签发 Agent 凭据"
[[ $token == sfly_agt_* ]] || fail "签发的不是 Agent 凭据"

# 起工作台：和 compose 的 sfly-workbench 服务同样的环境变量和卷，凭据经环境变量名交给 docker。
start_workbench() {
	SFLY_WORKBENCH_TOKEN=$token docker run -d --init --name "$wb" --network "$network" --network-alias sfly-workbench \
		-v "$home_volume:/home/workbench" -v "$work_volume:/work" \
		-e SFLY_WORKBENCH_URL=http://sfly:8080 -e SFLY_WORKBENCH_AGENT="$agent" \
		-e SFLY_WORKBENCH_PUBLIC_ADDRESS=sfly-workbench -e SFLY_WORKBENCH_TOKEN "$workbench_image" >/dev/null
}

# Agent 页上这台 Agent 的状态，一行：在线与否、环境是否准备好、Agent 版本、控制面版本、版本是否不一致、凭据种类、对外地址、能力端口。
agent_state() {
	curl -fsS -b "$jar" -H 'sec-fetch-site: same-origin' "$base/agents" | node -e '
		const { agents, control_plane_version: controlPlane } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
		const agent = agents.find((a) => a.name === process.argv[1]);
		if (!agent) { console.log("none"); process.exit(0); }
		console.log([agent.status, agent.preparing_since === null ? "ready" : "preparing", agent.info.agent_version, controlPlane,
			agent.version_mismatch, agent.auth_kind, agent.endpoint.address, agent.endpoint.port ?? "-"].join(" "));
	' "$agent"
}

# 等工作台在线、环境准备好；容器退出了（装失败）就失败。
wait_online() {
	local state=none
	for _ in $(seq 180); do
		state=$(agent_state)
		[[ $state == online\ ready\ * ]] && return 0
		[[ $(docker inspect --format '{{.State.Running}}' "$wb") == true ]] || fail "工作台容器退出了（${state}）"
		sleep 2
	done
	fail "工作台 6 分钟内没有在线、准备好环境（${state}）"
}

start_workbench
wait_online
read -r status _ agent_version control_plane_version mismatch auth address port <<<"$(agent_state)"
[[ $agent_version == "$version" && $control_plane_version == "$version" ]] ||
	fail "版本不一致：Agent $agent_version，控制面 $control_plane_version，仓库 $version"
[[ $mismatch == false ]] || fail "Agent 页上写版本不一致"
[[ $auth == agent ]] || fail "工作台没有用 Agent 凭据连接（auth_kind 是 $auth）"
[[ $address == sfly-workbench && $port =~ ^[0-9]+$ ]] || fail "能力端口的地址不对：$address:$port"

# 开发方式装的：uv 和 sfly 命令行都在，版本和控制面一致；Agent 的配置里是这个名字。
contains() { grep -q "${@:2}" <<<"$1"; }
contains "$(docker exec "$wb" sfly --version)" "sfly $version" || fail "sfly 命令行的版本不是 $version"
docker exec "$wb" sh -c 'test -x ~/.local/bin/uv && test -f ~/.sfly/agent.env && test -f ~/.sfly/.workbench-installed' ||
	fail "uv、agent.env 或入口脚本的安装标记不在"
contains "$(docker exec "$wb" sh -c 'cat ~/.sfly/agent.env')" "^SFLY_AGENT_NAME=$agent$" || fail "agent.env 里的名字不对"

# 不映射端口；同一个网络里别的容器连得到能力端口（助手服务就是这样连的）。
[[ -z $(docker port "$wb") ]] || fail "工作台发布了端口：$(docker port "$wb")"
docker run --rm --network "$network" --entrypoint bash "$workbench_image" -c "echo > /dev/tcp/sfly-workbench/$port" ||
	fail "同一个网络里连不上工作台的能力端口 $port"

# 凭据没有出现在日志、进程参数里；Agent 的环境里没有入口的那个变量。SFLY_TOKEN 在 Agent 的环境里是设计如此（Agent 的子进程里去掉）。
# 先把 ps 和 /proc 的内容存成文件、再 grep：grep 自己的参数里不能带着凭据。
no_token() { # <说明>（标准输入是要查的内容，凭据经进程替换给 grep，不进参数）
	if grep -qF -f <(printf '%s\n' "$token") -; then fail "凭据出现在$1"; fi
}
docker logs "$wb" 2>&1 | no_token "工作台容器的日志里"
docker logs "$cp" 2>&1 | no_token "控制面容器的日志里"
docker exec "$wb" sh -c 'ps -eo args > /tmp/ps.txt; for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline; echo; done > /tmp/cmdline.txt 2>/dev/null; true'
docker exec "$wb" cat /tmp/ps.txt /tmp/cmdline.txt | no_token "进程的命令行参数里"
env_names=$(docker exec "$wb" sh -c 'tr "\0" "\n" < /proc/$(pgrep -x sfly-agent | head -n 1)/environ | sed "s/=.*//"')
contains "$env_names" '^SFLY_TOKEN$' || fail "Agent 的环境里没有 SFLY_TOKEN（每次启动都经它交给 Agent）"
if contains "$env_names" '^SFLY_WORKBENCH_TOKEN$'; then fail "Agent 的环境里还有 SFLY_WORKBENCH_TOKEN"; fi

# 删掉容器再建：卷还在，工作区里的文件还在，Agent 不重装（二进制的 inode、修改时间和内容都没变），入口脚本说已经装好。
docker exec "$wb" sh -c 'echo kept > /work/probe.txt'
agent_fingerprint() { docker exec "$1" sh -c 'stat -c "%i %Y" ~/.sfly/bin/sfly-agent; sha256sum ~/.sfly/bin/sfly-agent'; }
before=$(agent_fingerprint "$wb")
docker rm -f "$wb" >/dev/null
start_workbench
wait_online
[[ $(docker exec "$wb" cat /work/probe.txt) == kept ]] || fail "删掉容器再建之后，工作区里的文件不见了"
[[ $(agent_fingerprint "$wb") == "$before" ]] || fail "删掉容器再建之后，Agent 二进制变了：重装了"
logs=$(docker logs "$wb" 2>&1)
contains "$logs" '已经装好，直接启动' || fail "入口脚本没有说「已经装好，直接启动」"
if contains "$logs" '下载安装脚本'; then fail "删掉容器再建之后又下载了安装脚本"; fi

# 上次装到一半被打断（在装 sfly 命令行的时候）：Agent 和 agent.env 已经在，没有安装标记，uv 装到一半的 sfly 工具和它的命令都不在，
# bin 里还留着一个下载到一半的文件。重新启动之后重装、在线，临时文件被清掉。
docker rm -f "$wb" >/dev/null
docker run --rm -v "$home_volume:/home/workbench" --entrypoint sh "$workbench_image" -c \
	'rm -rf ~/.sfly/.workbench-installed ~/.local/bin/sfly ~/.local/share/uv/tools/sfly && touch ~/.sfly/bin/.sfly-agent.download.99999'
start_workbench
wait_online
logs=$(docker logs "$wb" 2>&1)
contains "$logs" '下载安装脚本' || fail "装到一半的卷没有重装"
docker exec "$wb" sh -c 'test -x ~/.local/bin/sfly && test -f ~/.sfly/.workbench-installed && ! test -e ~/.sfly/bin/.sfly-agent.download.99999' ||
	fail "重装之后 sfly 命令行、安装标记不在，或者留着装到一半的临时文件"
[[ $(docker exec "$wb" cat /work/probe.txt) == kept ]] || fail "重装之后工作区里的文件不见了"

# 控制面的 install.sh 变了（升级、改了对外地址）：标记里记的 sha256 和这次取到的不一样 → 重装（sfly 命令行不会自己升级，靠这一步跟着控制面走）。
# 这里把标记里的 sha256 改掉；同时在家目录的 ~/.local/bin 里放一个假的 cat：入口脚本自己用的命令只在系统目录里找，不会执行它。
docker rm -f "$wb" >/dev/null
docker run --rm -v "$home_volume:/home/workbench" --entrypoint sh "$workbench_image" -c \
	"printf 'name=%s\ninstall_sh_sha256=%s\n' '$agent' 0000 > ~/.sfly/.workbench-installed &&
	printf '#!/bin/sh\ntouch /tmp/planted-cat-ran\nexec /usr/bin/cat \"\$@\"\n' > ~/.local/bin/cat && chmod +x ~/.local/bin/cat"
start_workbench
wait_online
logs=$(docker logs "$wb" 2>&1)
contains "$logs" 'install.sh 变了' || fail "标记里的 sha256 不对，入口脚本没有重装"
contains "$(docker exec "$wb" cat /home/workbench/.sfly/.workbench-installed)" '^install_sh_sha256=[0-9a-f]\{64\}$' ||
	fail "重装之后标记里没有记下 install.sh 的 sha256"
docker exec "$wb" test ! -e /tmp/planted-cat-ran || fail "入口脚本执行了家目录里放的 cat"
path_of_agent=$(docker exec "$wb" sh -c 'tr "\0" "\n" < /proc/$(pgrep -x sfly-agent | head -n 1)/environ | sed -n "s/^PATH=//p"')
[[ $path_of_agent == */home/workbench/.local/bin ]] || fail "Agent 的 PATH 里 ~/.local/bin 不在最后：$path_of_agent"
[[ $(docker exec "$wb" cat /work/probe.txt) == kept ]] || fail "控制面的 install.sh 变了重装之后，工作区里的文件不见了"
docker exec "$wb" rm -f /home/workbench/.local/bin/cat

echo "工作台镜像冒烟通过：$workbench_image（控制面 $server_image，sfly $version）"
