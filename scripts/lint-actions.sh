#!/usr/bin/env bash
# GitHub Actions 工作流的检查（`pnpm lint:actions`）：actionlint，连同 run 里的脚本过一遍 shellcheck。
# 工作流写错会卡住所有 PR 和发版，所以推送前和 CI 里都查。
# 用固定版本的 actionlint 镜像（自带 shellcheck，结果与 CI 一致）；docker 不可用时退回本机的 actionlint（brew install actionlint）。
set -euo pipefail
cd "$(dirname "$0")/.."

image=rhysd/actionlint:1.7.12
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
	exec docker run --rm -v "$PWD:/repo:ro" -w /repo "$image" "$@"
fi
if command -v actionlint >/dev/null; then
	exec actionlint "$@"
fi
echo "lint:actions：需要 docker 或 actionlint（brew install actionlint）" >&2
exit 1
