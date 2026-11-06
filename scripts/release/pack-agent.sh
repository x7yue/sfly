#!/usr/bin/env bash
# 构建并打包 Agent 发布物（ADR 0010）：musl 静态链接，不依赖目标机器的 glibc，老版本系统也能运行。
#   scripts/release/pack-agent.sh <target>
#     target：x86_64-unknown-linux-musl 或 aarch64-unknown-linux-musl
# 在与 target 同架构的机器上运行（CI 分别用 x86_64 和 arm64 runner），这样能直接运行产物做检查。
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

if command -v rustup >/dev/null; then rustup target add "$target" >/dev/null; fi
CARGO_PROFILE_RELEASE_STRIP=symbols cargo build --release --locked -p sfly-agent --target "$target"
bin=target/$target/release/sfly-agent

if readelf --dynamic "$bin" | grep -q NEEDED; then
	echo "$bin 不是静态链接：" >&2
	readelf --dynamic "$bin" | grep NEEDED >&2
	exit 1
fi
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

mkdir -p out/agent
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
install -m 0755 "$bin" "$staging/sfly-agent"
tar -C "$staging" --owner=0 --group=0 -czf "out/agent/$name.tar.gz" sfly-agent
(cd out/agent && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
echo "out/agent/$name.tar.gz"
