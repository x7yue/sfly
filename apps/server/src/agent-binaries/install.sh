#!/bin/sh
# sfly Agent 一键安装脚本（ADR 0011）。由控制面 {{SFLY_URL}} 生成，地址、版本号和 sha256 已经填好：
#
#   curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --name <名称> [--token <Agent 凭据>] [--slots <槽位数>]
#     [--listen-port <端口>] [--public-address <地址>] [--no-auto-update] [--dev] [--no-service]
#   curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --dev     （开发机：Agent 的名字和凭据由控制面按你的登录生成）
#
# 识别 CPU 架构，从控制面下载 sfly Agent {{SFLY_VERSION}} 并校验 sha256，放到 $SFLY_HOME/bin（默认 ~/.sfly/bin），
# 写入 $SFLY_HOME/agent.env；root 运行时注册系统级 systemd 服务，普通用户运行时注册用户级服务。
# --dev 时再装好开发用的 uv（如果还没有）和 sfly CLI（从控制面的 sfly 索引 {{SFLY_URL}}/simple/）；
# --dev 不给 --name 时，装好 sfly CLI 之后用你的登录（SFLY_API_TOKEN 或 sfly login）向控制面注册自己的开发 Agent
# （sfly agent register-dev），名字（dev-<登录名>-<主机>）和凭据写进 agent.env。
# 重新运行即重新安装：替换二进制，改写 agent.env 里由本脚本管理的键（其他行保留），
# --dev 时把 sfly CLI 升级到控制面的版本；agent.env 里已有开发 Agent 的名字和凭据时沿用，不再注册。
#
# 整个脚本都在函数里，最后一行才调用 main：curl | sh 的下载中途断开时，sh 读到的半截脚本什么也不执行。
set -eu

SFLY_URL='{{SFLY_URL}}'
SFLY_GRPC_URL='{{SFLY_GRPC_URL}}'
SFLY_VERSION='{{SFLY_VERSION}}'
SHA256_X86_64='{{SHA256_X86_64}}'
SHA256_AARCH64='{{SHA256_AARCH64}}'
# 控制面配置的镜像（ADR 0012），未配置时为空；只在 --dev 安装 uv 和 sfly CLI 时以环境变量传给这一次的命令。
# 这里的地址是控制面去掉了用户名和密码的（这个脚本不用登录就能下载）；镜像要认证时，凭据放这台机器的 ~/.netrc（uv、curl、wget 都读它）。
# 本机可以用环境变量 SFLY_INDEX_URL、SFLY_GITHUB_RELEASE_MIRROR、SFLY_PYTHON_INSTALL_MIRROR 覆盖（与 Agent 相同），
# 覆盖值写进 agent.env，Agent 和 sfly init 也用它们。
# 下载时 curl、wget 带的 User-Agent 默认 sfly-agent/<版本>（镜像站会封禁它们的部分默认 User-Agent），
# 环境变量 SFLY_USER_AGENT 覆盖，覆盖值同样写进 agent.env。
PYPI_MIRROR='{{PYPI_MIRROR}}'
GITHUB_RELEASE_MIRROR='{{GITHUB_RELEASE_MIRROR}}'
# Agent 凭据原值的前缀（sfly_agt_）：--dev 重新运行时 agent.env 里只有这种凭据才沿用，共享令牌不算。
AGENT_CREDENTIAL_PREFIX='{{AGENT_CREDENTIAL_PREFIX}}'

# agent.env 里由本脚本管理的键（重新运行时改写），其余的行原样保留。
MANAGED_KEYS='SFLY_SERVER SFLY_CONTROL_PLANE_URL SFLY_AGENT_NAME SFLY_TOKEN SFLY_SLOTS SFLY_LISTEN_PORT SFLY_PUBLIC_ADDRESS SFLY_NO_AUTO_UPDATE SFLY_INDEX_URL SFLY_GITHUB_RELEASE_MIRROR SFLY_PYTHON_INSTALL_MIRROR SFLY_USER_AGENT'

