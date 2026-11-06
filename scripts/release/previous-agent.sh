#!/usr/bin/env bash
# 准备跨版本自更新测试（`pnpm test:bundle`，ADR 0014）用的「上一个 Release 的 Agent」，放到 out/previous-agent/：
#   sfly-agent    上一个 Release 的本机架构 Agent
#   sfly-*.whl    同版本的 SDK 运行时 wheel（预先装进共享 venv，扮演旧控制面时用）
#   version       它的版本号
# 或者只有 skip：一行跳过原因（没有比当前版本旧的 Release）。Agent 是否支持自更新由测试自己探测。
#
#   previous-agent.sh                     从 GitHub Release 下载（需要 gh 已登录或设置 GH_TOKEN）
#   previous-agent.sh --simulate [版本]   用 out/server 里当前打包的 Agent 扮演上一版本（默认 0.0.0）：
#                                         末尾追加几个字节（sha256 与当前版本不同，ELF 不在意），
#                                         测试启动它时用隐藏的版本覆盖参数上报这个版本；先 `pnpm bundle:server`
#
# 「上一个 Release」= 已发布（非草稿、非预发布）的 vX.Y.Z 中低于当前版本号的最高版本：发版前把版本号改成
# X.Y.Z 之后，测试的就是「X.Y.Z 的控制面让上一个发布版本的 Agent 自更新」。
# 只用 Release 附件，不用 Actions Artifacts（ADR 0010）；下载后按 Release 的 SHA256SUMS 校验。
set -euo pipefail
cd "$(dirname "$0")/../.."

out=out/previous-agent
arch=$(uname -m)
case $arch in
x86_64 | aarch64) ;;
amd64) arch=x86_64 ;;
arm64) arch=aarch64 ;;
*)
	echo "不支持的架构：$arch" >&2
	exit 1
	;;
esac
current=$(bash scripts/release/version.sh check)
rm -rf "$out"
mkdir -p "$out"

if [[ ${1:-} == --simulate ]]; then
	version=${2:-0.0.0}
	agent=out/server/agent/$arch/sfly-agent
	wheel=out/server/sdk/sfly-$current-py3-none-any.whl
	for file in "$agent" "$wheel"; do
		[[ -f $file ]] || {
			echo "缺少 $file：先运行 pnpm bundle:server" >&2
			exit 1
		}
	done
	install -m 0755 "$agent" "$out/sfly-agent"
	printf '\nsimulated previous agent %s\n' "$version" >>"$out/sfly-agent"
	cp "$wheel" "$out/"
	echo "$version" >"$out/version"
	echo "$out：用当前构建的 Agent 扮演 $version"
	exit 0
fi

previous=$(
	gh release list --exclude-drafts --exclude-pre-releases --limit 1000 --json tagName --jq '.[].tagName' |
		sed -nE 's/^v([0-9]+\.[0-9]+\.[0-9]+)$/\1/p' |
		{ cat; echo "$current"; } | sort -uV | sed -n "/^${current//./\\.}\$/q;p" | tail -n1
)
if [[ -z $previous ]]; then
	echo "没有比当前版本 $current 旧的 Release" >"$out/skip"
	cat "$out/skip"
	exit 0
fi

tarball=sfly-agent-$previous-$arch-unknown-linux-musl.tar.gz
wheel=sfly-$previous-py3-none-any.whl
download=$(mktemp -d)
trap 'rm -rf "$download"' EXIT
gh release download "v$previous" --dir "$download" --pattern "$tarball" --pattern "$wheel" --pattern SHA256SUMS
sums=$(grep -E "  ($tarball|$wheel)\$" "$download/SHA256SUMS" || true)
if [[ $(grep -c . <<<"$sums") != 2 ]]; then
	echo "v$previous 的 SHA256SUMS 里缺少 $tarball 或 $wheel" >&2
	exit 1
fi
(cd "$download" && sha256sum --check --strict <<<"$sums")
tar -C "$out" -xzf "$download/$tarball" sfly-agent
cp "$download/$wheel" "$out/"
echo "$previous" >"$out/version"
echo "$out：v$previous 的 Agent（$arch）"
