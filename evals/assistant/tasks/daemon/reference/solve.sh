#!/usr/bin/env bash
# 题目「常驻」的参考答案，在节点包目录里运行：加集成测试；起替身、对它调试两次，在同一条命令里。
# 平台上一条命令结束时，它起的进程会被结束（ADR 0019：能力端口不用来启动常驻进程），
# 所以起服务和用它的步骤写在一起，用完自己关掉。
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cp -r "$here/tests/." tests/
uv run -q ruff format
uv run -q ruff check
uv run -q pytest -q
uv run python -m svc_stock.stub_service --port 8765 &
stub=$!
trap 'kill "$stub" 2>/dev/null || true; wait "$stub" 2>/dev/null || true' EXIT
for _ in $(seq 100); do
	curl -sf http://127.0.0.1:8765/health >/dev/null && break
	sleep 0.2
done
for sku in A-100 B-200; do
	uv run sfly debug stock_check --params "{\"base_url\": \"http://127.0.0.1:8765\", \"sku\": \"$sku\"}"
done