usage() {
	cat <<EOF
用法：curl -fsSL $SFLY_URL/install.sh | sh -s -- --name <名称> [选项]

安装 sfly Agent $SFLY_VERSION，连接控制面 $SFLY_URL（Agent 网关 $SFLY_GRPC_URL）。

选项：
  --name <名称>      Agent 名称，全局唯一（必填；--dev 不给 --name 时由控制面生成：dev-<你的登录名>-<主机>）
  --token <凭据>     这台 Agent 的 Agent 凭据（sfly_agt_ 开头，管理员用 sfly agent credentials issue <名称> 签发，
                     只对签发时指定的名字有效）；推荐用环境变量 SFLY_TOKEN 传，不会出现在 shell 历史和进程列表里。
                     过渡期里控制面还接受共享注册令牌，或不带凭据的已登记的 Agent（下一个版本起拒绝）
  --slots <槽位数>   同时执行的任务上限（默认 4）
  --listen-port <端口>
                     供其它 Agent 连接的端口（默认 50052）；没有认证，只应在内网使用
  --public-address <地址>
                     其它 Agent 连接这台 Agent 用的地址（IP 地址或主机名，不带端口）；
                     默认用控制面看到的连接来源地址，多网卡或经过地址转换时设置
  --no-auto-update   不自动更新（agent.env 写入 SFLY_NO_AUTO_UPDATE=1）
  --dev              同时安装开发用的 uv（没有时）和 sfly CLI $SFLY_VERSION（uv tool install）；
                     不给 --name 时再用你的登录向控制面注册自己的开发 Agent，名字和凭据写进 agent.env：
                     已经登录（sfly login）或设置了 SFLY_API_TOKEN 就直接注册；没有、而且有终端，运行 sfly login；
                     没有终端又没有凭据时直接失败并说明怎么办（不会等着输入）
  --dev-host <主机名>
                     --dev 注册开发 Agent 时名字里「主机」那一段（默认本机的主机名，不带域名）：小写字母、数字、连字符，
                     最长 32 个字符；同一个人用同一个主机名只能注册一次，重名（两台机器的主机名一样）时换一个
  --no-service       不注册 systemd 服务（测试、容器里用），只打印前台启动命令
  -h, --help         显示本帮助

重新运行时 agent.env 里的其他键保留；没有传 --token、--slots、--listen-port、--public-address、
--no-auto-update，没有设置下面的镜像环境变量时沿用原来的值。--dev 重新运行时 agent.env 里已经有开发 Agent 的
名字（dev- 开头）和 Agent 凭据（sfly_agt_ 开头）就沿用，不再注册；要换成新的：先 sfly agent revoke-dev <名字>
（吊销之后才能重新注册），再删掉 agent.env 里的 SFLY_AGENT_NAME 和 SFLY_TOKEN 两行，重新运行。

环境变量：
  SFLY_HOME          安装目录（默认 ~/.sfly）
  SFLY_TOKEN         Agent 凭据（--token 优先），不会出现在 shell 历史和进程列表里
  SFLY_API_TOKEN     --dev 注册开发 Agent 用的个人令牌（控制台「令牌」页签发；没有时用 sfly login 的登录）
  SFLY_SYSTEMD_DIR   systemd 单元的写入目录（默认 root 为 /etc/systemd/system，
                     普通用户为 ~/.config/systemd/user）

本机镜像覆盖（只影响这台机器，写进 agent.env，Agent 和 sfly init 也用它们）：
  SFLY_INDEX_URL              PyPI 镜像（简单索引地址）
  SFLY_GITHUB_RELEASE_MIRROR  GitHub Release 镜像（安装和更新 uv）
  SFLY_PYTHON_INSTALL_MIRROR  Python 下载镜像（UV_PYTHON_INSTALL_MIRROR）
  优先级：这次设置的环境变量 > agent.env 里原有的值 > 控制面配置的镜像；Python 下载镜像没有设置时
  从 GitHub Release 镜像推导（<镜像>/astral-sh/python-build-standalone/）。
  控制面配置的 PyPI 镜像：${PYPI_MIRROR:-未配置}
  控制面配置的 GitHub Release 镜像：${GITHUB_RELEASE_MIRROR:-未配置}
  （上面两个地址不带用户名和密码：这个脚本不用登录就能下载。镜像要认证时，把凭据写进这台机器的 ~/.netrc，
  权限 600；也可以用上面的环境变量设一个带用户名和密码的地址，只对这台机器有效。）

  SFLY_USER_AGENT             下载时 curl、wget 带的 User-Agent（默认 sfly-agent/$SFLY_VERSION）；
                              镜像站封禁默认 User-Agent 时换成能看出机构或用途的值，例如 acme-lab-sfly/1.0。
                              同样写进 agent.env，Agent 安装和更新 uv 时也用它。
EOF
}

die() {
	echo "install.sh: $*" >&2
	exit 1
}

# shell 单引号写法（打印可以直接复制运行的命令）。
quote() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# systemd 单元里的值：% 要写成 %%。
unit_value() {
	printf '%s' "$1" | sed 's/%/%%/g'
}

