#!/usr/bin/env bash
# 文档的检查（`pnpm lint:docs`）：ADR 的编号和正文；文档里的路径、章节号、链接和 pnpm 命令；
# 仓库自带 skill 的目录布局（.agents/skills 里是真实文件，.claude/skills 里是指向它的软链接）；
# secret 参数的旧说法（敏感、保密、机密）不再出现（check_terms.py：只查这一个概念，词表写在脚本里，
# 不读 GLOSSARY.md；要守别的概念在脚本里加）。
# 中间两项都在 check_doc_references.py 里。
# 每一项都跑完再报，前一项失败不挡住后面的；推送前钩子和 CI 的 ts job 都跑它。
set -uo pipefail
cd "$(dirname "$0")/.."

status=0
bash scripts/check-adr-numbers.sh || status=1
uv run --locked python scripts/check_doc_references.py || status=1
uv run --locked python scripts/check_terms.py || status=1
exit "$status"
