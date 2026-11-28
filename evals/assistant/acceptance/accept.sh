#!/usr/bin/env bash
# 骨架验收（#553）：在正式部署形态里，按「一句话之后的十分钟」逐行核对页面，假的模型端点照剧本回复，不调用真实模型。
#
#   evals/assistant/acceptance/accept.sh [--project <项目>] [--images <标签>] [--out <目录>] [--keep]
#
# - 环境照 scripts/release/compose-smoke.sh：deploy/docker-compose.yml --profile assistant 起控制面、助手、工作台（开着登录，
#   登记工作台），override 只加 PostgreSQL、假的模型端点（评测集的 fake_model.py 加这里的 accept-*.json 剧本）、被测机 sut
#   （普通 Agent sut-01 和示例服务 http://sut:9000，剧本里工作台要连它：放进出网名单 SFLY_WORKBENCH_EGRESS）、初始管理员。
#   项目名、端口、卷都是这一次随机的。
# - 准备：建一个编辑者账号（两人交替用），以评测集「编排」那道题的初始状态发布节点包 svc-probe、建场景「demo 巡检」。
# - 浏览器：Playwright 官方镜像（版本取 apps/web 的 @playwright/test，和 e2e 同一个）在这套环境的网络里跑 acceptance.spec.ts。
#   用例要重启、停掉容器时在控制目录里写请求，这个脚本在后台照做（compose stop、start、restart，或换助手的模型设置）。
# - 结果在 --out（默认 ~/.local/share/sfly/evals/<日期>-accept/<时间>/）：results.jsonl（每行 通过/失败、说明、证据路径）、
#   shots/、samples/、summary.md、日志。写完之后按值搜管理员和编辑者的密码、Agent 凭据，按格式搜会话令牌、个人令牌、
#   登录 Cookie 的名字加值，搜到就删掉这次的结果、以失败退出（结果要上传或贴出去）。
# - --project：所有项目内的接口（登记工作台、就绪、建会话）都用它；现在只有默认项目跑得通，第二个项目等 #499、#796。
# 前提：本机有镜像 sfly-server、sfly-assistant、sfly-workbench 的 <标签>（默认 accept；构建见 README「骨架验收」）、postgres:18、
# Playwright 镜像；apps/web 装好了依赖；联网（工作台、被测机装 Agent 和依赖）。退出码：全部通过 0，有行没过 1，环境问题 2。
set -euo pipefail
cd "$(dirname "$0")/../../.."
root=$PWD
accept=$root/evals/assistant/acceptance
evals=$root/evals/assistant

project_name=default
images=accept
out=
keep=false
while [[ $# -gt 0 ]]; do
	case $1 in
	--project) project_name=$2; shift 2 ;;
	--images) images=$2; shift 2 ;;
	--out) out=$2; shift 2 ;;
	--keep) keep=true; shift ;;
	*)
		sed -n '2,17p' "$0" >&2
		exit 2
		;;
	esac
done
out=${out:-${AEVAL_HOME:-$HOME/.local/share/sfly/evals}/$(date +%Y-%m-%d)-accept/$(date +%H%M%S)}
mkdir -p "$out"
started=$(date +%s)

suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
project=sfly-accept-$suffix
tag=accept-$suffix
admin_login=aeval_admin # 评测集里初始管理员的登录名：stack_e2e.py 复用评测集的函数
editor_login=accept_editor
admin_password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
editor_password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
secret=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
http_port=$((20000 + RANDOM % 10000))
grpc_port=$((http_port + 10000))
work_dir=$(mktemp -d)
ctl_dir=$out/.ctl
mkdir -p "$ctl_dir"
agent=workbench
assistant_model=fake/fake
playwright=mcr.microsoft.com/playwright:v$(node -p "require('$root/apps/web/node_modules/@playwright/test/package.json').version")-noble

log() { printf '验收：%s\n' "$*"; }

for image in sfly-server sfly-assistant sfly-workbench; do
	docker image inspect "$image:$images" >/dev/null 2>&1 || {
		echo "没有镜像 $image:${images}：先照 evals/assistant/README.md「骨架验收」构建" >&2
		exit 2
	}
	docker tag "$image:$images" "ghcr.io/x7yue/$image:$tag"