# download <地址> <保存到> [netrc]：第三个参数是 netrc 时 curl 也读 ~/.netrc（只用在从镜像下载 uv 的安装脚本那一次：镜像要认证时凭据在那里；
# 下载 Agent 二进制不用：坏的 ~/.netrc 会让以前装得上的机器失败，default 项还会把凭据以 Basic 发给控制面）。
download() {
	if command -v curl >/dev/null 2>&1; then
		if [ "${3:-}" = netrc ]; then
			curl -fsSL --netrc-optional -A "$user_agent" -o "$2" "$1"
		else
			curl -fsSL -A "$user_agent" -o "$2" "$1"
		fi
	elif command -v wget >/dev/null 2>&1; then
		wget -q -U "$user_agent" -O "$2" "$1"
	else
		die "需要 curl 或 wget"
	fi
}

# 在目录 $1 下写 curl 和 wget 的配置（运行时设置 CURL_HOME=$1、WGETRC=$1/wgetrc），让第三方安装脚本里
# 改不了参数的 curl、wget 也带上 User-Agent。原有的 curlrc、wgetrc 照抄在前面，User-Agent 放最后（后出现的生效）；
# 设置 CURL_HOME 后老版本 curl 不再读 ~/.curlrc，所以要照抄。
# 文件建在子 shell 里、umask 077：里面照抄了用户自己的 ~/.curlrc（可能有 --user 之类的凭据），别人不该读到。
user_agent_config() (
	umask 077
	mkdir -p "$1"
	{
		for f in "${CURL_HOME:+$CURL_HOME/.curlrc}" "${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/curlrc}" "${HOME:+$HOME/.curlrc}"; do
			if [ -n "$f" ] && [ -f "$f" ]; then
				cat "$f" && echo
				break
			fi
		done
		printf 'user-agent = "%s"\n' "$user_agent"
		# 用镜像时：镜像要认证，凭据在 ~/.netrc 里，uv 的安装脚本里改不了参数的 curl 也要读它（没有 ~/.netrc 时不受影响）。
		# 没有镜像时不加：uv 从官方来源下载，不需要 ~/.netrc，也不能把里面 default 项的凭据发给官方来源。
		if [ -n "${mirror:-}" ]; then printf 'netrc-optional\n'; fi
	} >"$1/.curlrc"
	{
		f=${WGETRC:-${HOME:+$HOME/.wgetrc}}
		if [ -n "$f" ] && [ -f "$f" ]; then cat "$f" && echo; fi
		printf 'user_agent = %s\n' "$user_agent"
	} >"$1/wgetrc"
)

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		die "需要 sha256sum 或 shasum 校验下载的文件"
	fi
}

# 不在 PATH 上的目录：提示加进 PATH。
path_hint() {
	case :${PATH:-}: in
	*:"$1":*) ;;
	*) echo "$1 不在 PATH 上，请把它加进 shell 配置：export PATH=$(quote "$1"):\"\$PATH\"" ;;
	esac
}

