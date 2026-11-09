#!/usr/bin/env bash
# 构建并打包 Agent 发布物（ADR 0010）：musl 静态链接，不依赖目标机器的 glibc，老版本系统也能运行。
#   scripts/release/pack-agent.sh <target>
#     target：x86_64-unknown-linux-musl 或 aarch64-unknown-linux-musl
# 发布时在与 target 同架构的机器上运行（CI 分别用 x86_64 和 arm64 runner），这样能直接运行产物做检查。
# 在别的架构上交叉编译时（CI 的检查、本机的 `pnpm pack:agents`，给 test:image 用）用 rust-lld 链接
# （Agent 没有 C 依赖），不能运行产物，只检查 ELF 的架构。
# 产物在 out/agent/：sfly-agent-<版本>-<target>.tar.gz（内含 sfly-agent）及同名 .sha256。
set -euo pipefail
cd "$(dirname "$0")/../.."

target=${1:?用法：pack-agent.sh <target>（例如 x86_64-unknown-linux-musl）}
case $target in
x86_64-unknown-linux-musl | aarch64-unknown-linux-musl) ;;
*)
	echo "不支持的 target：$target" >&2
	exit 2
	;;
esac
version=$(bash scripts/release/version.sh check)
name=sfly-agent-$version-$target
arch=${target%%-*}
native=false
[[ $(uname -m) == "$arch" ]] && native=true

if command -v rustup >/dev/null; then rustup target add "$target" >/dev/null; fi
if ! $native; then
	linker_var=CARGO_TARGET_$(tr '[:lower:]-' '[:upper:]_' <<<"$target")_LINKER
	export "$linker_var=${!linker_var:-rust-lld}"
fi
CARGO_PROFILE_RELEASE_STRIP=symbols cargo build --release --locked -p sfly-agent --target "$target"
bin=${CARGO_TARGET_DIR:-target}/$target/release/sfly-agent

# 先取完整输出再检查：`readelf | grep -q` 在 pipefail 下会因 SIGPIPE 把匹配到误报为失败。
dynamic=$(readelf --dynamic "$bin")
if grep -q NEEDED <<<"$dynamic"; then
	echo "$bin 不是静态链接：" >&2
	grep NEEDED <<<"$dynamic" >&2
	exit 1
fi
machine=$(LC_ALL=C readelf --file-header "$bin")
expected_machine=$([[ $arch == x86_64 ]] && echo 'X86-64' || echo 'AArch64')
if ! grep -q "Machine:.*$expected_machine" <<<"$machine"; then
	echo "$bin 不是 $arch 的可执行文件：" >&2
	grep Machine <<<"$machine" >&2
	exit 1
fi
if $native; then
	reported=$("$bin" --version)
	if [[ $reported != "sfly-agent $version" ]]; then
		echo "$bin --version 输出 '$reported'，应为 'sfly-agent $version'" >&2
		exit 1
	fi
	# 在老系统（CentOS 7，glibc 2.17）里能运行；没有 docker 时跳过。
	if command -v docker >/dev/null; then
		docker run --rm -v "$PWD/$bin:/sfly-agent:ro" centos:7 /sfly-agent --version >/dev/null
		echo "已在 centos:7 中验证 $bin"
	else
		echo "没有 docker，跳过 centos:7 验证" >&2
	fi
else
	echo "交叉编译的 $bin 不能在本机运行，跳过 --version 与 centos:7 验证" >&2
fi

mkdir -p out/agent
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
install -m 0755 "$bin" "$staging/sfly-agent"
tar -C "$staging" --owner=0 --group=0 -czf "out/agent/$name.tar.gz" sfly-agent
(cd out/agent && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
echo "out/agent/$name.tar.gz"
