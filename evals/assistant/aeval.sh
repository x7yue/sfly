#!/usr/bin/env bash
# sfly 助手评测集的入口，用法见同目录的 README.md。只依赖宿主机的 python3（3.10 及以上）和 docker。
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m aeval "$@"
