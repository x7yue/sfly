# check=skip=InvalidDefaultArgInFrom
# `pnpm linux` 的镜像（scripts/linux/run.sh 构建）：与 CI 相同的工具链（Node、pnpm、Rust、protoc、uv 与 Python）。
# Node 主版本、pnpm 与 Python 的版本由 run.sh 从仓库读取后传入。
# 下面带默认值的 ARG 是下载地址：默认是官方源，访问不了时在 ~/.config/sfly/linux.env 里换成镜像（见 run.sh）。
ARG NODE_MAJOR
# pnpm lint:actions 用的 actionlint（含 shellcheck），与 scripts/lint-actions.sh 同一个镜像。
ARG ACTIONLINT_IMAGE
FROM ${ACTIONLINT_IMAGE} AS actionlint

FROM node:${NODE_MAJOR}-trixie
COPY --from=actionlint /usr/local/bin/actionlint /usr/local/bin/shellcheck /usr/local/bin/

# Debian 的软件源，例如 https://mirrors.tuna.tsinghua.edu.cn（替换 http://deb.debian.org）。
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|http://deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends protobuf-compiler pkg-config musl-tools python3-pip rsync \
	&& rm -rf /var/lib/apt/lists/*

# npm 的 registry：装 pnpm，之后 pnpm install 也用它。
ARG NPM_REGISTRY=
ARG PNPM_VERSION
RUN if [ -n "$NPM_REGISTRY" ]; then echo "registry=$NPM_REGISTRY" >/root/.npmrc; fi \
	&& npm install -g "pnpm@$PNPM_VERSION"

# 装 uv 用的 PyPI 源。uv sync 用项目自己声明的源（pyproject.toml），与这里无关。
ARG PIP_INDEX_URL=
ARG UV_VERSION=0.13.7
RUN pip3 install --break-system-packages ${PIP_INDEX_URL:+--index-url "$PIP_INDEX_URL"} "uv==$UV_VERSION"

# rustup 与工具链的下载地址；crates.io 的镜像（例如 sparse+https://rsproxy.cn/index/）写进 cargo 的配置。
# 两个 musl 目标给 pnpm pack:agents 用。cargo 的下载缓存放在卷里（entry.sh）。
ARG RUSTUP_DIST_SERVER=https://static.rust-lang.org
ARG RUSTUP_UPDATE_ROOT=https://static.rust-lang.org/rustup
ARG CARGO_MIRROR=
ENV RUSTUP_DIST_SERVER=$RUSTUP_DIST_SERVER RUSTUP_UPDATE_ROOT=$RUSTUP_UPDATE_ROOT PATH=/root/.cargo/bin:$PATH
RUN curl -fsSL "$RUSTUP_UPDATE_ROOT/dist/$(uname -m)-unknown-linux-gnu/rustup-init" -o /tmp/rustup-init \
	&& chmod +x /tmp/rustup-init \
	&& /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain stable -c clippy -c rustfmt \
		-t x86_64-unknown-linux-musl -t aarch64-unknown-linux-musl \
	&& rm /tmp/rustup-init \
	&& if [ -n "$CARGO_MIRROR" ]; then \
		printf '[source.crates-io]\nreplace-with = "mirror"\n\n[source.mirror]\nregistry = "%s"\n' "$CARGO_MIRROR" >/root/.cargo/config.toml; \
	fi \
	&& ln -s /vol/cache/cargo-registry /root/.cargo/registry \
	&& ln -s /vol/cache/cargo-git /root/.cargo/git

# uv 下载 Python 的地址，例如 https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone。
ARG PYTHON_VERSION
ARG UV_PYTHON_INSTALL_MIRROR=
RUN if [ -z "$UV_PYTHON_INSTALL_MIRROR" ]; then unset UV_PYTHON_INSTALL_MIRROR; fi \
	&& uv python install "$PYTHON_VERSION"

# 缓存与工作区副本在卷里，跨文件系统时 uv 不能硬链接。
ENV UV_LINK_MODE=copy CARGO_TERM_COLOR=always
