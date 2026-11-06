#!/bin/sh
# sfly Agent 一键安装脚本（ADR 0011）。由控制面 {{SFLY_URL}} 生成，地址、版本号和 sha256 已经填好：
#
#   curl -fsSL {{SFLY_URL}}/install.sh | sh -s -- --name <名称> [--token <令牌>] [--slots <槽位数>] [--dev] [--no-service]
#
# 识别 CPU 架构，从控制面下载 sfly Agent {{SFLY_VERSION}} 并校验 sha256，放到 $SFLY_HOME/bin（默认 ~/.sfly/bin），
# 写入 $SFLY_HOME/agent.env；root 运行时注册系统级 systemd 服务，普通用户运行时注册用户级服务。
# --dev 时再装好开发用的 uv（如果还没有）和 sfly CLI（从控制面的 sfly 索引 {{SFLY_URL}}/simple/）。
# 重新运行即重新安装（覆盖二进制和 agent.env，--dev 时把 sfly CLI 升级到控制面的版本）。
set -eu

SFLY_URL='{{SFLY_URL}}'
SFLY_GRPC_URL='{{SFLY_GRPC_URL}}'
SFLY_VERSION='{{SFLY_VERSION}}'
SHA256_X86_64='{{SHA256_X86_64}}'
SHA256_AARCH64='{{SHA256_AARCH64}}'
# 控制面配置的镜像（ADR 0012），未配置时为空；只在 --dev 安装 uv 和 sfly CLI 时以环境变量传给这一次的命令。
PYPI_MIRROR='{{PYPI_MIRROR}}'
GITHUB_RELEASE_MIRROR='{{GITHUB_RELEASE_MIRROR}}'

usage() {
	cat <<EOF
用法：curl -fsSL $SFLY_URL/install.sh | sh -s -- --name <名称> [选项]

安装 sfly Agent $SFLY_VERSION，连接控制面 $SFLY_URL（Agent 网关 $SFLY_GRPC_URL）。

选项：
  --name <名称>      Agent 名称，全局唯一（必填）
  --token <令牌>     共享注册令牌（控制面配置了 SFLY_AGENT_TOKEN 时必填）
  --slots <槽位数>   同时执行的任务上限（默认 4）
  --dev              同时安装开发用的 uv（没有时）和 sfly CLI $SFLY_VERSION（uv tool install）
  --no-service       不注册 systemd 服务（测试、容器里用），只打印前台启动命令
  -h, --help         显示本帮助

环境变量：
  SFLY_HOME          安装目录（默认 ~/.sfly）
  SFLY_SYSTEMD_DIR   systemd 单元的写入目录（默认 root 为 /etc/systemd/system，
                     普通用户为 ~/.config/systemd/user）
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

name=
token=
slots=
service=1
dev=0
while [ $# -gt 0 ]; do
	case $1 in
	--name | --token | --slots)
		[ $# -ge 2 ] || die "$1 需要一个值"
		case $1 in
		--name) name=$2 ;;
		--token) token=$2 ;;
		--slots) slots=$2 ;;
		esac
		shift 2
		;;
	--name=*) name=${1#*=} && shift ;;
	--token=*) token=${1#*=} && shift ;;
	--slots=*) slots=${1#*=} && shift ;;
	--no-service) service=0 && shift ;;
	--dev) dev=1 && shift ;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "未知参数 $1（--help 查看用法）" ;;
	esac
done

[ -n "$name" ] || die "缺少 --name <名称>（--help 查看用法）"
newline='
'
for value in "$name" "$token"; do
	case $value in *"$newline"*) die "--name 和 --token 不能包含换行" ;; esac
done
if [ -n "$slots" ]; then
	case $slots in '' | *[!0-9]* | 0 | 0*) die "--slots 必须是正整数：$slots" ;; esac
fi

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

download() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		die "需要 curl 或 wget"
	fi
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		die "需要 sha256sum 或 shasum 校验下载的文件"
	fi
}