done

cat >"$work_dir/models.json" <<'EOF'
{"providers":{"fake":{"name":"fake","baseUrl":"http://fake-model:8100/v1","api":"openai-completions","apiKey":"$MODEL_API_KEY",
 "models":[{"id":"fake","name":"fake","reasoning":false,"input":["text"],"contextWindow":128000,"maxTokens":8192,
 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}
EOF
mkdir -p "$work_dir/fake"
cp "$evals/container/fake_model.py" "$accept"/accept-*.json "$work_dir/fake/"
cat >"$work_dir/override.yml" <<EOF
services:
  db:
    image: postgres:18
    environment: {POSTGRES_USER: sfly, POSTGRES_PASSWORD: sfly, POSTGRES_DB: sfly}
    tmpfs: [/var/lib/postgresql]
    healthcheck: {test: ["CMD", "pg_isready", "-U", "sfly"], interval: 2s, retries: 30}
  fake-model:
    profiles: [assistant]
    image: ghcr.io/x7yue/sfly-workbench:$tag
    entrypoint: [python3, /fake/fake_model.py, --port, "8100"]
    healthcheck: {disable: true}
    volumes: ["$evals:/aeval:ro", "$work_dir/fake:/fake:ro"]
  sut:
    profiles: [assistant]
    image: ghcr.io/x7yue/sfly-workbench:$tag
    user: root
    init: true
    depends_on: {sfly: {condition: service_healthy}}
    entrypoint: [sh, /accept/sut.sh]
    healthcheck: {disable: true}
    environment:
      SFLY_SUT_URL: http://sfly:8080
      SFLY_SUT_TOKEN: \${SFLY_SUT_TOKEN:-}
    volumes: ["$evals/container/demo_svc.py:/accept/demo_svc.py:ro", "$accept/sut.sh:/accept/sut.sh:ro"]
  sfly:
    depends_on: {db: {condition: service_healthy}}
    environment:
      SFLY_ADMIN_LOGIN: $admin_login
      SFLY_ADMIN_PASSWORD: \${SFLY_ADMIN_PASSWORD}
    networks:
      default:
        aliases: [sfly.example.com]
EOF

assistant_url=
token=
sut_token=
compose() {
	SFLY_VERSION=$tag SFLY_HTTP_PORT=$http_port SFLY_GRPC_PORT=$grpc_port \
		DATABASE_URL=postgres://sfly:sfly@db:5432/sfly SFLY_PUBLIC_URL=http://sfly.example.com:8080 \
		SFLY_ADMIN_PASSWORD=$admin_password SFLY_ASSISTANT_SECRET=$secret SFLY_ASSISTANT_URL=$assistant_url \
		SFLY_WORKBENCH_NAME=$agent SFLY_WORKBENCH_TOKEN=$token SFLY_SUT_TOKEN=$sut_token \
		SFLY_ASSISTANT_MODEL=$assistant_model MODEL_API_KEY=k SFLY_ASSISTANT_MODELS_FILE=$work_dir/models.json \
		SFLY_PYPI_MIRROR=${SFLY_PYPI_MIRROR:-} SFLY_GITHUB_RELEASE_MIRROR=${SFLY_GITHUB_RELEASE_MIRROR:-} \
		SFLY_WORKBENCH_EGRESS=sut:9000 \
		docker compose --env-file /dev/null -p "$project" -f deploy/docker-compose.yml -f "$work_dir/override.yml" "$@"
}

watcher=
cleanup() {
	[[ -n $watcher ]] && kill "$watcher" 2>/dev/null || true
	[[ -e $out/compose.log ]] || compose --profile assistant logs --no-color >"$out/compose.log" 2>&1 || true
	if [[ $keep == true ]]; then
		log "留着环境：docker compose -p $project …（控制面 http://127.0.0.1:${http_port}）"
	else
		compose --profile assistant down -v --remove-orphans >/dev/null 2>&1 || true
		for image in sfly-server sfly-assistant sfly-workbench; do docker rmi "ghcr.io/x7yue/$image:$tag" >/dev/null 2>&1 || true; done
	fi
	rm -rf "$work_dir" "$ctl_dir"
}
trap cleanup EXIT

fail() {
	echo "验收的环境没有准备好：$1" >&2
	compose --profile assistant logs --tail 30 2>&1 | cut -c1-300 >&2 || true
	exit 2
}

# 容器网络里的客户端：评测集的函数加 stack_e2e.py、accept_client.py。凭据经环境变量，命令行里只有名字。
client() {
	ADMIN_PASSWORD=$admin_password EDITOR_PASSWORD=$editor_password docker run --rm --network "${project}_default" \
		-v "$evals:/aeval:ro" -v "$root/scripts/release/stack_e2e.py:/client/stack_e2e.py:ro" \
		-v "$accept/accept_client.py:/client/accept_client.py:ro" -e PYTHONPATH=/aeval:/client -e PYTHONDONTWRITEBYTECODE=1 \
		-e CP_URL=http://sfly:8080 -e ADMIN_LOGIN="$admin_login" -e ADMIN_PASSWORD -e EDITOR_PASSWORD -e PROJECT="$project_name" \
		--entrypoint python3 "ghcr.io/x7yue/sfly-workbench:$tag" "/client/$1" "${@:2}"
}

# ---- 环境 ----
log "起控制面（${project}）"
compose up -d --wait --wait-timeout 180 >/dev/null || fail "控制面没有起来"
token=$(client stack_e2e.py credential "$agent") || fail "给工作台签发 Agent 凭据"
sut_token=$(client stack_e2e.py credential sut-01) || fail "给被测机签发 Agent 凭据"
# 先起助手和假的模型端点、等它健康，再起带助手地址的控制面和工作台（compose-smoke.sh 写了原因）。
assistant_url=http://sfly-assistant:8090
compose --profile assistant up -d --wait --wait-timeout 180 sfly-assistant fake-model >/dev/null || fail "助手服务没有起来"
log "起工作台和被测机（第一次要装 Agent，几分钟）"
compose --profile assistant up -d --wait --wait-timeout 900 >/dev/null || fail "--profile assistant 没有起来"
client stack_e2e.py register "$agent" 600 >/dev/null || fail "登记工作台"
client stack_e2e.py ready 300 >/dev/null || fail "助手没有就绪"
client accept_client.py agent sut-01 600 >/dev/null || fail "被测机 sut-01 没有在线"

# ---- 准备：编辑者账号；节点包 svc-probe 和场景「demo 巡检」（评测集「编排」那道题的初始状态，见 aeval/tasks/orchestrate.py）----
editor_id=$(client accept_client.py user "$editor_login" 乙) || fail "建编辑者账号"
compose exec -T db psql -qU sfly -c \
	"insert into project_members (project_id, user_id, role, created_at) values ('$project_name', '$editor_id', 'editor', now())" \
	>/dev/null || fail "把编辑者加进项目"
workbench=$(compose --profile assistant ps -q sfly-workbench)
docker exec "$workbench" mkdir -p /tmp/seed/overlay /tmp/seed/scenario
docker cp "$evals/tasks/fix/reference/." "$workbench:/tmp/seed/overlay/"
python3 - "$evals/tasks/shared/scenario-demo.json" >"$work_dir/scenario.json" <<'EOF'
import json, sys
print(json.dumps({"document": json.load(open(sys.argv[1]))["document"]}, ensure_ascii=False))
EOF
docker cp "$work_dir/scenario.json" "$workbench:/tmp/seed/scenario/demo.json"
description=$(python3 -c "import sys; sys.path.insert(0, '$evals'); from aeval.tasks.fix import DESCRIPTION; print(DESCRIPTION)")
docker exec -i -e SFLY_NICKNAME=grader -e DESCRIPTION="$description" -w /tmp/seed "$workbench" bash -e <<'EOF' >"$out/seed.log" 2>&1 ||
sfly init svc-probe
cd svc-probe
for part in src tests; do [ -d /tmp/seed/overlay/$part ] && cp -r /tmp/seed/overlay/$part/. $part/; done
uv sync -q
uv run -q sfly publish
sfly scenario create --name "demo 巡检" --description "$DESCRIPTION" --from /tmp/seed/scenario/demo.json
EOF
	fail "准备节点包和场景（$out/seed.log）"
log "环境准备好了，用时 $(($(date +%s) - started)) 秒"

# ---- 控制目录：用例要做的容器操作 ----
(
	while true; do
		for request in "$ctl_dir"/*.req; do
			[[ -e $request ]] || continue
			read -r action service <"$request"
			rm -f "$request"
			case $action in
			no-model) assistant_model= ;;
			model) assistant_model=fake/fake ;;
			esac
			case $action in
			stop | start | restart) compose --profile assistant "$action" "$service" ;;
			no-model | model) compose --profile assistant up -d --wait --wait-timeout 180 "$service" ;;
			*) false ;;
			esac >>"$out/ctl.log" 2>&1
			echo $? >"${request%.req}.done"
			echo "$(date +%T) $action $service → $(cat "${request%.req}.done")" >>"$out/ctl.log"
		done
		sleep 0.5
	done
) &
watcher=$!

# ---- 浏览器 ----
browser_started=$(date +%s)
set +e
ACCEPT_ADMIN_PASSWORD=$admin_password ACCEPT_EDITOR_PASSWORD=$editor_password docker run --rm --init \
	--network "${project}_default" --ipc host --user "$(id -u):$(id -g)" -e HOME=/tmp -e CI=1 \
	-e ACCEPT_BASE_URL=http://sfly.example.com:8080 -e ACCEPT_OUT=/out -e ACCEPT_CTL=/out/.ctl \
	-e ACCEPT_PROJECT="$project_name" -e ACCEPT_WORKBENCH="$agent" \
	-e ACCEPT_ADMIN_LOGIN="$admin_login" -e ACCEPT_ADMIN_PASSWORD \
	-e ACCEPT_EDITOR_LOGIN="$editor_login" -e ACCEPT_EDITOR_PASSWORD \
	-v "$root:$root:ro" -v "$out:/out" -w "$root/apps/web" "$playwright" \
	npx playwright test -c "$accept/playwright.config.ts" >"$out/playwright.log" 2>&1
browser_code=$?
set -e
finished=$(date +%s)

# ---- 结果 ----
python3 - "$out" "$((browser_started - started))" "$((finished - browser_started))" "$project_name" <<'EOF'
import json, sys
from pathlib import Path
out, setup, browser, project = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
rows = [json.loads(line) for line in (out / "results.jsonl").read_text().splitlines()] if (out / "results.jsonl").exists() else []
lines = [f"# 骨架验收（项目 {project}）", "", f"准备环境 {setup} 秒，浏览器核对 {browser} 秒。", "", "| 行 | 结论 | 说明 | 证据 |", "|---|---|---|---|"]
for row in rows:
    detail = str(row["detail"]).replace("|", "\\|").replace("\n", " ")
    lines.append(f"| {row['row']} | {'通过' if row['ok'] else '**失败**'} | {detail} | {'、'.join(row['evidence'])} |")
(out / "summary.md").write_text("\n".join(lines) + "\n")
EOF

kill "$watcher" 2>/dev/null || true
watcher=
compose --profile assistant logs --no-color >"$out/compose.log" 2>&1 || true

# 凭据不能出现在结果里：按值搜密码和 Agent 凭据，按格式搜令牌和登录 Cookie。
leaked=$(
	{
		grep -rlaF -e "$admin_password" -e "$editor_password" -e "$token" -e "$sut_token" -e "$secret" "$out" || true
		grep -rlaE 'sfly_(ses|pat|prj|agt|tsk)_[0-9a-f]{16}|sfly_login=[A-Za-z0-9_-]{8}' "$out" || true
	} | sort -u
)
if [[ -n $leaked ]]; then
	echo "结果里有凭据，删掉这次的结果：$leaked" >&2
	rm -rf "$out"
	exit 2
fi

failed=$(grep -c '"ok": false\|"ok":false' "$out/results.jsonl" 2>/dev/null || true)
log "结果：$out/summary.md（浏览器退出码 ${browser_code}，没过的行 ${failed:-0}，总用时 $((finished - started)) 秒）"
cat "$out/summary.md"
[[ $browser_code -eq 0 && ${failed:-0} -eq 0 ]] || exit 1
