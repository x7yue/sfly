#!/usr/bin/env bash
# 文档的检查（`pnpm lint:docs`）：ADR 的编号和正文；文档里的路径、章节号和链接；
# 仓库自带 skill 的目录布局（.agents/skills 里是真实文件，.claude/skills 里是指向它的软链接）。
# 后两项都在 check_doc_references.py 里。
# 每一项都跑完再报，前一项失败不挡住后面的；推送前钩子和 CI 的 ts job 都跑它。
set -uo pipefail
cd "$(dirname "$0")/.."

status=0
bash scripts/check-adr-numbers.sh || status=1
uv run --locked python scripts/check_doc_references.py || status=1
exit "$status"
