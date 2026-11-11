#!/usr/bin/env bash
# 清理 up.sh 启动的一套环境：只杀 state.env 里记录的进程组，删除独立数据库、数据目录和 Agent 目录。
# 证据目录 <运行目录>/evidence/（含 logs/）保留，最后打印它的路径。
# 用法：down.sh [运行目录]（默认 $SFLY_VERIFY_ROOT/current）。可重复运行。
set -uo pipefail

VERIFY_ROOT=${SFLY_VERIFY_ROOT:-$HOME/.local/state/sfly-verify}
RUN=$(readlink -f "${1:-$VERIFY_ROOT/current}")
[[ -f $RUN/state.env ]] || { echo "[down] 没有 $RUN/state.env" >&2; exit 1; }
# shellcheck disable=SC1091
source "$RUN/state.env"

agent-browser --session "$BROWSER_SESSION" close >/dev/null 2>&1 || true

for pgid in $AGENT_PGID $SERVER_PGID; do
	[[ -n $pgid ]] && kill -0 "$pgid" 2>/dev/null || continue
	kill -TERM -- "-$pgid" 2>/dev/null
	for _ in $(seq 20); do kill -0 "$pgid" 2>/dev/null || break; sleep 0.5; done
	kill -KILL -- "-$pgid" 2>/dev/null || true
done

psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1 ||
	echo "[down] 删除数据库 $DB 失败，请手动删除" >&2
rm -rf "$RUN/data" "$RUN/agent"
[[ $(readlink -f "$VERIFY_ROOT/current") == "$RUN" ]] && rm -f "$VERIFY_ROOT/current"

echo "[down] 已清理。证据保留在 $RUN/evidence" >&2
