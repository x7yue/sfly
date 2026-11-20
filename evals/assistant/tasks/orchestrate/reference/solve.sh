#!/usr/bin/env bash
# 题目「编排」的参考答案：pull 场景、加节点、push，再跑一次。
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
file=$(mktemp --suffix .json)
sfly scenario pull 'demo 巡检' -o "$file"
python3 "$here/add_node.py" "$file"
sfly scenario push "$file"
sfly run start 'demo 巡检' --wait --timeout 2m
