#!/usr/bin/env bash
# compose 冒烟（ADR 0027、#549）：用 deploy/docker-compose.yml 本身起 `--profile assistant`，检查它起得来、连得通：
#   - 不带 profile 只起控制面；带 `--profile assistant` 再起助手和工作台，三个服务都在跑，助手和工作台没有发布端口；
#   - 工作台在控制面的 Agent 页上在线，用自己的 Agent 凭据（auth_kind 为 agent），版本和控制面一致；
#   - 助手就绪，假的模型端点照剧本做完一个会话（事件顺序对，复用评测集 #543 的检查，scripts/release/stack_e2e.py）；
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
  sfly:
    depends_on: {db: {condition: service_healthy}}
    environment:
      SFLY_ADMIN_LOGIN: $admin_login
      SFLY_ADMIN_PASSWORD: \${SFLY_ADMIN_PASSWORD}
EOF

compose() {
	SFLY_VERSION=$tag SFLY_HTTP_PORT=$http_port SFLY_GRPC_PORT=$grpc_port \
		DATABASE_URL=postgres://sfly:sfly@db:5432/sfly SFLY_PUBLIC_URL=http://sfly:8080 \
		SFLY_ADMIN_PASSWORD=$admin_password SFLY_ASSISTANT_SECRET=$secret SFLY_ASSISTANT_URL=http://sfly-assistant:8090 \
		SFLY_WORKBENCH_AGENT=$agent SFLY_WORKBENCH_TOKEN=${token:-} SFLY_ASSISTANT_MODEL=fake/fake MODEL_API_KEY=k \
		SFLY_ASSISTANT_MODELS_FILE=$work_dir/models.json \
		SFLY_PYPI_MIRROR=${SFLY_PYPI_MIRROR:-} SFLY_GITHUB_RELEASE_MIRROR=${SFLY_GITHUB_RELEASE_MIRROR:-} \
		docker compose --env-file /dev/null -p "$project" -f deploy/docker-compose.yml -f "$work_dir/override.yml" "$@"
}
token=

cleanup() {
	compose --profile assistant down -v --remove-orphans >/dev/null 2>&1 || true
	for image in "${images[@]}"; do docker rmi "ghcr.io/x7yue/$image:$tag" >/dev/null 2>&1 || true; done
	rm -rf "$work_dir"
}
trap cleanup EXIT

fail() {
	echo "compose 冒烟失败：$1" >&2
	compose --profile assistant logs --tail 25 2>&1 | cut -c1-300 >&2 || true
	exit 1
}

# 容器网络里的客户端（评测集的函数）：控制面不一定映射得到，网络里最直接。
client() {
	ADMIN_PASSWORD=$admin_password docker run --rm --network "${project}_default" -v "$evals:/aeval:ro" \
		-v "$root/scripts/release/stack_e2e.py:/stack_e2e.py:ro" -e PYTHONPATH=/aeval -e PYTHONDONTWRITEBYTECODE=1 \
		-e CP_URL=http://sfly:8080 -e ADMIN_LOGIN="$admin_login" -e ADMIN_PASSWORD \
		--entrypoint python3 "ghcr.io/x7yue/sfly-workbench:$tag" /stack_e2e.py "$@"
}

# ---- 不带 profile：只有控制面（和数据库）----
compose up -d --wait --wait-timeout 180 >/dev/null || fail "不带 profile 的 compose 没有起来"
running=$(compose ps --format '{{.Service}}' | sort | tr '\n' ' ')
[[ $running == "db sfly " ]] || fail "不带 profile 时应当只有控制面（和数据库），实际是：$running"

# ---- 给工作台签发它自己的 Agent 凭据，填进环境，再带 profile 起 ----
token=$(client credential "$agent") || fail "签发 Agent 凭据"
[[ $token == sfly_agt_* ]] || fail "签发的不是 Agent 凭据"
compose --profile assistant up -d --wait --wait-timeout 600 >/dev/null || fail "--profile assistant 没有起来"
running=$(compose --profile assistant ps --format '{{.Service}}' | sort | tr '\n' ' ')
[[ $running == "db fake-model sfly sfly-assistant sfly-workbench " ]] || fail "带 profile 的服务不对：$running"
for service in sfly-assistant sfly-workbench; do
	ports=$(compose --profile assistant ps --format '{{.Ports}}' "$service")
	[[ $ports != *"->"* ]] || fail "$service 发布了端口：$ports"
done
client ready 300 || fail "助手没有就绪"
client session walkthrough >/dev/null || fail "会话的事件顺序不对"
# 助手的命令（经工作台 Agent 的 exec 能力）看到的运行环境：工作台的用户、家目录和工作区，工具都在 PATH 上，
# 环境里没有 Agent 凭据，也没有入口脚本自己的变量。
checked=$(client session workbench-check --results) || fail "workbench-check 会话"
for expected in user=workbench home=/home/workbench pwd=/work token-env=unset workbench-token-env=unset \
	/home/workbench/.local/bin/sfly /home/workbench/.local/bin/uv /usr/bin/git /usr/bin/rg /usr/local/bin/fd /usr/bin/jq \
	'Python 3.'; do
	grep -qF -- "$expected" <<<"$checked" || fail "助手的命令看到的环境里没有「$expected」：$(grep '^结果' <<<"$checked" | head -c 600)"
done
grep -qF "$token" <<<"$checked" && fail "凭据出现在会话的工具结果里"
grep '^结果' <<<"$checked" | head -c 700; echo

# 工作台：在线、Agent 凭据、版本一致、开发方式装的（sfly 命令行在）、有 git 仓库。
workbench=$(compose --profile assistant ps -q sfly-workbench)
[[ $(docker exec "$workbench" sfly --version) == "sfly $version" ]] || fail "工作台上 sfly 命令行的版本不是 $version"
docker exec "$workbench" sh -c 'test -x ~/.local/bin/uv && test -f ~/.sfly/.workbench-installed' || fail "uv 或安装标记不在"
[[ $(docker exec "$workbench" git -C /work rev-list --count HEAD) -ge 1 ]] || fail "工作区没有被提交"

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

echo "compose 冒烟通过：docker compose --profile assistant up（sfly $version）"
