#!/usr/bin/env bash
# 题目「修」的参考答案，在节点包目录里运行：修好节点、把单测改成被测服务真实的响应格式，再跑一次联调副本。
# 只改了函数体，开发版本不用重新 sfly dev。
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cp -r "$here/src/." src/
cp -r "$here/tests/." tests/
uv run -q ruff format
uv run -q pytest -q
sfly run start 'demo 巡检-联调-eval' --wait --timeout 2m
