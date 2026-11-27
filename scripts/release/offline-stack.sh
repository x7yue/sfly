#!/usr/bin/env bash
# 整套离线冒烟（ADR 0027、#549）：用发布的三个镜像（控制面、助手、工作台）在一个**不通外网**的容器网络里起一整套，
# 假的模型端点照剧本回复，经控制面建一个会话、跟到这一轮结束。照评测集 `./aeval.sh up --offline --isolated` 的做法：
#   - 网络是 internal：容器连不上外网，也到不了宿主机；镜像站（评测集的 container/mirror.py）只用缓存（serve），
#     控制面把它下发给工作台的安装脚本（SFLY_PYPI_MIRROR、SFLY_GITHUB_RELEASE_MIRROR）；
#   - 假的模型端点（container/fake_model.py）在网络里；评测集目录以只读挂进这两个容器，不改它；
#   - 会话的那一半复用评测集（#543）的函数（stack_e2e.py：登录、事件流、check_sequence）。
# 检查：工作台在断网的网络里装好 Agent 并在线（auth_kind 是 agent）；容器连不上外网；助手就绪；
# 会话的持久事件依次是 user_message、turn_started、工具调用和结果、助手的话、turn_end（completed）；
# 工具的改动真的落在工作台的卷上（/work 里的文件、工作区是 git 仓库、属主是工作台的用户）；
# 删掉工作台容器再建，工作区还在、Agent 不重装。
#
#   scripts/release/offline-stack.sh [--record] [--keep]
#   --record  联网、镜像站取不到的文件从上游取并存进缓存：第一次（缓存是空的或不全）先这样跑一遍；不带时断网
#   --keep    结束后不删环境（调试用，要删时按最后打印的命令）
# 环境变量：SERVER_IMAGE、ASSISTANT_IMAGE、WORKBENCH_IMAGE（默认 sfly-server:smoke、sfly-assistant:smoke、sfly-workbench:smoke：
# 先 pnpm test:image、test:image:assistant、test:image:workbench 构建）；MIRROR_CACHE 镜像站缓存目录
# （默认 ~/.local/share/sfly/offline-stack/mirror-cache；--record 时镜像站从上游取，评测集里的上游是中科大镜像）。
# 需要 docker。重型命令：和别的重型命令一样用 `pnpm heavy` 排队。
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD

record=0
keep=0
for arg in "$@"; do
	case $arg in
	--record) record=1 ;;
	--keep) keep=1 ;;
	*)
		echo "用法：offline-stack.sh [--record] [--keep]" >&2
		exit 2
		;;
	esac
done

server_image=${SERVER_IMAGE:-sfly-server:smoke}
assistant_image=${ASSISTANT_IMAGE:-sfly-assistant:smoke}
workbench_image=${WORKBENCH_IMAGE:-sfly-workbench:smoke}
cache=${MIRROR_CACHE:-$HOME/.local/share/sfly/offline-stack/mirror-cache}
version=$(bash scripts/release/version.sh check)
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
prefix=sfly-offline-$suffix
network=$prefix
agent=workbench
admin_login=aeval_admin # 评测集里初始管理员的登录名（aeval.env.ADMIN_LOGIN），stack_e2e.py 复用它的函数
admin_password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
secret=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
work_dir=$(mktemp -d)

cleanup() {
	if ((keep)); then
		echo "没有删环境（--keep）。要删：docker rm -f -v \$(docker ps -aq --filter name=$prefix) ; docker volume rm $prefix-home $prefix-work ; docker network rm $network" >&2
		return
	fi
	docker rm -f -v "$prefix-wb" "$prefix-assistant" "$prefix-cp" "$prefix-pg" "$prefix-fake" "$prefix-mirror" >/dev/null 2>&1 || true
	docker volume rm "$prefix-home" "$prefix-work" >/dev/null 2>&1 || true
	docker network rm "$network" >/dev/null 2>&1 || true
	rm -rf "$work_dir"
}
trap cleanup EXIT

