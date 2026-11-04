#!/usr/bin/env bash
# 测试用：创建一个"已经装好桩节点包"的共享 venv。
#   scripts/stub-venv.sh <venv 目录>
# venv 中装有 SDK 运行时（sdk/python，只用标准库）和 testdata/stub-package 构建出的 wheel。
# 节点包的下载与安装由 Agent 负责（#6）；这里只为执行测试预先准备环境。
set -euo pipefail
venv="$(realpath -m "$1")"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
uv run --locked --quiet sfly build testdata/stub-package --out "$work" >/dev/null
uv run --locked --quiet python -m zipfile -e "$work"/sfly-stub-*.sflypkg "$work/pkg"

rm -rf "$venv"
uv venv --quiet --python "$(cat .python-version)" "$venv"
# 本地源码目录和同名同版本的 wheel 都可能命中 uv 缓存，强制刷新以装上当前代码。
uv pip install --quiet --python "$venv" --refresh-package sfly --refresh-package sfly-stub ./sdk/python "$work"/pkg/*.whl
