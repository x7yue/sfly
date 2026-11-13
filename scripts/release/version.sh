#!/usr/bin/env bash
# 发布版本号：Agent、SDK 运行时和控制面共用一个版本号（控制面按「Agent 版本 == SDK wheel 版本」
# 给 Agent 下发 SDK，见 apps/server/src/sdk/sdk-wheels.ts），版本号写在下面 4 个文件里。
#
#   version.sh show            列出各文件里的版本号
#   version.sh check [vX.Y.Z]  各文件版本号一致（给出 tag 时还要与 tag 一致），否则失败
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
SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

# 各文件里的版本号：[package] / [project] 段里第一个 version 行，或 __version__，或 package.json 的 version。
# 花括号里的命令以分号结尾、不用 sed -i：这样 GNU sed 和 macOS 的 BSD sed 都能用。
toml_version() { sed -nE '/^\[(package|project)\]/,/^\[/{s/^version = "([^"]*)".*/\1/p;}' "$1" | head -n1; }
edit() { sed -E "$2" "$1" >"$1.tmp" && mv "$1.tmp" "$1"; }
read_versions() {
	printf '%s\t%s\n' \
		"$CARGO" "$(toml_version "$CARGO")" \
		"$PYPROJECT" "$(toml_version "$PYPROJECT")" \
		"$PYINIT" "$(sed -nE 's/^__version__ = "([^"]*)".*/\1/p' "$PYINIT")" \
		"$SERVER" "$(node -p "require('./$SERVER').version")"
}

cmd_show() { read_versions; }

cmd_check() {
	local expected=${1:-}
	if [[ -n $expected ]]; then
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
	# shellcheck disable=SC2016 # 单引号里是 JS 代码，$1 是正则替换的分组引用
	node -e '
		const fs = require("node:fs");
		const [file, version] = process.argv.slice(1);
		const text = fs.readFileSync(file, "utf8");
		fs.writeFileSync(file, text.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`));
	' "$SERVER" "$version"
	# 工作区成员的版本号变化只影响锁文件里的对应条目，不需要联网。
	cargo update --offline --workspace --quiet
	uv lock --offline --quiet
	cmd_check >/dev/null
	echo "版本号已改为 $version："
	read_versions
}

case ${1:-} in
show) cmd_show ;;
check) cmd_check "${2:-}" ;;
set) cmd_set "${2:-}" ;;
*)
	echo "用法：version.sh show | check [vX.Y.Z] | set X.Y.Z" >&2
	exit 2
	;;
esac
