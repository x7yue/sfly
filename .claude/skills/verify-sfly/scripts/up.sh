#!/usr/bin/env bash
# 启动一套独立的 sfly 验证环境：独立 PostgreSQL 库 + 从源码运行的控制面（托管刚构建的前端）+ 一个真实 Agent。
# 用法：up.sh [--no-build]
# 成功时最后一行打印 RUN=<运行目录>；运行目录里的 state.env 记录地址、端口、进程组和库名，doctor.sh / down.sh 读取它。
set -euo pipefail

REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
VERIFY_ROOT=${SFLY_VERIFY_ROOT:-$HOME/.local/state/sfly-verify}
ADMIN_URL=${DATABASE_URL:-postgres://sfly:sfly@127.0.0.1:5432/sfly}
# 本机 /tmp 是小 tmpfs，uv / vite / cargo 的临时文件放到家目录。
export TMPDIR=${TMPDIR:-$HOME/.t}
mkdir -p "$TMPDIR"

build=1
[[ ${1:-} == --no-build ]] && build=0

cd "$REPO"
if ((build)); then
	# 每次都重新构建：被验证的就是当前工作区的代码。增量构建通常几十秒。
	echo "[up] 构建前端、SDK wheel、Agent…" >&2
	pnpm --filter @sfly/web build >/dev/null
	pnpm --filter @sfly/server build >/dev/null
	cargo build -p sfly-agent --locked --quiet
fi
for f in apps/web/dist/index.html target/debug/sfly-agent; do
	[[ -e $f ]] || { echo "[up] 缺少 $f，去掉 --no-build 重新运行" >&2; exit 1; }
done
ls apps/server/dist/sdk/*.whl >/dev/null 2>&1 || { echo "[up] 缺少 SDK wheel" >&2; exit 1; }

RUN="$VERIFY_ROOT/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN"/{data,agent,evidence/logs}
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
HTTP_PORT=$(free_port)
GRPC_PORT=$(free_port)
DB="sfly_verify_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
DB_URL=$(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(p._replace(path="/"+sys.argv[2]).geturl())' "$ADMIN_URL" "$DB")
HTTP_URL="http://127.0.0.1:$HTTP_PORT"
GRPC_URL="http://127.0.0.1:$GRPC_PORT"
AGENT_NAME=verify-agent

write_state() {
	cat >"$RUN/state.env" <<EOF
RUN=$RUN
REPO=$REPO
HTTP_URL=$HTTP_URL
GRPC_URL=$GRPC_URL
HTTP_PORT=$HTTP_PORT
GRPC_PORT=$GRPC_PORT
DB=$DB
DB_URL=$DB_URL
ADMIN_URL=$ADMIN_URL
AGENT_NAME=$AGENT_NAME
SERVER_PGID=${SERVER_PGID:-}
AGENT_PGID=${AGENT_PGID:-}
BROWSER_SESSION=sfly-verify-$(basename "$RUN")
EOF
	ln -sfn "$RUN" "$VERIFY_ROOT/current"
}
fail() {
	echo "[up] 失败：$1。日志在 $RUN/evidence/logs/，用 down.sh $RUN 清理" >&2
	exit 1
}

psql "$ADMIN_URL" -qc "CREATE DATABASE \"$DB\"" >/dev/null
write_state

# 控制面：setsid 让它自成进程组，down.sh 只杀这个进程组。迁移在启动时自动执行。
setsid env DATABASE_URL="$DB_URL" SFLY_DATA_DIR="$RUN/data" \
	SFLY_HTTP_HOST=127.0.0.1 SFLY_HTTP_PORT="$HTTP_PORT" \
	SFLY_GRPC_HOST=127.0.0.1 SFLY_GRPC_PORT="$GRPC_PORT" \
	SFLY_PUBLIC_URL="$HTTP_URL" SFLY_PUBLIC_GRPC_URL="$GRPC_URL" \
	pnpm --filter @sfly/server start >"$RUN/evidence/logs/server.log" 2>&1 &
SERVER_PGID=$!
write_state

# 就绪 = 日志里打出监听地址，且 /api/health 报告数据库可用（迁移已完成）。
for _ in $(seq 120); do
	kill -0 "$SERVER_PGID" 2>/dev/null || fail "控制面提前退出"
	if grep -q "sfly control plane .*http $HTTP_URL" "$RUN/evidence/logs/server.log" &&
		curl -fsS "$HTTP_URL/api/health" 2>/dev/null | grep -q '"database":"ok"'; then
		break
	fi
	sleep 0.5
done
curl -fsS "$HTTP_URL/api/health" | grep -q '"database":"ok"' || fail "控制面 60 秒内没有就绪"

# 真实 Agent：独立 SFLY_HOME / venv / 工作目录；用 PATH 上的 uv，不让 Agent 去外网装 uv。
# 首次连上后它用 uv 建空 venv、从控制面下载同版本的 SDK 运行时，然后才输出 welcome 事件。
mkdir -p "$RUN/agent/home"
setsid env SFLY_HOME="$RUN/agent/home" "$REPO/target/debug/sfly-agent" \
	--server "$GRPC_URL" --name "$AGENT_NAME" \
	--venv "$RUN/agent/venv" --work-dir "$RUN/agent/work" --uv uv \
	>"$RUN/evidence/logs/agent.jsonl" 2>"$RUN/evidence/logs/agent.stderr.log" &
AGENT_PGID=$!
write_state

for _ in $(seq 360); do
	kill -0 "$AGENT_PGID" 2>/dev/null || fail "Agent 提前退出（退出码 78 是运行环境准备失败，看 agent.stderr.log）"
	grep -q '"event":"welcome"' "$RUN/evidence/logs/agent.jsonl" && break
	sleep 0.5
done
grep -q '"event":"welcome"' "$RUN/evidence/logs/agent.jsonl" || fail "Agent 180 秒内没有连上控制面"

echo "[up] 就绪：页面 $HTTP_URL ，Agent $AGENT_NAME 在线" >&2
echo "RUN=$RUN"
