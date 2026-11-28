#!/usr/bin/env bash
# compose 冒烟（ADR 0027、#549）：用 deploy/docker-compose.yml 本身起 `--profile assistant`，检查它起得来、连得通：
#   - 不带 profile 只起控制面；带 `--profile assistant` 再起助手和工作台，三个服务都在跑，助手和工作台没有发布端口；
#   - 工作台在控制面的 Agent 页上在线，用自己的 Agent 凭据（auth_kind 为 agent），版本和控制面一致；登记为默认项目的工作台
#     （PUT /projects/default/workbench，之后控制面只接受 Agent 凭据）；
#   - 助手就绪，假的模型端点照剧本做完一个会话（事件顺序对，复用评测集 #543 的检查，scripts/release/stack_e2e.py）；
#   - 出网名单（#498）：工作台连得上控制面（装 Agent 走的就是它和镜像），名单外的被拒，包括另一个项目里的 Agent agent-b 的
#     能力端口（网络里别的容器连得到它）；控制面请出网名单的容器探测它，探不通、没有告警（工作台自己连探测服务被直接关掉）；把它加进 SFLY_WORKBENCH_EGRESS 之后连得上，
#     探测结果（就绪状态的 exposure，助手页和会话页的告警）里写着它和它的地址；
#   - `docker compose rm -sf` 删掉工作台容器再 `up -d`：工作区里的文件还在，Agent 不重装。
# compose 文件之外只加一个 override：一个 PostgreSQL（compose 里没有数据库）、一个假的模型端点、初始管理员和镜像站的环境；
# 项目名、端口、卷都是这一次随机的，不碰别的 compose 部署。
#   scripts/release/compose-smoke.sh
# 前提：本机有三个镜像 sfly-server:smoke、sfly-assistant:smoke、sfly-workbench:smoke（先 pnpm test:image、
# test:image:assistant、test:image:workbench 构建）和 postgres:18；联网（工作台装 Agent 要从控制面下发的镜像站取 uv 和依赖：
# 环境里设 SFLY_PYPI_MIRROR 和 SFLY_GITHUB_RELEASE_MIRROR；不设时用 uv 的官方来源）。需要 docker compose。
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD

suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
project=sfly-compose-smoke-$suffix
tag=smoke-$suffix
version=$(bash scripts/release/version.sh check)
admin_login=aeval_admin # 评测集里初始管理员的登录名：stack_e2e.py 复用评测集的函数
admin_password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
secret=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
http_port=$((20000 + RANDOM % 10000))
grpc_port=$((http_port + 10000))
work_dir=$(mktemp -d)
agent=workbench

# 本机的 :smoke 镜像打上这一次的 compose 标签（ghcr.io/…:<SFLY_VERSION>）：本机有这个标签 compose 就不去拉取。
images=(sfly-server sfly-assistant sfly-workbench)
for image in "${images[@]}"; do
	docker image inspect "$image:smoke" >/dev/null 2>&1 || {
		echo "没有镜像 $image:smoke：先 pnpm test:image、test:image:assistant、test:image:workbench 构建" >&2
		exit 1
	}
	docker tag "$image:smoke" "ghcr.io/x7yue/$image:$tag"
done

