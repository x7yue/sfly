#!/usr/bin/env bash
# 标准节点包 sfly-std 的发布物（ADR 0017）：版本号独立于平台，取 std/pyproject.toml 的 [project].version。
#
#   std.sh version                    输出 sfly-std 的版本号
#   std.sh pack <std-vX.Y.Z> [目录]   发布前检查并打包到目录（默认 out/std）：
#                                       - tag 与版本号一致；
#                                       - 节点包元信息检查（std/tests/test_package.py：声明了最低 SDK 版本、
#                                         依赖只写下限、节点标题为中文、每个节点在「标准节点」页有一节）；
#                                       - sfly build 构建 sfly-std-X.Y.Z.sflypkg（元信息通过 schema 校验），
#                                         写出 SHA256SUMS 和发布说明 notes.md（含最低 Agent 版本和节点列表；
#                                         最低 Agent 版本取 requires-sdk 和 requires-agent 里较高的下限）。
#
# .github/workflows/std-release.yml 在 std-vX.Y.Z tag 上运行 pack，把产物作为 Release 附件发布。
# 本地运行 pack 就是发布流程的 dry-run：产物与 Release 附件相同，只是不上传。
set -euo pipefail
cd "$(dirname "$0")/../.."

PYPROJECT=std/pyproject.toml
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

std_version() { sed -nE '/^\[project\]/,/^\[/{s/^version = "([^"]*)".*/\1/p}' "$PYPROJECT" | head -n1; }

cmd_pack() {
	local tag=${1:?用法：std.sh pack <std-vX.Y.Z> [目录]}
	local out=${2:-out/std}
	tag=${tag#refs/tags/}
	local version=${tag#std-v}
	if [[ $tag != std-v* || ! $version =~ $SEMVER ]]; then
		echo "tag 必须是 std-vX.Y.Z：$tag" >&2
		exit 1
	fi
	local actual
	actual=$(std_version)
	if [[ $actual != "$version" ]]; then
		echo "$PYPROJECT 的版本号是 $actual，与 tag $tag 不一致" >&2
		exit 1
	fi

	uv run --locked --quiet pytest --quiet --no-header -p no:cacheprovider std/tests/test_package.py >&2

	mkdir -p "$out"
	local archive=sfly-std-$version.sflypkg
	rm -f "$out/$archive" "$out/SHA256SUMS" "$out/notes.md"
	uv run --locked --quiet sfly build std --out "$out" >&2
	[[ -f $out/$archive ]] || {
		echo "sfly build 没有生成 $out/$archive" >&2
		exit 1
	}
	(cd "$out" && sha256sum "$archive" >SHA256SUMS)
	uv run --locked --quiet python - "$out/$archive" "$version" >"$out/notes.md" <<'EOF'
import json
import re
import sys
import zipfile

archive, version = sys.argv[1:]
with zipfile.ZipFile(archive) as zf:
    meta = json.loads(zf.read("sfly-package.json"))
requires = meta["requires_sdk"]
requires_agent = meta.get("requires_agent")


def minimum(requirement):
    """`>=X.Y.Z` 里的版本号（元组，便于比较）；不是这种写法时为 None。"""
    m = re.fullmatch(r">=\s*([0-9][0-9.]*)", requirement)
    return tuple(int(p) for p in m.group(1).split(".")) if m else None


# SDK 运行时随 Agent 安装：最低 Agent 版本取 requires_sdk 和 requires_agent 里较高的下限。
lowest = [v for v in (minimum(requires), requires_agent and minimum(requires_agent)) if v]
agent = ".".join(map(str, max(lowest))) if lowest else requires
declared = f"节点包声明的 SDK 版本要求 `{requires}`"
if requires_agent:
    declared += f"、Agent 版本要求 `{requires_agent}`（也约束「Agent」类型的参数选的 Agent）"
nodes = "\n".join(f"- `{n['name']}`：{n['title']}" for n in meta["nodes"])
name = f"sfly-std-{version}.sflypkg"
print(f"""sfly-std {version}：平台维护的标准节点包，版本号独立于平台。

**最低 Agent 版本：{agent}**（{declared}）。版本更旧的 Agent 上任务以 `env_error` 失败，
升级控制面后 Agent 会跟随升级。

## 上传到控制面

下载附件 `{name}` 和 `SHA256SUMS`，校验后上传（和用户的节点包一样，不随控制面镜像发布）：

```sh
sha256sum -c SHA256SUMS --ignore-missing
curl -fsS -H 'content-type: application/octet-stream' --data-binary @{name} <控制面地址>/packages
```

装了 sfly 命令行时也可以用 `sfly publish {name}`。之后在场景里选用 `sfly-std` 的节点，版本选 `{version}`。
各节点的参数、输出和用法见控制面开发文档的「标准节点」页（`<控制面地址>/docs/standard-nodes.md`）。

## 节点

{nodes}""")
EOF
	echo "$out/$archive"
}

case ${1:-} in
version) std_version ;;
pack) cmd_pack "${@:2}" ;;
*)
	echo "用法：std.sh version | pack <std-vX.Y.Z> [目录]" >&2
	exit 2
	;;
esac