fail() {
	echo "整套冒烟失败：$1" >&2
	for role in wb assistant cp mirror fake; do
		echo "--- $prefix-$role 的日志（最后 25 行）" >&2
		docker logs "$prefix-$role" 2>&1 | tail -n 25 >&2 || true
	done
	exit 1
}

for image in "$server_image" "$assistant_image" "$workbench_image" postgres:18; do
	docker image inspect "$image" >/dev/null 2>&1 ||
		fail "没有镜像 $image：断网的环境不能拉取；先 pnpm test:image、test:image:assistant、test:image:workbench 构建，postgres:18 要事先 docker pull"
done
mkdir -p "$cache"

# ---- 网络和旁边的容器：镜像站、假的模型端点、PostgreSQL ----
if ((record)); then
	docker network create "$network" >/dev/null
	mirror_mode=record
else
	docker network create --internal "$network" >/dev/null
	mirror_mode=serve
fi
evals=$root/evals/assistant
# 镜像站和假的模型端点都用工作台镜像自带的 python3（评测集的脚本只用标准库）。
sidecar() { # <角色> <网络别名> <参数…>
	local role=$1 alias=$2
	shift 2
	docker run -d --init --name "$prefix-$role" --network "$network" --network-alias "$alias" \
		-v "$evals:/aeval:ro" -v "$cache:/cache" --entrypoint python3 "$workbench_image" "$@" >/dev/null
}
sidecar mirror mirror.internal /aeval/container/mirror.py "$mirror_mode"
# 假的模型端点从自己所在的目录读剧本：评测集的 fake_model.py 复制一份，旁边放这里自己的剧本（workbench-check.json），
# 评测集的文件一个不动；评测集的剧本（walkthrough 等）和题目仍从只读挂着的 /aeval 读。
mkdir -p "$work_dir/fake"
cp "$evals/container/fake_model.py" "$evals/container/walkthrough.json" "$work_dir/fake/"
cp scripts/release/workbench-check.json "$work_dir/fake/"
docker run -d --init --name "$prefix-fake" --network "$network" --network-alias fake-model.internal \
	-v "$evals:/aeval:ro" -v "$work_dir/fake:/fake:ro" --entrypoint python3 "$workbench_image" \
	/fake/fake_model.py --port 8100 >/dev/null
docker run -d --name "$prefix-pg" --network "$network" \
	-e POSTGRES_USER=sfly -e POSTGRES_PASSWORD=sfly -e POSTGRES_DB=sfly --tmpfs /var/lib/postgresql postgres:18 >/dev/null
for _ in $(seq 60); do
	docker exec "$prefix-pg" pg_isready -U sfly -d sfly >/dev/null 2>&1 && break
	sleep 1
done

