#!/bin/sh
# 工作台容器的入口（ADR 0027、#549）：从控制面下载 install.sh，按开发机的方式（--dev）装好 Agent、uv 和 sfly 命令行，
# 然后前台启动 Agent。家目录里已经装好、而且控制面的 install.sh 没变时不重装；变了（控制面升级、改了对外地址……）就重装。
#
# 环境变量（compose 的 assistant profile 里给，deploy/docker-compose.yml）：
#   SFLY_WORKBENCH_URL             控制面的地址，容器里连得到的（compose 里是服务名 http://sfly:8080）；install.sh 从它下载。
#                                  install.sh 里写给 Agent 的控制面地址是控制面自己的 SFLY_PUBLIC_URL，不是这个（README「助手和工作台」）
#   SFLY_WORKBENCH_NAME            这台 Agent 的名字（管理员按这个名字签发凭据，也登记它作项目的工作台：README「登记工作台」）
#   SFLY_WORKBENCH_PUBLIC_ADDRESS  控制面和助手服务连这台 Agent 的能力端口用的地址（compose 里是服务名 sfly-workbench）
#   SFLY_WORKBENCH_TOKEN           这台 Agent 的 Agent 凭据（sfly_agt_ 开头，只对上面的名字有效，管理员按名字签发）
#   SFLY_WORKBENCH_WORK            工作区目录，默认 /work（只检查它写得了，不在这里建 git 仓库：那是助手服务的事）
#   SFLY_WORKBENCH_BASE_PATH       只给测试用，部署不要设：入口脚本自己运行命令时的 PATH，默认是下面的系统目录；
#                                  设了它就等于把「只在系统目录里找」换成别的目录
# 家目录 $HOME 是卷，里面的 $SFLY_HOME（默认 ~/.sfly）放 Agent、共享 venv、任务目录；--dev 装的 uv 和 sfly 在 ~/.local。
#
# **入口脚本自己用的命令（cat、curl、sed、sh……）只在系统目录里找**（开头把 PATH 设成系统目录，不看容器环境里的 PATH）：
# 家目录是卷、工作台上的模型写得了它，~/.local/bin 在容器环境的 PATH 最前面也不行，否则模型放一个假的 cat、curl，入口脚本下次启动
# 就执行它，而这时手上有刚交进来的凭据。exec Agent 之前才把 ~/.local/bin 加在 PATH 最后（sfly、uv 在那里；系统目录里有的命令不会被它盖掉）。
# curl 加 -q：不读家目录里的 .curlrc（模型能写）。
# **这一条只管入口脚本自己，不是说卷里的东西都碰不到凭据**：install.sh 重装时在系统 PATH 里找不到 uv，会用 $HOME/.local/bin/uv
# （卷里，模型写得了；模型改标记就能逼出一次重装），这个 uv 在 exec Agent 之前执行，环境里有 SFLY_TOKEN；卷里的 Agent 二进制也是。
# 它们是同一个已知边界：家目录卷里模型写得了的程序会拿到凭据。凭据可能泄露时删卷（见下面）。
#
# 凭据（SFLY_WORKBENCH_TOKEN）怎么走：
# - 只从环境变量读进 shell 变量，马上从环境里去掉：之后起的子进程（Agent 的命令、模型的命令）环境里没有这个名字的变量。
#   **容器的 1 号进程（docker-init）的环境里一直有它**（容器创建时的环境，/proc/1/environ，同一个用户读得到），和 agent.env 里是同一枚。
# - 交给 install.sh 和 Agent 都经环境变量 SFLY_TOKEN，不经命令行参数（ps 看不到）；Agent 起的子进程环境里
#   也去掉 SFLY_TOKEN（agent/src/subprocess.rs）。install.sh 另把它写进 $SFLY_HOME/agent.env（权限 0600，用户自己读得到）。
# - 不回显、不写进镜像：这个脚本从不 set -x，只打印名字和地址。
# - 每次启动都经 SFLY_TOKEN 把环境里的凭据交给 Agent（环境变量优先于 agent.env）。
# **工作台上的模型读得到这台 Agent 的凭据**（agent.env、Agent 进程和 1 号进程的环境，同一个系统用户，ADR 0029 的已知边界）：
# 凭据只对这一个名字有效，不能冒充别的 Agent。**凭据可能在工作台上泄露时（最常见的就是模型读走），只吊销、换新的凭据不够**：
# 家目录卷里的 Agent 二进制、~/.local/bin、agent.env 都是模型写得了的，入口脚本下次启动会执行 Agent 二进制，把新凭据交给它。
# 要先删 sfly-workbench-home 卷（/work 里的内容当作不可信，要留的审过再拷出来），再签发新凭据、填进 .env、重建（README「换工作台凭据」）。
#
# 「已经装好」的判断（全部满足才算，`installed`）：
#   1. $SFLY_HOME/.workbench-installed 存在，第一行是 name=<这台 Agent 的名字>：这个脚本在 install.sh 成功结束、
#      下面三个文件都在之后才写它，所以它是「上一次装完了」的唯一证据；换了名字就不算装好，重装。第二行是
#      install_sh_sha256=<安装时那份 install.sh 的 sha256>。
#   2. $SFLY_HOME/bin/sfly-agent 可执行；3. $SFLY_HOME/agent.env 存在；4. ~/.local/bin/sfly 可执行。
# 上次装到一半被打断（容器在下载、装 uv 或 sfly 的中途被停掉）：没有 1，或者缺 2–4 其中一个，下次启动重装。install.sh 本来就
# 是幂等的（重新运行即重新安装），这里只清掉它被杀掉时留下的临时文件。装失败时脚本以非零退出，容器按 restart 策略
# 重启、重试；失败时不留 1，所以不会把半套当成装好。
#
# 装好之后每次启动再对一下控制面的 install.sh（短超时，几秒，不重试）：
#   - 取到了、sha256 和标记里的不一样：重装（控制面升级了、改了 SFLY_PUBLIC_URL 或镜像……：install.sh 的内容只取决于控制面的
#     配置和版本，不随请求变，没有时间戳和随机数，所以相同的控制面每次取到的一样）。重装把 Agent 二进制、agent.env 和 sfly
#     命令行换成控制面这一版的（Agent 自己会自更新，sfly 命令行不会：它钉在装时的版本，所以靠这一步跟着控制面走）。
#     **重装失败不挡着已经装好的 Agent**（升级时镜像暂时不通、离线缓存缺新版命令行的依赖、切到要认证的镜像还没挂 .netrc）：
#     这条分支不先删标记；失败时打印原因，只要 sfly-agent 和 agent.env 还在就照常启动已有的 Agent，不写新标记（sfly 命令行还是旧的，
#     下次启动再试）。Agent 本身好好的，过期的只是命令行，不能因此让助手整个不可用、容器一直重启；
#   - 取到了、一样：直接启动；
#   - 取不到（控制面连不上、超时）：直接启动，不挡着已经装好的 Agent 起来。
set -eu

