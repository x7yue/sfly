#!/usr/bin/env bash
# `pnpm linux` 在容器里的入口（scripts/linux/run.sh 启动）：把宿主的工作区（/src，只读）同步进卷里这个工作区的副本，
# 装好依赖，再在副本里运行命令。/sync/files 是要同步的文件（run.sh 用 git ls-files 列出，NUL 分隔）。
set -euo pipefail

base=/vol/$SFLY_LINUX_ID
work=$base/work
mkdir -p "$work" /vol/cache/cargo-registry /vol/cache/cargo-git

# 删掉上次同步过、这次已经不在工作区里的文件。node_modules、.venv 这些容器里生成的不在清单里，保留。
if [[ -f $base/files ]]; then
	comm -z -23 <(sort -z "$base/files") <(sort -z /sync/files) | (cd "$work" && xargs -0 -r rm -f --)
fi
rsync -a --files-from=/sync/files --from0 /src/ "$work/"
cp /sync/files "$base/files"
cd "$work"

# 生成物检查（pnpm gen:check）和 lint:node 要用 git：把副本提交成一个快照，未提交的改动也在里面。
export GIT_AUTHOR_NAME=pnpm-linux GIT_AUTHOR_EMAIL=pnpm-linux@localhost
export GIT_COMMITTER_NAME=pnpm-linux GIT_COMMITTER_EMAIL=pnpm-linux@localhost
[[ -d .git ]] || git init -q
git add -A
git commit -q --allow-empty --no-verify -m "pnpm linux 同步的工作区"

# 依赖装在副本里，与宿主的 node_modules、.venv 无关；缓存在卷里，各工作区共用。
export CARGO_TARGET_DIR=$base/target npm_config_store_dir=/vol/cache/pnpm UV_CACHE_DIR=/vol/cache/uv
if ! { pnpm install --frozen-lockfile && uv sync --locked --all-packages; } >"$base/install.log" 2>&1; then
	cat "$base/install.log" >&2
	echo "pnpm linux：安装依赖失败（上面是输出）" >&2
	exit 1
fi
echo "pnpm linux：已同步工作区、装好依赖，在 Linux 容器里运行：$*" >&2
exec "$@"
