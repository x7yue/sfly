#!/usr/bin/env bash
# `pnpm linux` 在容器里的入口（scripts/linux/run.sh 启动）：把宿主的工作区（/src，只读）同步进卷里这个工作区的副本，
# 装好依赖，再在副本里运行命令。/sync/files 是要同步的文件（run.sh 用 git ls-files 列出，NUL 分隔）。
set -euo pipefail

base=/vol/$SFLY_LINUX_ID
work=$base/work
mkdir -p "$work" /vol/cache/cargo-registry /vol/cache/cargo-git
# 记下这个副本属于宿主上的哪个工作区：之后工作区删掉了，prune.sh 才知道这个目录没有主人了（#579）。
if [[ -n ${SFLY_LINUX_ROOT:-} ]]; then printf '%s' "$SFLY_LINUX_ROOT" >"$base/root"; fi
# 编译结果超过上限时清一部分（cargo 不清自己的旧产物）。
bash /src/scripts/linux/trim-target.sh "$base/target" || true

# 删掉上次同步过、这次已经不在工作区里的文件。node_modules、.venv 这些容器里生成的不在清单里，保留。
if [[ -f $base/files ]]; then
	comm -z -23 <(sort -z "$base/files") <(sort -z /sync/files) | (cd "$work" && xargs -0 -r rm -f --)
fi
# 内容变了的文件修改时间变成现在，没变的不动：cargo 按修改时间判断要不要重编（见 sync-copy.sh，#589）。
bash /src/scripts/linux/sync-copy.sh /src /sync/files "$work"
cp /sync/files "$base/files"
cd "$work"

# 生成物检查（pnpm gen:check）和 lint:versions 要用 git：把副本提交成一个快照，未提交的改动也在里面。
export GIT_AUTHOR_NAME=pnpm-linux GIT_AUTHOR_EMAIL=pnpm-linux@localhost
export GIT_COMMITTER_NAME=pnpm-linux GIT_COMMITTER_EMAIL=pnpm-linux@localhost
[[ -d .git ]] || git init -q
git add -A
git commit -q --allow-empty --no-verify -m "pnpm linux 同步的工作区"

# 依赖装在副本里，与宿主的 node_modules、.venv 无关；缓存在卷里，各工作区共用。
export CARGO_TARGET_DIR=$base/target npm_config_store_dir=/vol/cache/pnpm UV_CACHE_DIR=/vol/cache/uv
# cargo 的调试信息只留行号表（编译结果小一半多、快几倍，回溯里的文件和行号还在），调用者设了就不覆盖。
# shellcheck source=cargo-env.sh
source /src/scripts/linux/cargo-env.sh
# uv 的缓存只增不减（每次同步都加新的解包内容，不再被引用的不会自己清）：超过上限让 uv 自己清掉不再被引用的部分。
uv_limit_kb=$((${SFLY_LINUX_UV_CACHE_LIMIT_MB:-1024} * 1024))
if [[ $(du -sk "$UV_CACHE_DIR" 2>/dev/null | cut -f1) -gt $uv_limit_kb ]]; then
	uv cache prune >&2 || true
fi
if ! { pnpm install --frozen-lockfile && uv sync --locked --all-packages; } >"$base/install.log" 2>&1; then
	cat "$base/install.log" >&2
	echo "pnpm linux：安装依赖失败（上面是输出）" >&2
	exit 1
fi
echo "pnpm linux：已同步工作区、装好依赖，在 Linux 容器里运行：$*" >&2
exec "$@"
