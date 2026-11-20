#!/usr/bin/env bash
# 题目「跨机器」的参考答案：加节点和单测，重新 sfly dev（新增了节点），改联调副本，跑通。
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cp -r "$here/src/." src/
cp -r "$here/tests/." tests/
uv run -q ruff format
uv run -q pytest -q
uv run sfly dev
file=$(mktemp --suffix .json)
sfly scenario pull 'demo 巡检-联调-eval' -o "$file"
python3 "$here/add_node.py" "$file"
sfly scenario push "$file"
sfly run start 'demo 巡检-联调-eval' --wait --timeout 2m
