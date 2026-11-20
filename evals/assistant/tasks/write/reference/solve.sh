#!/usr/bin/env bash
# 题目「写」的参考答案，在节点包目录里运行：加上节点和单测，跑检查和 sfly debug。
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cp -r "$here/src/." src/
cp -r "$here/tests/." tests/
uv run -q ruff format
uv run -q ruff check
uv run -q pytest -q
uv run sfly debug level_counts --params '{"path": "/fixtures/app.log"}'