parse_args() {
	name=
	token=${SFLY_TOKEN:-}
	api_token=${SFLY_API_TOKEN:-}
	# 凭据只留在这两个 shell 变量里：环境里的拷贝去掉，之后起的子进程（下载、uv 和它的安装脚本、装 sfly CLI 的 uv、
	# systemctl）都看不到它们。注册开发 Agent 时，个人令牌只交给 sfly CLI 那一个进程（register_dev_agent）。
	unset SFLY_TOKEN SFLY_API_TOKEN
	slots=
	listen_port=
	public_address=
	no_auto_update=0
	service=1
	dev=0
	dev_host=
	while [ $# -gt 0 ]; do
		case $1 in
		--name | --token | --slots | --listen-port | --public-address | --dev-host)
			[ $# -ge 2 ] || die "$1 需要一个值"
			case $1 in
			--name) name=$2 ;;
			--token) token=$2 ;;
			--slots) slots=$2 ;;
			--listen-port) listen_port=$2 ;;
			--public-address) public_address=$2 ;;
			--dev-host) dev_host=$2 ;;
			esac
			shift 2
			;;
		--name=*) name=${1#*=} && shift ;;
		--token=*) token=${1#*=} && shift ;;
		--slots=*) slots=${1#*=} && shift ;;
		--listen-port=*) listen_port=${1#*=} && shift ;;
		--public-address=*) public_address=${1#*=} && shift ;;
		--dev-host=*) dev_host=${1#*=} && shift ;;
		--no-auto-update) no_auto_update=1 && shift ;;
		--no-service) service=0 && shift ;;
		--dev) dev=1 && shift ;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "未知参数 $1（--help 查看用法）" ;;
		esac
	done

	# --dev 不给 --name：Agent 的名字和凭据由控制面按你的登录生成（装好 sfly CLI 之后注册，register_dev_agent）。
	dev_register=0
	if [ -z "$name" ] && [ "$dev" = 1 ]; then
		dev_register=1
		[ -z "$token" ] ||
			die "--dev 不给 --name 时，Agent 的名字和凭据都由控制面生成，不能再给 --token（或设置 SFLY_TOKEN）：自己起名字、用管理员签发的凭据时，同时给 --name 和 --token"
	fi
	[ "$dev_register" = 1 ] || [ -n "$name" ] || die "缺少 --name <名称>（--help 查看用法）"
	if [ -n "$dev_host" ]; then
		[ "$dev_register" = 1 ] || die "--dev-host 只用于 --dev 不给 --name 时（开发 Agent 的名字由控制面生成）"
		case $dev_host in
		*[!a-z0-9-]* | -* | *- | "") die "--dev-host 只能是小写字母、数字和连字符，不以连字符开头或结尾：$dev_host" ;;
		esac
		[ "${#dev_host}" -le 32 ] || die "--dev-host 最长 32 个字符：$dev_host"
	fi
	newline='
'
	for value in "$name" "$token"; do
		case $value in *"$newline"*) die "--name 和 --token 不能包含换行" ;; esac
	done
	if [ -n "$slots" ]; then
		case $slots in '' | *[!0-9]* | 0 | 0*) die "--slots 必须是正整数：$slots" ;; esac
	fi
	if [ -n "$listen_port" ]; then
		case $listen_port in
		*[!0-9]* | 0*) die "--listen-port 必须是 1–65535 的整数：$listen_port" ;;
		esac
		[ "${#listen_port}" -le 5 ] && [ "$listen_port" -le 65535 ] ||
			die "--listen-port 必须是 1–65535 的整数：$listen_port"
	fi
	if [ -n "$public_address" ]; then
		valid_address "$public_address" ||
			die "--public-address 只能是 IP 地址或主机名（不带协议和端口）：$public_address"
	fi
}

# 对外地址的粗略检查（Agent 启动时再严格校验）：主机名或 IPv4（字母、数字、. 和 -），
# 或 IPv6（十六进制数字、. 和至少两个 :）。带协议、端口、空白的都不行。
valid_address() {
	case $1 in
	*[!0-9A-Za-z.:-]* | -* | .*) return 1 ;;
	*:*:*) case $1 in *[!0-9A-Fa-f.:]*) return 1 ;; esac ;;
	*:*) return 1 ;;
	esac
}

