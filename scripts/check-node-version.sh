#!/usr/bin/env bash
# Node 主版本只写在 .node-version：其他地方读取它（CI 的 node-version-file、镜像的 NODE_MAJOR、
# 打包的 esbuild target），package.json 的 engines 与它一致。
set -euo pipefail
cd "$(dirname "$0")/.."

major=$(tr -d '[:space:]' <.node-version)
engines=$(node -p "require('./package.json').engines.node")
failed=0
if [[ $engines != ">=$major" ]]; then
	echo "package.json 的 engines.node 是 '$engines'，应为 '>=$major'（.node-version）" >&2
	failed=1
fi
if hits=$(git grep -nE 'node:[0-9]+-|"node[0-9]+"' -- apps scripts .github ':!**/node_modules/**'); then
	echo "Node 主版本要从 .node-version 读取，不要写死：" >&2
	echo "$hits" >&2
	failed=1
fi
exit "$failed"
