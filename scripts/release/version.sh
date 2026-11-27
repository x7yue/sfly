#!/usr/bin/env bash
# 发布版本号：Agent、SDK 运行时、控制面、API 客户端和助手服务共用一个版本号（控制面按「Agent 版本 == SDK wheel 版本」
# 给 Agent 下发 SDK，见 apps/server/src/sdk/sdk-wheels.ts；API 客户端和控制面同版本，ADR 0022；助手镜像随每个版本发布，
# 它的 /health 报的助手服务版本读 apps/assistant/package.json，#549）。
#
#   version.sh show            列出各文件里的版本号
#   version.sh check [vX.Y.Z]  各文件版本号一致（给出 tag 时还要与 tag 一致，并且发版性能报告
#                              docs/perf/X.Y.Z/report.json 已提交、版本号与 tag 一致），否则失败
#   version.sh set X.Y.Z       改写全部版本号，并刷新 Cargo.lock 和 uv.lock
#
# 只支持 X.Y.Z：预发布版本在 Cargo（0.2.0-rc.1）和 Python（0.2.0rc1）里的写法不同，
# 控制面匹配不上，Agent 会拿不到 SDK。
set -euo pipefail
cd "$(dirname "$0")/../.."

CARGO=agent/Cargo.toml
PYPROJECT=sdk/python/pyproject.toml
PYINIT=sdk/python/src/sfly/__init__.py
SERVER=apps/server/package.json
ASSISTANT=apps/assistant/package.json
CLIENT=packages/client/package.json
CLIENT_TS=packages/client/src/version.ts
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

# 花括号里的命令以分号结尾、不用 sed -i：这样 GNU sed 和 macOS 的 BSD sed 都能用。
toml_version() { sed -nE '/^\[(package|project)\]/,/^\[/{s/^version = "([^"]*)".*/\1/p;}' "$1" | head -n1; }
edit() { sed -E "$2" "$1" >"$1.tmp" && mv "$1.tmp" "$1"; }
read_versions() {
	printf '%s\t%s\n' \
		"$CARGO" "$(toml_version "$CARGO")" \
		"$PYPROJECT" "$(toml_version "$PYPROJECT")" \
		"$PYINIT" "$(sed -nE 's/^__version__ = "([^"]*)".*/\1/p' "$PYINIT")" \
		"$SERVER" "$(node -p "require('./$SERVER').version")" \
		"$ASSISTANT" "$(node -p "require('./$ASSISTANT').version")" \
		"$CLIENT" "$(node -p "require('./$CLIENT').version")" \
		"$CLIENT_TS" "$(sed -nE 's/^export const CLIENT_VERSION = "([^"]*)".*/\1/p' "$CLIENT_TS")"
}

cmd_show() { read_versions; }

# 发版前必跑性能测试（docs/agents/branching-and-release.md「发版」）：在 release/X.Y.Z 分支上 `pnpm perf --release`，
# 通过后它把报告存进 docs/perf/X.Y.Z/。0.4.0 漏过一次，所以发版的 tag 检查要求这份报告已经提交、版本号对得上。
check_perf_report() {
	local version=$1 report=docs/perf/$1/report.json found
	if [[ ! -f $report ]]; then
		echo "$report 不存在：发版前必须跑性能测试。在 release/$version 分支上提交版本号之后运行 pnpm perf --release（约 10 分钟），" >&2
		echo "把存进去的 docs/perf/$version/ 提交进发版 PR；不通过时先修复再重跑（docs/agents/branching-and-release.md「发版」）。" >&2
		exit 1
	fi
	# shellcheck disable=SC2016 # 单引号里是 JS 代码
	if ! found=$(node -e '
		const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
		process.stdout.write(String(report?.version?.sfly ?? ""));
	' "$report" 2>/dev/null); then
		echo "$report 不是 JSON，读不出 version.sfly：它由 pnpm perf --release 写入，不要手动修改或从别处复制（docs/perf/README.md）。" >&2
		exit 1
	fi
	if [[ $found != "$version" ]]; then
		echo "$report 的 version.sfly 是 '$found'，应为 '$version'：这不是 $version 的发版性能报告。" >&2
		echo "在 release/$version 分支上提交之后运行 pnpm perf --release，重新生成 docs/perf/$version/（不要手动修改或从别处复制）。" >&2
		exit 1
	fi
}

cmd_check() {
	# 给了参数（哪怕是空串）就按 tag 检查：空的 tag 要报错，不能退化成不带参数的日常检查。
	local expected=${1:-} tagged=
	if (($#)); then
		tagged=1
		expected=${expected#refs/tags/}
		if [[ ! ${expected#v} =~ $SEMVER || $expected != v* ]]; then
			echo "tag 必须是 vX.Y.Z：$expected" >&2
			exit 1
		fi
		expected=${expected#v}
	fi
	local file version failed=0
	while IFS=$'\t' read -r file version; do
		[[ -z $expected ]] && expected=$version
		if [[ -z $version || $version != "$expected" ]]; then
			echo "$file 的版本号是 '$version'，应为 '$expected'" >&2
			failed=1
		fi
	done < <(read_versions)
	if ((failed)); then
		echo "用 'pnpm release:version set X.Y.Z' 统一版本号" >&2
		exit 1
	fi
	if [[ ! $expected =~ $SEMVER ]]; then
		echo "版本号必须是 X.Y.Z：$expected" >&2
		exit 1
	fi
	[[ -z $tagged ]] || check_perf_report "$expected"
	echo "$expected"
}

cmd_set() {
	local version=${1:?用法：version.sh set X.Y.Z}
	if [[ ! $version =~ $SEMVER ]]; then
		echo "版本号必须是 X.Y.Z（不支持预发布版本）：$version" >&2
		exit 1
	fi
	edit "$CARGO" '/^\[package\]/,/^\[/{s/^version = "[^"]*"/version = "'"$version"'"/;}'
	edit "$PYPROJECT" '/^\[project\]/,/^\[/{s/^version = "[^"]*"/version = "'"$version"'"/;}'
	edit "$PYINIT" 's/^__version__ = "[^"]*"/__version__ = "'"$version"'"/'
	edit "$CLIENT_TS" 's/^(export const CLIENT_VERSION = ")[^"]*"/\1'"$version"'"/'
	# shellcheck disable=SC2016 # 单引号里是 JS 代码，$1 是正则替换的分组引用
	node -e '
		const fs = require("node:fs");
		const [version, ...files] = process.argv.slice(1);
		for (const file of files) {
			const text = fs.readFileSync(file, "utf8");
			fs.writeFileSync(file, text.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`));
		}
	' "$version" "$SERVER" "$ASSISTANT" "$CLIENT"
	# 工作区成员的版本号变化只影响锁文件里的对应条目，不需要联网。
	cargo update --offline --workspace --quiet
	uv lock --offline --quiet
	cmd_check >/dev/null
	echo "版本号已改为 ${version}："
	read_versions
}

case ${1:-} in
show) cmd_show ;;
check) shift; cmd_check "$@" ;;
set) cmd_set "${2:-}" ;;
*)
	echo "用法：version.sh show | check [vX.Y.Z] | set X.Y.Z" >&2
	exit 2
	;;
esac
