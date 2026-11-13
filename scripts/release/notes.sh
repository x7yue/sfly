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
EOF
