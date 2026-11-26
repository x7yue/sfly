#!/bin/sh
# 工作台容器的入口（ADR 0027、#549）：家目录里还没有装好的 Agent 时，从控制面下载 install.sh，按开发机的方式
#（--dev）装好；然后前台启动 Agent。已经装好就直接启动，不重装、不联网。
#
# 环境变量（compose 的 assistant profile 里给，deploy/docker-compose.yml）：
#   SFLY_WORKBENCH_URL             控制面的地址，容器里连得到的（compose 里是服务名 http://sfly:8080）；install.sh 从它下载
#   SFLY_WORKBENCH_AGENT           这台 Agent 的名字（和控制面里指名工作台的 SFLY_WORKBENCH_AGENT 是同一个值）
#   SFLY_WORKBENCH_PUBLIC_ADDRESS  控制面和助手服务连这台 Agent 的能力端口用的地址（compose 里是服务名 sfly-workbench）
#   SFLY_WORKBENCH_TOKEN           这台 Agent 的 Agent 凭据（sfly_agt_ 开头，只对上面的名字有效，管理员按名字签发）
#   SFLY_WORKBENCH_WORK            工作区目录，默认 /work（只检查它写得了，不在这里建 git 仓库：那是助手服务的事）
# 家目录 $HOME 是卷，里面的 $SFLY_HOME（默认 ~/.sfly）放 Agent、共享 venv、任务目录；--dev 装的 uv 和 sfly 在 ~/.local。
#
# 凭据（SFLY_WORKBENCH_TOKEN）怎么走：
# - 只从环境变量读进 shell 变量，马上从环境里去掉：之后起的子进程（Agent 的命令、模型的命令）环境里没有这个名字的变量。
# - 交给 install.sh 和 Agent 都经环境变量 SFLY_TOKEN，不经命令行参数（ps 看不到）；Agent 起的子进程环境里
#   也去掉 SFLY_TOKEN（agent/src/subprocess.rs）。install.sh 另把它写进 $SFLY_HOME/agent.env（权限 0600，用户自己读得到）。
# - 不回显、不写进镜像：这个脚本从不 set -x，只打印名字和地址。
# - 每次启动都经 SFLY_TOKEN 把环境里的凭据交给 Agent（环境变量优先于 agent.env）：换了凭据只要改 .env、重建容器，
#   不用重装。
# 工作台上的模型读得到这台 Agent 的 agent.env 和进程环境（同一个系统用户，ADR 0029 的已知边界）：凭据只对这一个名字有效，
# 泄露时吊销它、签发新的。
#
# 「已经装好」的判断（全部满足才算，`installed`）：
#   1. $SFLY_HOME/.workbench-installed 存在，内容是 name=<这台 Agent 的名字>：这个脚本在 install.sh 成功结束、
#      下面三个文件都在之后才写它，所以它是「上一次装完了」的唯一证据；换了名字就不算装好，重装。
#   2. $SFLY_HOME/bin/sfly-agent 可执行；3. $SFLY_HOME/agent.env 存在；4. ~/.local/bin/sfly 可执行。
# 上次装到一半被打断（容器在下载、装 uv 或 sfly 的中途被停掉）：没有 1，或者缺 2–4 其中一个，下次启动重装。install.sh 本来就
# 是幂等的（重新运行即重新安装），这里只清掉它被杀掉时留下的临时文件。装失败时脚本以非零退出，容器按 restart 策略
# 重启、重试；失败时不留 1，所以不会把半套当成装好。
set -eu

say() {
	printf '工作台：%s\n' "$*"
}

fail() {
	printf '工作台：%s\n' "$*" >&2
	exit 1
}

home=${HOME:-}
[ -n "$home" ] || fail "没有设置 HOME"
SFLY_HOME=${SFLY_HOME:-$home/.sfly}
export SFLY_HOME
work=${SFLY_WORKBENCH_WORK:-/work}
control_plane=${SFLY_WORKBENCH_URL:-}
name=${SFLY_WORKBENCH_AGENT:-}
public_address=${SFLY_WORKBENCH_PUBLIC_ADDRESS:-}
token=${SFLY_WORKBENCH_TOKEN:-}
unset SFLY_WORKBENCH_TOKEN