evals=$root/evals/assistant
cat >"$work_dir/models.json" <<'EOF'
{"providers":{"fake":{"name":"fake","baseUrl":"http://fake-model:8100/v1","api":"openai-completions","apiKey":"$MODEL_API_KEY",
 "models":[{"id":"fake","name":"fake","reasoning":false,"input":["text"],"contextWindow":128000,"maxTokens":8192,
 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}
EOF
# 假的模型端点从自己所在的目录读剧本：评测集的 fake_model.py 复制一份，旁边放这里自己的剧本（workbench-check.json），
# 评测集的文件一个不动；评测集的剧本（walkthrough 等）和题目仍从只读挂着的 /aeval 读。
mkdir -p "$work_dir/fake"
cp "$evals/container/fake_model.py" "$evals/container/walkthrough.json" "$work_dir/fake/"
cp scripts/release/workbench-check.json "$work_dir/fake/"
# override：数据库、假的模型端点、控制面的初始管理员和镜像站。凭据一律写变量名（值经环境变量给 compose）。
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
    healthcheck: {disable: true} # 工作台镜像的健康检查（pgrep sfly-agent）不适用于它
    volumes: ["$evals:/aeval:ro", "$work_dir/fake:/fake:ro"]
  # 另一个项目（other）里的 Agent agent-b：用工作台镜像的入口装一台普通 Agent（凭据签发在 other 项目里）。
  other-agent:
    profiles: [probe]
    image: ghcr.io/x7yue/sfly-workbench:$tag
    init: true
    healthcheck: {disable: true}
    environment:
      SFLY_WORKBENCH_URL: http://sfly:8080
      SFLY_WORKBENCH_NAME: agent-b
      SFLY_WORKBENCH_PUBLIC_ADDRESS: other-agent
      SFLY_WORKBENCH_TOKEN: \${SFLY_OTHER_TOKEN:-}
  sfly:
    depends_on: {db: {condition: service_healthy}}
    environment:
      SFLY_ADMIN_LOGIN: $admin_login
      SFLY_ADMIN_PASSWORD: \${SFLY_ADMIN_PASSWORD}
    # README「助手和工作台」里的第一个 override 示例：公开地址的主机名在工作台容器里解析到控制面容器。
    networks:
      default:
        aliases: [sfly.example.com]
EOF

# 控制面的助手地址：不带 profile 的第一步里是空的（默认部署没有助手），后面再设。
assistant_url=
compose() {
	# SFLY_PUBLIC_URL 写「浏览器看到的地址」（和 README 一致，不是服务名）；上面的网络别名让工作台容器连得上它。
	SFLY_VERSION=$tag SFLY_HTTP_PORT=$http_port SFLY_GRPC_PORT=$grpc_port \
		DATABASE_URL=postgres://sfly:sfly@db:5432/sfly SFLY_PUBLIC_URL=http://sfly.example.com:8080 \
		SFLY_ADMIN_PASSWORD=$admin_password SFLY_ASSISTANT_SECRET=$secret SFLY_ASSISTANT_URL=$assistant_url \
		SFLY_WORKBENCH_NAME=$agent SFLY_WORKBENCH_TOKEN=${token:-} SFLY_ASSISTANT_MODEL=fake/fake MODEL_API_KEY=k \
		SFLY_ASSISTANT_MODELS_FILE=$work_dir/models.json \
		SFLY_PYPI_MIRROR=${SFLY_PYPI_MIRROR:-} SFLY_GITHUB_RELEASE_MIRROR=${SFLY_GITHUB_RELEASE_MIRROR:-} \
		SFLY_WORKBENCH_EGRESS=$egress SFLY_OTHER_TOKEN=$other_token \
		docker compose --env-file /dev/null -p "$project" -f deploy/docker-compose.yml -f "$work_dir/override.yml" "$@"
}
token=
egress=
other_token=

cleanup() {
	compose --profile assistant --profile probe down -v --remove-orphans >/dev/null 2>&1 || true
	for image in "${images[@]}"; do docker rmi "ghcr.io/x7yue/$image:$tag" >/dev/null 2>&1 || true; done
	rm -rf "$work_dir"
}
trap cleanup EXIT

fail() {
	echo "compose 冒烟失败：$1" >&2
	compose --profile assistant --profile probe logs --tail 25 2>&1 | cut -c1-300 >&2 || true
	exit 1
}

# 容器网络里的客户端（评测集的函数）：控制面不一定映射得到，网络里最直接。
client() {
	ADMIN_PASSWORD=$admin_password docker run --rm --network "${project}_default" -v "$evals:/aeval:ro" \
		-v "$root/scripts/release/stack_e2e.py:/stack_e2e.py:ro" -e PYTHONPATH=/aeval -e PYTHONDONTWRITEBYTECODE=1 \
		-e CP_URL=http://sfly:8080 -e ADMIN_LOGIN="$admin_login" -e ADMIN_PASSWORD -e PROJECT="${client_project:-default}" \
		--entrypoint python3 "ghcr.io/x7yue/sfly-workbench:$tag" /stack_e2e.py "$@"
}

# ---- 不带 profile：只有控制面（和数据库）----
compose up -d --wait --wait-timeout 180 >/dev/null || fail "不带 profile 的 compose 没有起来"
running=$(compose ps --format '{{.Service}}' | sort | tr '\n' ' ')
[[ $running == "db sfly " ]] || fail "不带 profile 时应当只有控制面（和数据库），实际是：$running"

# ---- 给工作台签发它自己的 Agent 凭据，填进环境，再带 profile 起 ----
token=$(client credential "$agent") || fail "签发 Agent 凭据"
[[ $token == sfly_agt_* ]] || fail "签发的不是 Agent 凭据"
# 控制面和助手服务之间的事件流：控制面起来时连助手服务，连不上就退避重连（1、2、4……最长 30 秒），重连的这段时间里助手发的事件
# 直接丢（#545 要补的产品缺口），而就绪状态不看事件流是否连上。所以**先起助手（和假的模型端点）、等它健康，再起带助手地址的
# 控制面和工作台**：控制面一起来就连得上，没有退避。第一步没有设助手地址，控制面是在没有助手的默认部署里起来的，
# 这一步 compose 因为环境变了把它重建，这时助手已经在了。
assistant_url=http://sfly-assistant:8090
compose --profile assistant up -d --wait --wait-timeout 180 sfly-assistant fake-model >/dev/null ||
	fail "助手服务没有起来"
compose --profile assistant up -d --wait --wait-timeout 600 >/dev/null || fail "--profile assistant 没有起来"
running=$(compose --profile assistant ps --format '{{.Service}}' | sort | tr '\n' ' ')
expected="db fake-model sfly sfly-assistant sfly-workbench sfly-workbench-firewall "
[[ $running == "$expected" ]] || fail "带 profile 的服务不对：$running"
for service in sfly-assistant sfly-workbench sfly-workbench-firewall; do
	ports=$(compose --profile assistant ps --format '{{.Ports}}' "$service")
	[[ $ports != *"->"* ]] || fail "$service 发布了端口：$ports"
done
# 登记工作台（README「登记工作台」：项目管理员 PUT /projects/default/workbench）：控制面里没有指名工作台的环境变量，不登记就是
# 「没有登记工作台」；登记要工作台先用自己的 Agent 凭据连上来（上面 --wait 等的是它起来了，连上控制面再等一等）。
client register "$agent" 300 || fail "登记工作台"
client ready 300 || fail "助手没有就绪"
client session walkthrough >/dev/null || fail "会话的事件顺序不对"
# 助手的命令（经工作台 Agent 的 exec 能力）看到的运行环境：工作台的用户、家目录和工作区，工具都在 PATH 上，
# 环境里没有 Agent 凭据，也没有入口脚本自己的变量。
checked=$(client session workbench-check --results) || fail "workbench-check 会话"
for expected in user=workbench home=/home/workbench pwd=/work token-env=unset workbench-token-env=unset \
	/home/workbench/.local/bin/sfly /home/workbench/.local/bin/uv /usr/bin/git /usr/bin/rg /usr/local/bin/fd /usr/bin/jq \
	'Python 3.'; do
	grep -qF -- "$expected" <<<"$checked" || fail "助手的命令看到的环境里没有「${expected}」：$(grep '^结果' <<<"$checked" | head -c 600)"
done
# 凭据经进程替换给 grep（不进它的命令行参数，ps 看不到）。
if grep -qF -f <(printf '%s\n' "$token") <<<"$checked"; then fail "凭据出现在会话的工具结果里"; fi
grep '^结果' <<<"$checked" | head -c 700; echo

# 工作台：在线、Agent 凭据、版本一致、开发方式装的（sfly 命令行在）、有 git 仓库。
workbench=$(compose --profile assistant ps -q sfly-workbench)
[[ $(docker exec "$workbench" sfly --version) == "sfly $version" ]] || fail "工作台上 sfly 命令行的版本不是 $version"
docker exec "$workbench" sh -c 'test -x ~/.local/bin/uv && test -f ~/.sfly/.workbench-installed' || fail "uv 或安装标记不在"
[[ $(docker exec "$workbench" git -C /work rev-list --count HEAD) -ge 1 ]] || fail "工作区没有被提交"

# ---- 出网名单（#498）----
# 连 主机:端口，打印 ok 或失败的种类（被拒是 ConnectionRefusedError，不是超时）。
dial='import socket, sys
try:
    socket.create_connection((sys.argv[1], int(sys.argv[2])), 5).close()
    print("ok")
except OSError as error:
    print(type(error).__name__)'
from_workbench() { docker exec "$(compose --profile assistant ps -q sfly-workbench)" python3 -c "$dial" "$1" "$2"; }
from_network() {
	docker run --rm --network "${project}_default" --entrypoint python3 "ghcr.io/x7yue/sfly-workbench:$tag" -c "$dial" "$1" "$2"
}
# 另一个项目和它的 Agent agent-b（凭据签发在 other 项目里）。
docker exec "$(compose ps -q db)" psql -U sfly -d sfly -qc \
	"insert into projects (id, display_name, created_at) values ('other', '其他项目', now())" >/dev/null ||
	fail "建项目 other"
other_token=$(client_project=other client credential agent-b) || fail "给 agent-b 签发 Agent 凭据"
compose --profile assistant --profile probe up -d other-agent >/dev/null || fail "起 agent-b"
client_project=other client agent agent-b 600 || fail "agent-b 没有在 other 项目里在线"
[[ $(from_workbench sfly 8080) == ok ]] || fail "工作台连不上控制面"
[[ $(from_workbench sfly.example.com 50051) == ok ]] || fail "工作台连不上控制面的网关（公开地址的主机）"
[[ $(from_network other-agent 50052) == ok ]] || fail "网络里连不上「项目外的 Agent」：这一项没有意义"
for target in "other-agent 50052" "sfly-assistant 8090" "1.1.1.1 443"; do
	# shellcheck disable=SC2086 # 主机和端口两个参数
	got=$(from_workbench $target)
	[[ $got == ConnectionRefusedError ]] || fail "工作台连 $target 应当被出网名单拒绝，实际：$got"
done
# 探测：重启工作台（新的连接，控制面下一轮就探），agent-b 被出网名单挡住，探测结果里没有它。
since=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
compose --profile assistant restart sfly-workbench >/dev/null || fail "重启工作台"
exposed=$(client exposure "$since" 300) || fail "重启工作台之后没有探测结果"
[[ -z $exposed ]] || fail "名单外的 Agent 不该连得通：$exposed"
# 测量方是出网名单的容器，只接受控制面的连接：工作台自己连它的探测服务，连接不读就被关（curl 拿不到任何应答，000）。
code=$(docker exec "$(compose --profile assistant ps -q sfly-workbench)" curl -q --noproxy '*' -s -o /dev/null \
	-w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"targets":[]}' http://127.0.0.1:47124/probe || true)
[[ $code == 000 ]] || fail "工作台自己连探测服务应当被直接关掉（000），实际：$code"
# 加进名单：出网名单的容器重建，工作台跟着重启（共用它的网络命名空间）。
# 毫秒（GNU date）：上一次的探测结果可能就在同一秒里，按秒取整会把它当成这一次的。
since=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
egress="other-agent:50052"
compose --profile assistant up -d --wait --wait-timeout 300 sfly-workbench-firewall sfly-workbench >/dev/null ||
	fail "改了名单之后没有起来"
[[ $(from_workbench other-agent 50052) == ok ]] || fail "加进名单之后工作台仍连不上 other-agent:50052"
[[ $(from_workbench sfly-assistant 8090) == ConnectionRefusedError ]] || fail "名单之外的地址不再被拒"
client ready 300 || fail "改了名单之后助手没有就绪"
exposed=$(client exposure "$since" 300) || fail "改了名单之后没有探测结果"
[[ $exposed == "agent-b other-agent:50052" ]] || fail "加进名单之后探测结果里应当有 agent-b，实际：$exposed"
workbench=$(compose --profile assistant ps -q sfly-workbench) # 共用的网络命名空间换了，工作台容器可能重建过
echo "出网名单：名单外被拒、探测不到；加进名单之后连得上，探测结果里有它"
# 宿主机重启时 Docker 按 restart 策略直接恢复这两个容器，不经过 compose 的健康等待。这里用 docker stop、docker start
# 走同一条路：工作台的入口脚本要等本次的规则写好（本网络命名空间的 127.0.0.1:47123 应答）才启动 Agent。
firewall=$(compose --profile assistant ps -q sfly-workbench-firewall)
docker stop "$workbench" "$firewall" >/dev/null || fail "停工作台和出网名单"
restarted=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker start "$firewall" >/dev/null || fail "docker start 出网名单"
docker start "$workbench" >/dev/null || fail "docker start 工作台"
# 等工作台起到 Agent（就绪状态可能还停在停之前的连接上），再看它之前的几行是不是先等了规则。
for _ in $(seq 300); do
	log=$(docker logs --since "$restarted" "$workbench" 2>&1)
	[[ $log != *前台启动\ Agent* ]] || break
	sleep 1
done
[[ $log == *等出网名单的规则写好*出网名单的规则已写好*前台启动\ Agent* ]] ||
	fail "docker start 之后工作台没有先等出网名单的规则：$log"
client ready 300 || fail "docker start 之后助手没有就绪"
[[ $(from_workbench sfly-assistant 8090) == ConnectionRefusedError ]] || fail "docker start 之后名单之外的地址不再被拒"
[[ $(from_workbench other-agent 50052) == ok ]] || fail "docker start 之后名单里的地址连不上"
echo "出网名单：docker start 恢复时工作台等规则写好才启动 Agent"

# ---- 删掉工作台容器再建：工作区和环境都在，Agent 不重装 ----
fingerprint() { docker exec "$1" sh -c 'stat -c "%i %Y" ~/.sfly/bin/sfly-agent; sha256sum ~/.sfly/bin/sfly-agent'; }
before=$(fingerprint "$workbench")
docker exec "$workbench" sh -c 'echo kept > /work/probe.txt'
compose --profile assistant rm -sf sfly-workbench >/dev/null 2>&1 || fail "删掉工作台容器"
compose --profile assistant up -d --wait --wait-timeout 300 sfly-workbench >/dev/null || fail "重建工作台"
new=$(compose --profile assistant ps -q sfly-workbench)
[[ $new != "$workbench" ]] || fail "工作台容器没有被重建"
[[ $(docker exec "$new" cat /work/probe.txt) == kept ]] || fail "重建之后工作区里的文件不见了"
[[ $(fingerprint "$new") == "$before" ]] || fail "重建之后 Agent 二进制变了：重装了"
client ready 300 || fail "重建工作台之后助手没有就绪"

echo "compose 冒烟通过：docker compose --profile assistant up（sfly ${version}）"