PATH=${SFLY_WORKBENCH_BASE_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}
export PATH

say() {
	printf '工作台：%s\n' "$*"
}

warn() {
	printf '工作台：%s\n' "$*" >&2
}

fail() {
	warn "$*"
	exit 1
}

home=${HOME:-}
[ -n "$home" ] || fail "没有设置 HOME"
SFLY_HOME=${SFLY_HOME:-$home/.sfly}
export SFLY_HOME
work=${SFLY_WORKBENCH_WORK:-/work}
control_plane=${SFLY_WORKBENCH_URL:-}
name=${SFLY_WORKBENCH_NAME:-}
public_address=${SFLY_WORKBENCH_PUBLIC_ADDRESS:-}
token=${SFLY_WORKBENCH_TOKEN:-}
unset SFLY_WORKBENCH_TOKEN

[ -n "$control_plane" ] || fail "没有设置 SFLY_WORKBENCH_URL（控制面的地址，容器里连得到的，例如 http://sfly:8080）"
[ -n "$name" ] || fail "没有设置 SFLY_WORKBENCH_NAME（这台 Agent 的名字，compose 里在 .env 设置）"
[ -n "$public_address" ] || fail "没有设置 SFLY_WORKBENCH_PUBLIC_ADDRESS（控制面和助手服务连这台 Agent 用的地址，例如 compose 的服务名）"
[ -n "$token" ] || fail "没有设置 SFLY_WORKBENCH_TOKEN（这台 Agent 的 Agent 凭据）：管理员给「${name}」签发：sfly api POST /projects/default/agents/$name/credentials，填进 .env 的 SFLY_WORKBENCH_TOKEN"

# 两个卷要归当前用户。命名卷首次挂载时沿用镜像里的属主；挂宿主机目录或别人建的卷时可能是 root 的：写不了就说清楚怎么改。
for dir in "$home" "$work"; do
	[ -d "$dir" ] && [ -w "$dir" ] ||
		fail "$dir 不存在或当前用户（$(id -un)，uid $(id -u)）写不了它。它必须归 uid $(id -u) 所有：挂的是宿主机目录或别人建的卷时，先 chown -R $(id -u):$(id -g) 它"
done

marker=$SFLY_HOME/.workbench-installed
agent=$SFLY_HOME/bin/sfly-agent
script=

# 标记里的一行 `键=值` 的值（没有标记或没有这一行时为空）。
marker_value() {
	sed -n "s/^$1=//p" "$marker" 2>/dev/null | head -n 1
}