# 下载到同一目录的临时文件，校验通过后 rename 覆盖（正在运行的 Agent 不受影响）。
mkdir -p "$bin"
tmp=$bin/.sfly-agent.download.$$
uv_installer=$bin/.uv-installer.$$.sh
trap 'rm -f "$tmp" "$uv_installer"' EXIT
url=$SFLY_URL/agent/binaries/$SFLY_VERSION/$arch
echo "下载 sfly Agent $SFLY_VERSION（$arch）：$url"
download "$url" "$tmp" || die "下载失败：$url"
actual=$(sha256_of "$tmp")
[ "$actual" = "$sha256" ] || die "sha256 校验失败：应为 $sha256，下载的文件是 $actual"
chmod 755 "$tmp"
"$tmp" --version >/dev/null 2>&1 || die "下载的 Agent 无法运行：$url"
mv -f "$tmp" "$agent"

# 安装后首次启动时 Agent 更新一次 uv（ADR 0012；Agent 执行后删除这个标记）。
: >"$bin/.uv-update"

# 配置文件里有令牌：只有当前用户可读。
env_file=$SFLY_HOME/agent.env
(
	umask 077
	{
		echo "# sfly Agent 配置，由 $SFLY_URL/install.sh 生成；重新运行 install.sh 会覆盖这个文件。"
		echo "# 每行 KEY=VALUE，命令行参数和环境变量优先（sfly-agent --help）。"
		echo "SFLY_SERVER=$SFLY_GRPC_URL"
		echo "SFLY_CONTROL_PLANE_URL=$SFLY_URL"
		echo "SFLY_AGENT_NAME=$name"
		if [ -n "$token" ]; then echo "SFLY_TOKEN=$token"; fi
		if [ -n "$slots" ]; then echo "SFLY_SLOTS=$slots"; fi
	} >"$env_file.tmp"
)
mv -f "$env_file.tmp" "$env_file"
echo "已安装 $agent，配置写入 $env_file"

# 不在 PATH 上的目录：提示加进 PATH。
path_hint() {
	case :${PATH:-}: in
	*:"$1":*) ;;
	*) echo "$1 不在 PATH 上，请把它加进 shell 配置：export PATH=$(quote "$1"):\"\$PATH\"" ;;
	esac
}

# --dev：开发用的 uv 和 sfly CLI（ADR 0011）。镜像只以环境变量传给这一次的命令，不写进任何 uv 配置。
if [ "$dev" = 1 ]; then
	if [ -z "${XDG_BIN_HOME:-}" ] && [ -z "${HOME:-}" ]; then
		die "--dev 需要 HOME（或 XDG_BIN_HOME）来确定 uv 和 sfly 的安装位置"
	fi
	user_bin=${XDG_BIN_HOME:-$HOME/.local/bin}
	mirror=${GITHUB_RELEASE_MIRROR%/}
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
		download "$installer_url" "$uv_installer" || die "下载 uv 安装脚本失败：$installer_url"
		(
			export UV_INSTALL_DIR="$user_bin" UV_NO_MODIFY_PATH=1
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
		if [ -n "$mirror" ]; then
			export UV_PYTHON_INSTALL_MIRROR="$mirror/astral-sh/python-build-standalone/"
		fi
		set -- tool install --index "sfly=$SFLY_URL/simple/"
		if [ -n "$PYPI_MIRROR" ]; then set -- "$@" --default-index "$PYPI_MIRROR"; fi
		"$uv" "$@" "sfly[cli]==$SFLY_VERSION"
	) || die "安装 sfly CLI 失败"
	tool_bin=$("$uv" tool dir --bin)
	echo "已安装 sfly CLI $SFLY_VERSION：$tool_bin/sfly"
	path_hint "$tool_bin"
	[ "$(dirname "$uv")" = "$tool_bin" ] || path_hint "$(dirname "$uv")"
fi

foreground="SFLY_HOME=$(quote "$SFLY_HOME") $(quote "$agent")"

if [ "$service" = 0 ]; then
	echo "已跳过注册 systemd 服务。前台启动：$foreground"
	exit 0
fi
if ! command -v systemctl >/dev/null 2>&1; then
	echo "没有 systemd（找不到 systemctl），没有注册服务。前台启动：$foreground"
	exit 0
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
