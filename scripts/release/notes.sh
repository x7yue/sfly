#!/usr/bin/env bash
# 输出 Release 说明的固定部分（安装方式）；变更列表由 GitHub 自动生成，接在后面。
#   scripts/release/notes.sh <版本> <镜像名，例如 ghcr.io/x7yue/sfly-server>
set -euo pipefail
version=${1:?用法：notes.sh <版本> <镜像名>}
image=${2:?用法：notes.sh <版本> <镜像名>}

cat <<EOF
## 安装

控制面和 Agent 需要升级到同一版本：Agent 连上控制面后，从控制面下载与自身版本一致的 SDK 运行时。

**控制面**（Docker 镜像，linux/amd64 与 linux/arm64）

\`\`\`sh
docker pull ${image}:${version}
\`\`\`

无法访问 ghcr.io 时，下载附件 \`sfly-server-${version}-linux-<amd64|arm64>.tar.gz\`，然后执行：
\`gunzip -c sfly-server-${version}-linux-amd64.tar.gz | docker load\`。
部署方式见仓库中的 \`deploy/docker-compose.yml\`。

**Agent**（musl 静态链接，不依赖 glibc 版本）：控制面镜像带着同版本的 x86_64 / aarch64 Agent，在测试机上运行

\`\`\`sh
curl -fsSL <控制面地址>/install.sh | sh -s -- --name <名称>
\`\`\`

离线分发时也可以直接用附件：\`tar -xzf sfly-agent-${version}-x86_64-unknown-linux-musl.tar.gz\`（arm64 机器用 aarch64-unknown-linux-musl）。

**SDK**：\`sfly-${version}-py3-none-any.whl\`（开发者安装 CLI：\`pip install "./sfly-${version}-py3-none-any.whl[cli]"\`）。

**API 客户端**：控制面镜像带着同版本的安装包，在自建页面的项目里运行 \`npm install <控制面地址>/client/${version}/sfly-client-${version}.tgz\`，见控制面开发文档里的「用 API 客户端做自己的页面」。有不兼容的变化时，列在下面的「API 客户端的不兼容变化」里。

校验下载的文件：\`sha256sum -c SHA256SUMS --ignore-missing\`。

## 升级注意：Agent 凭据

每台 Agent 现在用管理员为它**按台签发的凭据**连接控制面（\`sfly_agt_\` 开头，只对签发时指定的名字有效；\`Hello.token\` 放它，\`agent.env\` 里写作 \`SFLY_TOKEN\`，名字不变），Agent 下载节点包、上传产物也带着它；控制面派发任务时给每次任务尝试一个只在这次尝试有效、只能下载本项目产物的任务凭据（环境变量 \`SFLY_TASK_TOKEN\`）。协议只新增字段（\`AssignTask.task_token\`），旧 Agent 不认识它照常执行任务。

- **先有管理员账号**：给 Agent 签发凭据要管理员登录（部署时用 \`SFLY_ADMIN_LOGIN\`、\`SFLY_ADMIN_PASSWORD\` 建第一个平台管理员，或初始化码）。在 \`sfly\` 命令行里：\`sfly agent credentials issue <名称> --token-only\`，把原值经管道交给测试机上的 \`read -r SFLY_TOKEN\`，不要写在命令行参数里。
- **本版本内**：还没有凭据的 Agent（以及配了 \`SFLY_AGENT_TOKEN\` 共享令牌的）照常连接，只限默认项目里已经登记过的名字；**下一个版本起拒绝**，请现在就给每台 Agent 签发凭据。一个名字在项目里有没吊销的凭据，就只认凭据；还在用共享令牌的 Agent，签发之后重启前先把凭据换进 \`agent.env\`，否则重连被拒绝。
- **被拒绝时 Agent 不再退出**：连接被控制面拒绝（凭据无效或被吊销、名字和凭据不一致、Agent 被停用……）时，Agent 以前直接退出、systemd 每 5 秒拉起一次；现在不退出，按 30 秒起、最长 5 分钟的间隔重试，原因只在第一次和变了的时候打印到标准错误，管理员改好之后自己连上。
- **\`install.sh --dev\` 的命名变了**：不再叫 \`dev-<系统用户名>-<主机名>\`。不给 \`--name\` 时，装好 \`sfly\` 之后用你的登录（\`SFLY_API_TOKEN\` 或 \`sfly login\`）向控制面注册自己的开发 Agent，名字由控制面生成（\`dev-<登录名>-<主机>\`），凭据记在你名下；没有登录也没有终端时直接失败并说明怎么办。重新运行沿用 \`agent.env\` 里已有的名字和 Agent 凭据（\`sfly_agt_\` 开头；旧版本装的开发机里是共享令牌，不沿用，会注册新的）。以前装的开发 Agent 重新运行后换成新名字，旧名字留在 Agent 列表里（离线），场景里选了旧名字的节点要改。\`--dev --name <名称>\` 照旧可用（这时要给管理员签发的凭据）。
- **旧开发机重新运行 \`--dev\` 撞名**：系统用户名恰好就是登录名、主机名也没变时，新名字和旧名字相同，控制面认为这个名字是别人留下的（你名下没有过它的凭据），注册被拒绝，安装脚本失败并写明办法：加 \`--dev-host <另一个主机名>\` 换个名字；或者请管理员为旧名字签发凭据（\`sfly agent credentials issue <旧名称>\`），再用 \`--dev --name <旧名称>\` 重新运行（凭据经环境变量 \`SFLY_TOKEN\` 给）；名字是你自己以前注册的开发 Agent 时，先 \`sfly agent revoke-dev <名称>\` 再重新运行。
- **\`--dev\` 不给 \`--name\` 时不能同时给 \`--token\`（或设置 \`SFLY_TOKEN\`）**：名字和凭据都由控制面生成。环境里还留着 \`SFLY_TOKEN\`（旧版本用它传共享令牌）的人照旧命令重新运行会直接报错：\`unset SFLY_TOKEN\` 再运行，或者同时给 \`--name\`。
- **新 Agent 连旧控制面**：带 Agent 凭据的新 Agent 连一个配了共享令牌的旧控制面会被拒绝（旧控制面只认共享令牌）；没配共享令牌的旧控制面照旧能连。旧控制面不下发任务凭据，Agent 不设置 \`SFLY_TASK_TOKEN\`，SDK 下载产物不带凭据。
- **命令行**：新增 \`sfly agent credentials issue|list|revoke\`、\`sfly agent register-dev|revoke-dev\`；\`sfly agent register-dev\` 没有登录凭据时退出码是 5，名字已被占用（409）时退出码是 6。
EOF
