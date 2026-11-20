#!/usr/bin/env bash
# 用用户的发布路径（sfly publish CLI）把桩节点包 testdata/stub-package（sfly-stub@0.1.0）发布到当前验证环境。
# 用法：publish-stub.sh [运行目录] [项目目录，默认 testdata/stub-package]
# 输出同时追加到 evidence/publish-<包目录名>.txt（重复发布的结果也留着）。
set -euo pipefail

VERIFY_ROOT=${SFLY_VERIFY_ROOT:-$HOME/.local/state/sfly-verify}
RUN=${1:-$VERIFY_ROOT/current}
# shellcheck disable=SC1091
source "$RUN/state.env"
PROJECT=${2:-$REPO/testdata/stub-package}
export TMPDIR=${TMPDIR:-$HOME/.t}

cd "$REPO"
uv run --locked --quiet sfly publish "$PROJECT" --server "$HTTP_URL" 2>&1 |
	tee -a "$RUN/evidence/publish-$(basename "$PROJECT").txt"