# ---- 助手：模型文件指向网络里的假的模型端点，密钥变量是占位值 ----
# 先起助手、再起控制面：控制面起来时连助手服务的事件流，连不上就退避重连（最长 30 秒），重连期间助手发的事件直接丢（#545 要补的
# 产品缺口），而就绪状态不看事件流是否连上。助手先在，控制面一起来就连得上。
cat >"$work_dir/models.json" <<'EOF'
{"providers":{"fake":{"name":"fake","baseUrl":"http://fake-model.internal:8100/v1","api":"openai-completions","apiKey":"$FAKE_KEY",
 "models":[{"id":"fake","name":"fake","reasoning":false,"input":["text"],"contextWindow":128000,"maxTokens":8192,
 "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}
EOF
SFLY_ASSISTANT_SECRET=$secret docker run -d --init --name "$prefix-assistant" --network "$network" \
	--network-alias sfly-assistant --memory 2g -v "$work_dir/models.json:/config/models.json:ro" \
	-e SFLY_ASSISTANT_SECRET -e SFLY_ASSISTANT_MODEL=fake/fake -e FAKE_KEY=k "$assistant_image" >/dev/null

# ---- 控制面：和 compose 一样，助手的地址、共享密钥（工作台由项目管理员登记，不在环境变量里）；镜像是网络里的镜像站 ----
SFLY_ADMIN_PASSWORD=$admin_password SFLY_ASSISTANT_SECRET=$secret docker run -d --init --name "$prefix-cp" \
	--network "$network" --network-alias sfly \
	-e DATABASE_URL=postgres://sfly:sfly@"$prefix-pg":5432/sfly -e SFLY_PUBLIC_URL=http://sfly:8080 \
	-e SFLY_PYPI_MIRROR=http://mirror.internal:8000/pypi/simple \
	-e SFLY_GITHUB_RELEASE_MIRROR=http://mirror.internal:8000/github-release \
	-e SFLY_ASSISTANT_URL=http://sfly-assistant:8090 -e SFLY_ASSISTANT_SECRET \
	-e SFLY_ADMIN_LOGIN="$admin_login" -e SFLY_ADMIN_PASSWORD "$server_image" >/dev/null
for _ in $(seq 60); do
	status=$(docker inspect --format '{{.State.Health.Status}}' "$prefix-cp" 2>/dev/null || echo exited)
	[[ $status == healthy ]] && break
	sleep 2
done
[[ $status == healthy ]] || fail "控制面的健康检查没有转为 healthy（$status）"

# ---- 客户端：在网络里运行（断网的网络不映射端口），复用评测集的函数 ----
client() { # <参数…>：评测集只读挂在 /aeval，初始管理员的密码经环境变量名交给容器
	ADMIN_PASSWORD=$admin_password docker run --rm --network "$network" -v "$evals:/aeval:ro" \
		-v "$root/scripts/release/stack_e2e.py:/stack_e2e.py:ro" -e PYTHONPATH=/aeval -e PYTHONDONTWRITEBYTECODE=1 \
		-e CP_URL=http://sfly:8080 -e ADMIN_LOGIN="$admin_login" -e ADMIN_PASSWORD \
		--entrypoint python3 "$workbench_image" /stack_e2e.py "$@"
}
token=$(client credential "$agent") || fail "给工作台签发 Agent 凭据"
[[ $token == sfly_agt_* ]] || fail "签发的不是 Agent 凭据"

# ---- 工作台：和 compose 的 sfly-workbench 服务同样的环境变量和卷 ----
start_workbench() {
	SFLY_WORKBENCH_TOKEN=$token docker run -d --init --name "$prefix-wb" --network "$network" \
		--network-alias sfly-workbench -v "$prefix-home:/home/workbench" -v "$prefix-work:/work" \
		-e SFLY_WORKBENCH_URL=http://sfly:8080 -e SFLY_WORKBENCH_NAME="$agent" \
		-e SFLY_WORKBENCH_PUBLIC_ADDRESS=sfly-workbench -e SFLY_WORKBENCH_TOKEN "$workbench_image" >/dev/null
}
start_workbench
# 登记工作台（和 README「登记工作台」同一个接口）：等工作台用自己的 Agent 凭据连上来再登记；之后控制面只接受 Agent 凭据。
client register "$agent" 300 || fail "登记工作台"
client ready 300 || fail "助手 5 分钟内没有就绪"

# 断网是真的：工作台容器连不上外网（DNS 也解析不了），也到不了宿主机。
if ((!record)); then
	for url in https://mirrors.ustc.edu.cn/ http://1.1.1.1/ http://host.docker.internal/; do
		if docker exec "$prefix-wb" curl -sS -m 5 -o /dev/null "$url" 2>/dev/null; then
			fail "断网的网络里工作台连得上 $url"
		fi
	done
	echo "已确认断网：工作台容器连不上外网和宿主机"
fi

# ---- 假的模型端点照剧本做完一轮：事件顺序对，改动落在工作台的卷上 ----
client session walkthrough || fail "会话的事件顺序不对"
workbench() { docker exec "$prefix-wb" "$@"; }
[[ $(workbench cat /work/notes/walk.md) == *"第二行（改过）"* ]] || fail "剧本写、改的文件不在工作台的 /work 里"
[[ $(workbench stat -c %U /work/notes/walk.md) == workbench ]] || fail "文件的属主不是工作台的用户"
[[ $(workbench git -C /work rev-list --count HEAD) -ge 1 ]] || fail "工作区没有被提交（/work 不是 git 仓库，或这一轮结束时没有提交）"
workbench sh -c 'test -x ~/.local/bin/sfly && command -v sfly' >/dev/null || fail "工作台上没有 sfly 命令行"

# 助手的命令（经工作台 Agent 的 exec 能力）看到的运行环境：用工作台的用户、家目录和工作区，sfly、uv、git、rg、fd、jq、python 都在 PATH 上，
# 环境里没有 Agent 凭据（Agent 起的命令里去掉了 SFLY_TOKEN）也没有入口脚本自己的变量。
checked=$(client session workbench-check --results) || fail "workbench-check 会话"
for expected in user=workbench home=/home/workbench pwd=/work token-env=unset workbench-token-env=unset \
	/home/workbench/.local/bin/sfly /home/workbench/.local/bin/uv /usr/bin/git /usr/bin/rg /usr/local/bin/fd /usr/bin/jq \
	'Python 3.'; do
	grep -qF -- "$expected" <<<"$checked" || fail "助手的命令看到的环境里没有「$expected」：$(grep '^结果' <<<"$checked" | head -c 600)"
done
# 凭据经进程替换给 grep（不进它的命令行参数，ps 看不到）。
if grep -qF -f <(printf '%s\n' "$token") <<<"$checked"; then fail "凭据出现在会话的工具结果里"; fi
grep '^结果' <<<"$checked" | head -c 700; echo

# ---- README「助手和工作台」里签发凭据的两条命令、登记工作台的命令照着执行一遍（在工作台上，它有 sfly 命令行；签发换别的名字，
#      不动工作台自己的凭据；登记同一台是幂等的）----
docker exec -i "$prefix-wb" sh -c 'sfly login --server http://sfly:8080 --login-name "$0" --password-stdin' "$admin_login" \
	<<<"$admin_password" >/dev/null || fail "sfly login（管理员登录）"
issued=$(workbench sfly api POST /projects/default/agents/doc-check/credentials) || fail "sfly api POST /projects/default/agents/<名字>/credentials"
grep -Eq '"token": *"sfly_agt_' <<<"$issued" || fail "sfly api 的响应里没有 Agent 凭据的 token"
issued=$(workbench sfly agent credentials issue doc-check-2 --token-only) || fail "sfly agent credentials issue --token-only"
[[ $issued == sfly_agt_* && $issued != *$'\n'* ]] || fail "--token-only 应当只写一行 Agent 凭据"
# README 里登记工作台的命令（`sfly api PUT /projects/default/workbench --body '{"agent": "<名字>"}'`）：已经登记过同一台，幂等，没有换。
registered=$(workbench sfly api PUT /projects/default/workbench --body "{\"agent\": \"$agent\"}") ||
	fail "sfly api PUT /projects/default/workbench（README 里登记工作台的命令）"
grep -Eq "\"agent\": *\"$agent\"" <<<"$registered" && grep -Eq '"previous_agent": *null' <<<"$registered" ||
	fail "登记工作台的响应不对：$registered"
workbench rm -f /home/workbench/.sfly/credentials.json # 管理员的登录只为这一步，不留在工作台的卷上

# ---- 删掉工作台容器再建：工作区还在，Agent 不重装，助手照样就绪 ----
fingerprint() { workbench sh -c 'stat -c "%i %Y" ~/.sfly/bin/sfly-agent; sha256sum ~/.sfly/bin/sfly-agent'; }
before=$(fingerprint)
docker rm -f "$prefix-wb" >/dev/null
start_workbench
client ready 300 || fail "重建工作台之后助手没有就绪"
[[ $(workbench cat /work/notes/walk.md) == *"第二行（改过）"* ]] || fail "重建工作台之后工作区里的文件不见了"
[[ $(fingerprint) == "$before" ]] || fail "重建工作台之后 Agent 二进制变了：重装了"
grep -q '已经装好，直接启动' <(docker logs "$prefix-wb" 2>&1) || fail "重建之后入口脚本没有说「已经装好，直接启动」"

echo "整套冒烟通过（$([[ $record == 1 ]] && echo '联网，镜像站录制' || echo '断网，镜像站只用缓存')）：sfly $version，控制面 $server_image，助手 $assistant_image，工作台 $workbench_image"
