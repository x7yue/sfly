#!/usr/bin/env bash
# buf breaking 检查：把当前 proto/ 与基线提交比较。
# 基线：环境变量 PROTO_BASE_REF（CI 中为 PR 的目标分支或 push 前的提交），默认 origin/main，再退回 main。
# 基线不存在或基线中还没有 proto/ 时跳过（例如契约第一次引入时）。
set -euo pipefail
cd "$(dirname "$0")/.."

ref="${PROTO_BASE_REF:-}"
if [[ -z "$ref" ]]; then
	if git rev-parse --verify --quiet origin/main >/dev/null; then ref=origin/main; else ref=main; fi
fi

if ! sha="$(git rev-parse --verify --quiet "${ref}^{commit}")"; then
	echo "proto:breaking: 基线 '$ref' 不存在，跳过" >&2
	exit 0
fi
if ! git cat-file -e "${sha}:proto" 2>/dev/null; then
	echo "proto:breaking: 基线 '$ref' ($sha) 中没有 proto/，跳过" >&2
	exit 0
fi

echo "proto:breaking: 与 $ref ($sha) 比较" >&2
exec buf breaking --against ".git#ref=${sha},depth=0"