detect_platform() {
	[ "$(uname -s)" = Linux ] || die "sfly Agent 只支持 Linux（当前系统：$(uname -s)）"
	case $(uname -m) in
	x86_64 | amd64) arch=x86_64 sha256=$SHA256_X86_64 ;;
	aarch64 | arm64) arch=aarch64 sha256=$SHA256_AARCH64 ;;
	*) die "不支持的 CPU 架构 $(uname -m)（支持 x86_64、aarch64）" ;;
	esac
	[ -n "$sha256" ] || die "控制面没有 $arch 架构的 Agent $SFLY_VERSION"

	if [ -z "${SFLY_HOME:-}" ]; then
		[ -n "${HOME:-}" ] || die "没有设置 HOME，请用 SFLY_HOME 指定安装目录"
		SFLY_HOME=$HOME/.sfly
	fi
	case $SFLY_HOME in /*) ;; *) SFLY_HOME=$(pwd)/$SFLY_HOME ;; esac
	bin=$SFLY_HOME/bin
	agent=$bin/sfly-agent
	env_file=$SFLY_HOME/agent.env
}

# 下载用的 User-Agent：这次设置的 SFLY_USER_AGENT > agent.env 里原有的值 > sfly-agent/<版本>。
# 要原样写进 curlrc 的引号里和 wgetrc：只允许可打印 ASCII，不能有 " 和 \。
resolve_user_agent() {
	local_user_agent=${SFLY_USER_AGENT:-$(env_value SFLY_USER_AGENT)}
	user_agent=${local_user_agent:-sfly-agent/$SFLY_VERSION}
	bad_user_agent="SFLY_USER_AGENT 只能包含可打印 ASCII 字符，不能有 \" 和 \\：$user_agent"
	case $user_agent in *"$newline"* | *'"'* | *\\*) die "$bad_user_agent" ;; esac
	[ -z "$(printf '%s' "$user_agent" | LC_ALL=C sed 's/[ -~]//g')" ] || die "$bad_user_agent"
}

# 下载到同一目录的临时文件，校验、试运行通过后，与自更新一样持有 bin/.sfly-agent.lock 再 rename 覆盖
# （ADR 0014：同一 SFLY_HOME 下的 Agent 自更新和安装脚本不会同时替换；正在运行的 Agent 不受影响）。
install_agent() {
	mkdir -p "$bin"
	url=$SFLY_URL/agent/binaries/$SFLY_VERSION/$arch
	echo "下载 sfly Agent $SFLY_VERSION（$arch）：$url"
	download "$url" "$tmp" || die "下载失败：$url"
	actual=$(sha256_of "$tmp")
	[ "$actual" = "$sha256" ] || die "sha256 校验失败：应为 $sha256，下载的文件是 $actual"
	chmod 755 "$tmp"
	"$tmp" --version >/dev/null 2>&1 || die "下载的 Agent 无法运行：$url"

	lock=$bin/.sfly-agent.lock
	if command -v flock >/dev/null 2>&1; then
		exec 9>>"$lock"
		if ! flock -n 9; then
			echo "等待 $lock：同一 SFLY_HOME 下的 Agent 正在替换二进制……"
			flock 9
		fi
	else
		echo "install.sh: 没有 flock，替换 Agent 二进制时不加锁" >&2
	fi
	mv -f "$tmp" "$agent"
	exec 9>&-

	# 安装后首次启动时 Agent 更新一次 uv（ADR 0012；Agent 执行后删除这个标记）。
	: >"$bin/.uv-update"
}

# agent.env 里 `key` 的值（最后一次出现的；没有时为空）。与 Agent 的读取规则相同：去掉两侧空白和成对的引号。
env_value() {
	[ -f "$env_file" ] || return 0
	sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$env_file" | sed -n '$p' |
		sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# 原有 agent.env 里不由本脚本管理的行（去掉本脚本写的说明）。
unmanaged_lines() {
	[ -f "$env_file" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		case $line in "# sfly Agent 配置，由 "* | "# 每行 KEY=VALUE，"*) continue ;; esac
		key=$(printf '%s\n' "$line" | sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\1/p')
		case " $MANAGED_KEYS " in *" $key "*) continue ;; esac
		printf '%s\n' "$line"
	done <"$env_file"
}

# 本机镜像覆盖（这次设置的环境变量 > agent.env 里原有的值）：安装 uv 和 sfly CLI（install_dev）和写 agent.env 都用它们，
# 所以在两者之前取得。
resolve_mirror_overrides() {
	local_index_url=${SFLY_INDEX_URL:-$(env_value SFLY_INDEX_URL)}
	local_release_mirror=${SFLY_GITHUB_RELEASE_MIRROR:-$(env_value SFLY_GITHUB_RELEASE_MIRROR)}
	local_python_mirror=${SFLY_PYTHON_INSTALL_MIRROR:-$(env_value SFLY_PYTHON_INSTALL_MIRROR)}
	for value in "$local_index_url" "$local_release_mirror" "$local_python_mirror"; do
		case $value in *"$newline"*) die "镜像地址不能包含换行" ;; esac
	done
}

# 写入 agent.env：本脚本管理的键按这次的参数写（没有传令牌、槽位数、端口、对外地址、--no-auto-update、没有设置镜像环境变量时
# 沿用原来的值），其他行保留。配置文件里有令牌：只有当前用户可读。
write_env_file() {
	[ -n "$token" ] || token=$(env_value SFLY_TOKEN)
	[ -n "$slots" ] || slots=$(env_value SFLY_SLOTS)
	[ -n "$listen_port" ] || listen_port=$(env_value SFLY_LISTEN_PORT)
	[ -n "$public_address" ] || public_address=$(env_value SFLY_PUBLIC_ADDRESS)
	if [ "$no_auto_update" = 1 ]; then
		no_auto_update_value=1
	else
		no_auto_update_value=$(env_value SFLY_NO_AUTO_UPDATE)
	fi
	# 事先存在的临时文件（别的权限、别人留下的）不能被写成 agent.env：先删掉，再用 umask 077 新建。
	rm -f "$env_file.tmp"
	(
		umask 077
		{
			echo "# sfly Agent 配置，由 $SFLY_URL/install.sh 生成；重新运行 install.sh 只改写它管理的键，其他行保留。"
			echo "# 每行 KEY=VALUE，命令行参数和环境变量优先（sfly-agent --help）。"
			echo "SFLY_SERVER=$SFLY_GRPC_URL"
			echo "SFLY_CONTROL_PLANE_URL=$SFLY_URL"
			echo "SFLY_AGENT_NAME=$name"
			if [ -n "$token" ]; then echo "SFLY_TOKEN=$token"; fi
			if [ -n "$slots" ]; then echo "SFLY_SLOTS=$slots"; fi
			if [ -n "$listen_port" ]; then echo "SFLY_LISTEN_PORT=$listen_port"; fi
			if [ -n "$public_address" ]; then echo "SFLY_PUBLIC_ADDRESS=$public_address"; fi
			if [ -n "$no_auto_update_value" ]; then echo "SFLY_NO_AUTO_UPDATE=$no_auto_update_value"; fi
			if [ -n "$local_index_url" ]; then echo "SFLY_INDEX_URL=$local_index_url"; fi
			if [ -n "$local_release_mirror" ]; then echo "SFLY_GITHUB_RELEASE_MIRROR=$local_release_mirror"; fi
			if [ -n "$local_python_mirror" ]; then echo "SFLY_PYTHON_INSTALL_MIRROR=$local_python_mirror"; fi
			if [ -n "$local_user_agent" ]; then echo "SFLY_USER_AGENT=$local_user_agent"; fi
			unmanaged_lines
		} >"$env_file.tmp"
	)
	mv -f "$env_file.tmp" "$env_file"
	echo "已安装 $agent，配置写入 $env_file"
}

# --dev：开发用的 uv 和 sfly CLI（ADR 0011）。镜像只以环境变量传给这一次的命令，不写进任何 uv 配置；
# 本机覆盖（write_env_file 里取得的）优先于控制面配置的镜像。
install_dev() {
	if [ -z "${XDG_BIN_HOME:-}" ] && [ -z "${HOME:-}" ]; then
		die "--dev 需要 HOME（或 XDG_BIN_HOME）来确定 uv 和 sfly 的安装位置"
	fi
	user_bin=${XDG_BIN_HOME:-$HOME/.local/bin}
	mirror=${local_release_mirror:-$GITHUB_RELEASE_MIRROR}
	mirror=${mirror%/}
	pypi_mirror=${local_index_url:-$PYPI_MIRROR}
	python_mirror=$local_python_mirror
	if [ -z "$python_mirror" ] && [ -n "$mirror" ]; then
		python_mirror=$mirror/astral-sh/python-build-standalone/
	fi
	if command -v uv >/dev/null 2>&1; then
		uv=$(command -v uv)
	elif [ -x "$user_bin/uv" ]; then
		uv=$user_bin/uv
	else
		# 与 Agent 安装 uv 的方式相同（ADR 0012）：有 GitHub Release 镜像时用镜像上的安装脚本和发布包。
		if [ -n "$mirror" ]; then
			installer_url=$mirror/astral-sh/uv/LatestRelease/uv-installer.sh
		else
			installer_url=https://astral.sh/uv/install.sh
		fi
		echo "安装 uv 到 $user_bin：$installer_url"
		download "$installer_url" "$uv_installer" ${mirror:+netrc} || die "下载 uv 安装脚本失败：$installer_url"
		user_agent_config "$user_agent_dir"
		(
			export UV_INSTALL_DIR="$user_bin" UV_NO_MODIFY_PATH=1
			export CURL_HOME="$user_agent_dir" WGETRC="$user_agent_dir/wgetrc"
			if [ -n "$mirror" ]; then export UV_DOWNLOAD_URL="$mirror/astral-sh/uv/LatestRelease"; fi
			sh "$uv_installer"
		) || die "安装 uv 失败（安装脚本 $installer_url）"
		uv=$user_bin/uv
		[ -x "$uv" ] || die "uv 安装脚本没有生成 $uv"
	fi

	# sfly 只从控制面的 sfly 索引解析（uv 默认只用第一个有这个包的索引），其余依赖走 PyPI 镜像。
	# 版本锁定为控制面版本：重新运行时要求变了，uv tool install 会换成新版本。
	echo "安装 sfly CLI $SFLY_VERSION：$SFLY_URL/simple/"
	(
		if [ -n "$python_mirror" ]; then export UV_PYTHON_INSTALL_MIRROR="$python_mirror"; fi
		set -- tool install --index "sfly=$SFLY_URL/simple/"
		if [ -n "$pypi_mirror" ]; then set -- "$@" --default-index "$pypi_mirror"; fi
		"$uv" "$@" "sfly[cli]==$SFLY_VERSION"
	) || die "安装 sfly CLI 失败"
	tool_bin=$("$uv" tool dir --bin)
	echo "已安装 sfly CLI $SFLY_VERSION：$tool_bin/sfly"
	path_hint "$tool_bin"
	[ "$(dirname "$uv")" = "$tool_bin" ] || path_hint "$(dirname "$uv")"
}

# 终端：能打开 /dev/tty 就算有（curl | sh 时 stdin 是脚本，不是终端；ssh 不带 -t 运行命令、CI 里打不开）。
have_terminal() {
	(: </dev/tty) 2>/dev/null
}

# --dev 不给 --name：向控制面注册自己的开发 Agent，得到名字和凭据（设置 name、token，之后由 write_env_file 写进 agent.env）。
# 用 install_dev 装好的 sfly CLI：`sfly agent register-dev --env` 把 SFLY_AGENT_NAME=…、SFLY_TOKEN=… 两行写到标准输出，
# 这里只放在 shell 变量里，不经过命令行参数、不打印。
register_dev_agent() {
	# 重新运行（升级）：agent.env 里已经有开发 Agent 的名字和凭据就沿用：同一个人在同一个项目里用同一个主机名只能注册一次，
	# 再注册会撞「已经有一台叫……」。
	# 只沿用 Agent 凭据：旧版本 --dev 装的开发机里是共享令牌（下一个版本起控制面不再收），不沿用，照常注册新的。
	existing_name=$(env_value SFLY_AGENT_NAME)
	existing_token=$(env_value SFLY_TOKEN)
	case $existing_name in
	dev-*)
		case $existing_token in
		"$AGENT_CREDENTIAL_PREFIX"?*)
			name=$existing_name
			echo "沿用 $env_file 里已有的开发 Agent $name（要换成新的：先 sfly agent revoke-dev $name，再删掉其中的 SFLY_AGENT_NAME 和 SFLY_TOKEN 两行，重新运行）"
			return 0
			;;
		esac
		;;
	esac

	sfly=$tool_bin/sfly
	[ -x "$sfly" ] || die "找不到 $sfly：sfly CLI 没有装好，无法注册开发 Agent"
	attempt=1
	while :; do
		status=0
		if [ -n "$dev_host" ]; then set -- --host "$dev_host"; else set --; fi
		# 个人令牌（SFLY_API_TOKEN）只放进这一个进程的环境：不经过命令行参数。
		if [ -n "$api_token" ]; then
			registered=$(SFLY_API_TOKEN=$api_token SFLY_HOME=$SFLY_HOME "$sfly" agent register-dev --server "$SFLY_URL" "$@" --env) || status=$?
		else
			registered=$(SFLY_HOME=$SFLY_HOME "$sfly" agent register-dev --server "$SFLY_URL" "$@" --env) || status=$?
		fi
		[ "$status" != 0 ] || break
		if [ "$status" = 5 ] && [ "$attempt" = 1 ] && have_terminal; then
			# 没有登录：有终端就让他登录（sfly login 问登录名和密码，从终端读），再注册一次。
			echo "注册开发 Agent 要用你自己的身份，先登录 $SFLY_URL："
			SFLY_HOME=$SFLY_HOME "$sfly" login --server "$SFLY_URL" </dev/tty || die "登录没有成功，没有注册开发 Agent。重新运行同一条命令即可（Agent 二进制和 sfly CLI 已经装好）"
			attempt=2
			continue
		fi
		if [ "$status" = 5 ]; then
			cat >&2 <<EOF
install.sh: 注册开发 Agent 要用你自己的身份（登录或个人令牌），这里没有，也没有终端可以问你。任选一个办法后重新运行同一条命令
（Agent 二进制和 sfly CLI 已经装好，重新运行是幂等的）：
  - 设置环境变量 SFLY_API_TOKEN（个人令牌：控制台的「令牌」页签发，或在别处 sfly login 后签发）：
      read -rs SFLY_API_TOKEN && export SFLY_API_TOKEN
  - 在这台机器的终端里先登录：sfly login --server $SFLY_URL
  - 不用开发 Agent：不加 --dev 的 Agent 用管理员签发的 Agent 凭据（sfly agent credentials issue <名称>），
    要装开发工具的话同时给 --dev --name <名称> 和 SFLY_TOKEN
EOF
			exit 1
		fi
		if [ "$status" = 6 ]; then
			cat >&2 <<EOF
install.sh: 这个名字已经被占用了（上面是控制面的说明）。选一个办法后重新运行同一条命令（Agent 二进制和 sfly CLI 已经装好）：
  - 换一个名字：加 --dev-host <另一个主机名>（名字里「主机」那一段）
  - 这个名字是你自己以前注册的开发 Agent（比如换了 agent.env）：先 sfly agent revoke-dev <上面的名字>，再重新运行
  - 这个名字是旧版本 --dev 装的开发机的名字：请管理员为它签发凭据（sfly agent credentials issue <名字>），
    然后同时给 --dev --name <名字>，凭据经环境变量 SFLY_TOKEN 给
EOF
			exit 1
		fi
		die "注册开发 Agent 失败（上面是原因）。解决之后重新运行同一条命令即可（Agent 二进制和 sfly CLI 已经装好）"
	done
	name=$(printf '%s\n' "$registered" | sed -n 's/^SFLY_AGENT_NAME=//p')
	token=$(printf '%s\n' "$registered" | sed -n 's/^SFLY_TOKEN=//p')
	registered=
	[ -n "$name" ] && [ -n "$token" ] || die "sfly agent register-dev 的输出里没有 Agent 名字和凭据：sfly CLI 和控制面的版本是否一致？"
	echo "已注册开发 Agent $name，凭据写进 $env_file（只有你读得到）"
}

register_service() {
	foreground="SFLY_HOME=$(quote "$SFLY_HOME") $(quote "$agent")"

	if [ "$service" = 0 ]; then
		echo "已跳过注册 systemd 服务。前台启动：$foreground"
		return 0
	fi
	if ! command -v systemctl >/dev/null 2>&1; then
		echo "没有 systemd（找不到 systemctl），没有注册服务。前台启动：$foreground"
		return 0
	fi

	if [ "$(id -u)" = 0 ]; then
		unit_dir=${SFLY_SYSTEMD_DIR:-/etc/systemd/system}
		systemctl=systemctl
		wants='Wants=network-online.target
After=network-online.target
'
		wanted_by=multi-user.target
	else
		unit_dir=${SFLY_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}
		systemctl='systemctl --user'
		wants=
		wanted_by=default.target
	fi
	unit=$unit_dir/sfly-agent.service
	mkdir -p "$unit_dir"
	cat >"$unit" <<EOF
[Unit]
Description=sfly Agent（控制面 $(unit_value "$SFLY_URL")）
$wants
[Service]
Environment="SFLY_HOME=$(unit_value "$SFLY_HOME")"
ExecStart="$(unit_value "$agent")"
Restart=on-failure
RestartSec=5
# 环境准备失败（退出码 78）时不再重启：查看 journalctl 里 Agent 打印的报告。
RestartPreventExitStatus=78

[Install]
WantedBy=$wanted_by
EOF
	echo "已写入 systemd 服务 $unit"

	if $systemctl daemon-reload && $systemctl enable sfly-agent.service && $systemctl restart sfly-agent.service; then
		echo "sfly-agent 服务已启动；查看日志：journalctl $([ "$systemctl" = systemctl ] || echo '--user ')-u sfly-agent -f"
	else
		echo "启动 sfly-agent 服务失败，可以手动前台启动：$foreground" >&2
	fi
	if [ "$systemctl" != systemctl ]; then
		echo "用户级服务只在你登录时运行；要开机即运行，执行 loginctl enable-linger $(id -un)。"
		echo "也可以前台启动：$foreground"
	fi
}

main() {
	parse_args "$@"
	detect_platform
	tmp=$bin/.sfly-agent.download.$$
	uv_installer=$bin/.uv-installer.$$.sh
	user_agent_dir=$bin/.user-agent.$$
	trap 'rm -rf "$tmp" "$uv_installer" "$user_agent_dir"' EXIT
	resolve_user_agent
	resolve_mirror_overrides
	install_agent
	if [ "$dev_register" = 1 ]; then
		# 开发 Agent 的名字和凭据要装好 sfly CLI 之后才拿得到：agent.env 在注册之后才写（失败时不留半截配置，重新运行即可）。
		install_dev
		register_dev_agent
		write_env_file
	else
		write_env_file
		if [ "$dev" = 1 ]; then install_dev; fi
	fi
	register_service
}

main "$@"
