#!/usr/bin/env bash
# 只读体检：这套验证环境值不值得驱动。用法：doctor.sh [运行目录]（默认 $SFLY_VERIFY_ROOT/current）。
# 全部通过时退出码 0；任一项失败退出码 1，并打印失败项。
set -uo pipefail

VERIFY_ROOT=${SFLY_VERIFY_ROOT:-$HOME/.local/state/sfly-verify}
RUN=${1:-$VERIFY_ROOT/current}
[[ -f $RUN/state.env ]] || { echo "FAIL 没有 $RUN/state.env：先运行 up.sh"; exit 1; }
# shellcheck disable=SC1091
source "$RUN/state.env"

bad=0
ok() { echo "ok   $1"; }
no() { echo "FAIL $1"; bad=1; }

for p in SERVER AGENT; do
	pgid_var=${p}_PGID
	pgid=${!pgid_var}
	if [[ -n $pgid ]] && kill -0 "$pgid" 2>/dev/null; then ok "$p 进程组 $pgid 存活"; else no "$p 进程组 ${pgid:-?} 不在了"; fi
done

# 端口归我们：监听 HTTP 端口的进程属于控制面的进程组。
owner=$(ss -ltnpH "sport = :$HTTP_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [[ -n $owner && $(ps -o pgid= -p "$owner" | tr -d ' ') == "$SERVER_PGID" ]]; then
	ok "端口 $HTTP_PORT 由本环境的控制面监听"
else
	no "端口 $HTTP_PORT 不是本环境的控制面在监听（pid=${owner:-无}）"
fi

health=$(curl -fsS "$HTTP_URL/api/health" 2>/dev/null)
[[ $health == *'"database":"ok"'* ]] && ok "健康检查 $health" || no "健康检查失败：${health:-无响应}"

expected=$(node -p "require('$REPO/apps/server/package.json').version")
agents=$(curl -fsS "$HTTP_URL/api/agents" 2>/dev/null)
line=$(AGENTS="$agents" NAME="$AGENT_NAME" python3 -c '
import json, os
data = json.loads(os.environ["AGENTS"] or "{}")
for a in data.get("agents", []):
    if a.get("name") == os.environ["NAME"]:
        print(a["status"], a["info"]["agent_version"], data["control_plane_version"])
' 2>/dev/null)
if [[ $line == "online $expected $expected" ]]; then
	ok "Agent $AGENT_NAME 在线，Agent 与控制面都是工作区版本 $expected"
else
	no "Agent $AGENT_NAME 状态 / Agent 版本 / 控制面版本：${line:-未找到}（期望 online $expected $expected）"
fi

exit $bad
