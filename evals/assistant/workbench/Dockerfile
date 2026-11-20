# 评测用的工作台镜像：开发环境容器和被测机容器都用它。
# 只放与 sfly 无关、必须在构建时联网才能装的东西（ripgrep、fd、锁定版本的 pi）；
# Agent、uv、Python 和 sfly 命令行由环境启动时按用户文档的 install.sh 安装，和用户拿到的一样。
ARG NODE_IMAGE=node:26-trixie
FROM ${NODE_IMAGE}

ARG DEBIAN_MIRROR=
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PI_VERSION=1.6.0

RUN if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends ripgrep fd-find jq procps \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# 和 pi 官方的容器文档一样：--ignore-scripts，pi 不需要安装脚本。
RUN npm install -g --ignore-scripts --registry "$NPM_REGISTRY" "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force \
 && pi --version

LABEL org.opencontainers.image.title="sfly assistant eval workbench" \
      sfly.aeval.pi-version="${PI_VERSION}"
