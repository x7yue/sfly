#!/usr/bin/env bash
# 手工抄在几处、要保持一致的版本号：每个值只有一处是准的，其余处由这个脚本检查和它一样
# （`pnpm lint:node`；名字是从只管 Node 主版本时留下的，现在管下面全部）。不一致时报出是哪两处，改哪一处。
#   - Node 主版本只写在 .node-version：其他地方读取它（CI 的 node-version-file、镜像的 NODE_MAJOR、
#     打包的 esbuild target），package.json 的 engines 与它一致，其他文件里不写死。
#   - Playwright：以 apps/web/package.json 的 @playwright/test 为准，CI e2e 的镜像标签（vX.Y.Z）与它一致；
#     视觉基线只在同一个镜像里才可比。
#   - Python：以 .python-version 为准，Agent 建共享 venv 的默认版本（agent/src/environment.rs）和
#     sfly init 建项目的版本（sdk/python/src/sfly/cli/init.py）与它一致。
#   - PostgreSQL 镜像：CI 的服务容器、pnpm heavy --pg、pnpm linux 用同一个主版本。
# 确实要不一样时，在那一行写 `sfly-version-ok: <原因>`（原因必填），这一处就不参与比较。
# 要比较的文件不存在（删了、改名了），或者文件在但找不到要比较的那一处，也失败：前一种要改这个脚本里的路径，
# 后一种说明文件里的写法变了、检查没有跟上，要改的是这个脚本的正则。
set -euo pipefail
cd "$(dirname "$0")/.."

failed=0

# places <文件> <扩展正则，第一个括号取版本号>：输出匹配到的每一处，一行「文件:行号^_版本号^_放行」（^_ 是 \037：
# 用空白字符分隔，read 会把连着的分隔符合并，取不到版本号时后面的列就错位），放行是 1 表示那一行带了 `sfly-version-ok: <原因>`。
places() {
	# sed 的分隔符用控制字符：正则里有 /（@playwright/test、镜像地址）。
	local file=$1 regex=$2 hit excused sep=$'\001'
	{ grep -nE "$regex" "$file" || true; } | while IFS= read -r hit; do
		excused=0
		[[ $hit =~ sfly-version-ok:[[:space:]]*[^[:space:]] ]] && excused=1
		printf '%s:%s\037%s\037%s\n' "$file" "${hit%%:*}" "$(sed -nE "s${sep}.*${regex}.*${sep}\\1${sep}p" <<<"${hit#*:}")" "$excused"
	done
}

# expect_same <名称> <怎么改> <文件> <正则> [<文件> <正则>]...：
# 第一组是准的，其余每一处（一个文件里有几处就比较几处）都要和它一样；放行的那一行不参与比较。
expect_same() {
	local name=$1 fix=$2 ref_where="" ref_value="" file regex where value excused found
	shift 2
	while (($#)); do
		file=$1 regex=$2
		shift 2
		if [[ ! -f $file ]]; then
			echo "${name}：${file} 不存在（文件被删除或改名了？）：改 scripts/check-node-version.sh 里这一处的路径，指向它现在的位置。" >&2
			failed=1
			continue
		fi
		found=0
		while IFS=$'\037' read -r where value excused; do
			found=1
			if [[ $excused == 1 ]]; then
				continue
			elif [[ -z $value ]]; then
				echo "${name}：读不出 ${where} 里的版本号（正则 ${regex}）：改 scripts/check-node-version.sh 里的正则。" >&2
				failed=1
			elif [[ -z $ref_where ]]; then
				ref_where=$where ref_value=$value
			elif [[ $value != "$ref_value" ]]; then
				echo "${name}不一致：${where} 是 ${value}，${ref_where} 是 ${ref_value}。${fix}" >&2
				failed=1
			fi
		done < <(places "$file" "$regex")
		if ((!found)); then
			echo "${name}：在 ${file} 里找不到匹配 ${regex} 的行：文件里的写法变了，改 scripts/check-node-version.sh 里的正则。" >&2
			failed=1
		fi
	done
}

major=$(tr -d '[:space:]' <.node-version)
engines=$(node -p "require('./package.json').engines.node")
if [[ $engines != ">=$major" ]]; then
	echo "package.json 的 engines.node 是 '$engines'，应为 '>=$major'（.node-version）" >&2
	failed=1
fi
if hits=$(git grep -nE 'node:[0-9]+-|"node[0-9]+"' -- apps scripts .github ':!**/node_modules/**'); then
	echo "Node 主版本要从 .node-version 读取，不要写死：" >&2
	echo "$hits" >&2
	failed=1
fi

expect_same "Playwright 版本" \
	"CI e2e 的镜像标签要和 @playwright/test 的版本一样（视觉基线只在同一个镜像里可比）：升级依赖时一起改 .github/workflows/ci.yml 的 image；本机的 pnpm test:e2e:docker 取已安装的版本，不用改。" \
	apps/web/package.json '"@playwright/test": "([0-9]+\.[0-9]+\.[0-9]+)"' \
	.github/workflows/ci.yml 'mcr\.microsoft\.com/playwright:v([0-9]+\.[0-9]+\.[0-9]+)-'

expect_same "Python 版本" \
	"以 .python-version 为准：Agent 的 PYTHON_VERSION（agent/src/environment.rs）和 sfly init 的 PYTHON_VERSION（sdk/python/src/sfly/cli/init.py）跟着改，相关测试和文档里写的版本也要核对。" \
	.python-version '^([0-9]+\.[0-9]+)' \
	agent/src/environment.rs 'PYTHON_VERSION: &str = "([0-9]+\.[0-9]+)"' \
	sdk/python/src/sfly/cli/init.py '^PYTHON_VERSION = "([0-9]+\.[0-9]+)"'

expect_same "PostgreSQL 镜像" \
	"CI 的服务容器、pnpm heavy --pg（scripts/heavy.sh）、pnpm linux（scripts/linux/run.sh）要用同一个主版本，换版本时一起改。" \
	.github/workflows/ci.yml 'image: postgres:([0-9]+)' \
	scripts/heavy.sh '^[[:space:]]*postgres:([0-9]+) -c' \
	scripts/linux/run.sh '^pg_image=postgres:([0-9]+)'

exit "$failed"