installed() {
	[ "$(marker_value name)" = "$name" ] &&
		[ -x "$agent" ] && [ -f "$SFLY_HOME/agent.env" ] && [ -x "$home/.local/bin/sfly" ]
}

sha256_of() {
	sha256sum "$1" | cut -d ' ' -f 1
}

# 把控制面的 install.sh 下载到临时文件 $script。第一个参数 retry：控制面可能还在启动，重试一会儿（compose 里 depends_on 等它健康，
# 这里是 docker run 和重启时的兜底）；once：装好了的启动时只问一次，几秒内取不到就算了。
fetch_script() {
	script=$(mktemp)
	if [ "$1" = retry ]; then
		curl -q -fsS --connect-timeout 5 --max-time 60 --retry 30 --retry-delay 2 --retry-connrefused --retry-all-errors \
			-o "$script" "$control_plane/install.sh"
	else
		curl -q -fsS --connect-timeout 3 --max-time 5 -o "$script" "$control_plane/install.sh"
	fi || {
		rm -f "$script"
		script=
		return 1
	}
}

# 运行已经下载好的 $script，成功之后写标记（记下这份 install.sh 的 sha256）。成功返回 0；失败打印原因、返回 1（不退出：
# 由调用的一方决定是挡住启动，还是照常启动已有的 Agent）。
run_install() {
	sum=$(sha256_of "$script")
	say "安装 Agent「${name}」（--dev：Agent、uv、sfly 命令行，版本和控制面一致）"
	# 凭据经环境变量交给安装脚本，不在命令行参数里。脚本来自控制面，信任控制面（ADR 0011）。
	if ! SFLY_TOKEN=$token sh "$script" --dev --name "$name" --public-address "$public_address" --no-service; then
		rm -f "$script"
		script=
		warn "安装脚本失败（上面是原因）"
		return 1
	fi
	rm -f "$script"
	script=
	if ! { [ -x "$agent" ] && [ -f "$SFLY_HOME/agent.env" ] && [ -x "$home/.local/bin/sfly" ]; }; then
		warn "安装脚本正常结束，但 ${agent}、$SFLY_HOME/agent.env 或 ~/.local/bin/sfly 不在：没有装好"
		return 1
	fi
	printf 'name=%s\ninstall_sh_sha256=%s\n' "$name" "$sum" >"$marker"
}

# install.sh 被杀掉时留下的临时文件（它正常退出时自己会清）。
clean_leftovers() {
	rm -rf "$SFLY_HOME"/bin/.sfly-agent.download.* "$SFLY_HOME"/bin/.uv-installer.*.sh \
		"$SFLY_HOME"/bin/.user-agent.* "$SFLY_HOME/agent.env.tmp"
}

# 第一次安装，或上次装到一半被打断：没有装好的 Agent 可以起，失败就退出（容器按 restart 策略重启、重试）。
install_agent() {
	rm -f "$marker"
	clean_leftovers
	run_install || fail "解决之后重启容器即可：下载的东西不会重复，已经装好的部分重新运行是幂等的"
}

# 装好了、控制面的 install.sh 变了：重装。不先删标记；失败时已有的 Agent 还在就照常启动（下次启动再试）。
reinstall_agent() {
	clean_leftovers
	if run_install; then
		return 0
	fi
	if [ -x "$agent" ] && [ -f "$SFLY_HOME/agent.env" ]; then
		warn "重新安装没有成功：已经装好的 Agent 照常启动，标记不动（sfly 命令行还是旧版本），下次启动再试。解决之后重启容器即可"
	else
		fail "重新安装没有成功，而且 $agent 或 $SFLY_HOME/agent.env 不在了：没有可以启动的 Agent"
	fi
}

if installed; then
	if fetch_script once; then
		if [ "$(sha256_of "$script")" = "$(marker_value install_sh_sha256)" ]; then
			rm -f "$script"
			say "Agent「${name}」已经装好，直接启动（控制面的 install.sh 没变）"
		else
			say "控制面的 install.sh 变了（升级了控制面，或改了 SFLY_PUBLIC_URL、镜像），重新安装"
			reinstall_agent
		fi
	else
		say "Agent「${name}」已经装好，直接启动（取不到 $control_plane/install.sh，没有对版本）"
	fi
else
	say "从 $control_plane/install.sh 下载安装脚本"
	fetch_script retry || fail "下载 $control_plane/install.sh 失败：控制面起来了吗？地址在容器里连得到吗？"
	install_agent
fi

say "前台启动 Agent「${name}」"
# sfly、uv 在 ~/.local/bin：放在 PATH 最后，系统目录里有的命令不会被家目录里的盖掉。
PATH=$PATH:$home/.local/bin
export PATH
SFLY_TOKEN=$token
export SFLY_TOKEN
exec "$agent"