[ -n "$control_plane" ] || fail "没有设置 SFLY_WORKBENCH_URL（控制面的地址，容器里连得到的，例如 http://sfly:8080）"
[ -n "$name" ] || fail "没有设置 SFLY_WORKBENCH_AGENT（这台 Agent 的名字，compose 里在 .env 设置）"
[ -n "$public_address" ] || fail "没有设置 SFLY_WORKBENCH_PUBLIC_ADDRESS（控制面和助手服务连这台 Agent 用的地址，例如 compose 的服务名）"
[ -n "$token" ] || fail "没有设置 SFLY_WORKBENCH_TOKEN（这台 Agent 的 Agent 凭据）：管理员给「$name」签发：sfly api POST /agents/$name/credentials，填进 .env 的 SFLY_WORKBENCH_TOKEN"

# 两个卷要归当前用户。命名卷首次挂载时沿用镜像里的属主；挂宿主机目录或别人建的卷时可能是 root 的：写不了就说清楚怎么改。
for dir in "$home" "$work"; do
	[ -d "$dir" ] && [ -w "$dir" ] ||
		fail "$dir 不存在或当前用户（$(id -un)，uid $(id -u)）写不了它。它必须归 uid $(id -u) 所有：挂的是宿主机目录或别人建的卷时，先 chown -R $(id -u):$(id -g) 它"
done

marker=$SFLY_HOME/.workbench-installed
agent=$SFLY_HOME/bin/sfly-agent

installed() {
	[ "$(cat "$marker" 2>/dev/null)" = "name=$name" ] &&
		[ -x "$agent" ] && [ -f "$SFLY_HOME/agent.env" ] && [ -x "$home/.local/bin/sfly" ]
}

install_agent() {
	rm -f "$marker"
	# install.sh 被杀掉时留下的临时文件（它正常退出时自己会清）。
	rm -rf "$SFLY_HOME"/bin/.sfly-agent.download.* "$SFLY_HOME"/bin/.uv-installer.*.sh \
		"$SFLY_HOME"/bin/.user-agent.* "$SFLY_HOME/agent.env.tmp"
	script=$(mktemp)
	say "从 $control_plane/install.sh 下载安装脚本"
	# 控制面可能还在启动：重试一会儿（compose 里 depends_on 等它健康，这里是 docker run 和重启时的兜底）。
	curl -fsS --connect-timeout 5 --max-time 60 --retry 30 --retry-delay 2 --retry-connrefused --retry-all-errors \
		-o "$script" "$control_plane/install.sh" ||
		fail "下载 $control_plane/install.sh 失败：控制面起来了吗？地址在容器里连得到吗？"
	say "安装 Agent「$name」（--dev：Agent、uv、sfly 命令行，版本和控制面一致）"
	# 凭据经环境变量交给安装脚本，不在命令行参数里。脚本来自控制面，信任控制面（ADR 0011）。
	if ! SFLY_TOKEN=$token sh "$script" --dev --name "$name" --public-address "$public_address" --no-service; then
		rm -f "$script"
		fail "安装脚本失败（上面是原因）。解决之后重启容器即可：下载的东西不会重复，已经装好的部分重新运行是幂等的"
	fi
	rm -f "$script"
	[ -x "$agent" ] && [ -f "$SFLY_HOME/agent.env" ] && [ -x "$home/.local/bin/sfly" ] ||
		fail "安装脚本正常结束，但 $agent、$SFLY_HOME/agent.env 或 ~/.local/bin/sfly 不在：没有装好"
	printf 'name=%s\n' "$name" >"$marker"
}

if installed; then
	say "Agent「$name」已经装好，直接启动（要重装：删掉 $marker）"
else
	install_agent
fi

say "前台启动 Agent「$name」"
SFLY_TOKEN=$token
export SFLY_TOKEN
exec "$agent"
