#!/usr/bin/env bash
# 检查给定路径在重新生成后没有未提交的改动（生成物必须随源文件一起提交）。
set -euo pipefail
cd "$(dirname "$0")/.."
status="$(git status --porcelain -- "$@")"
if [[ -n "$status" ]]; then
	echo "生成物与源文件不一致，请运行 'pnpm gen' 并提交结果：" >&2
	echo "$status" >&2
	git --no-pager diff -- "$@" >&2 || true
	exit 1
fi
