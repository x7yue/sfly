# 工作台镜像（ADR 0027、#549）：助手在上面写节点、调试、编排和运行的那台 Agent。
#
#   docker build -t sfly-workbench deploy/workbench
#
# 镜像里只有操作系统工具：git、ripgrep、fd、jq、curl、procps、python3（和 `python` 这个命令：模型常先敲它）。
# **没有 Node，没有 pi**（pi 在助手容器里，循环在工作台之外，ADR 0027），**也没有 Agent**：Agent、uv、`sfly` 命令行
# 都来自控制面（入口脚本在家目录里没有它们时，下载控制面的 install.sh 按 `--dev` 方式装），版本和控制面一致。
# Agent 自己照常自更新（ADR 0011、0014）；sfly 命令行不会自更新（钉在装时的版本），所以入口脚本每次启动都对一下控制面的
# install.sh，变了（控制面升级、改了对外地址）就重装。镜像只在操作系统工具变化时才需要换，不随控制面的版本变。
# 节点包自己的 Python 由 uv 管（共享 venv，ADR 0002），不是这里的 python3。
#
# 非 root 用户 workbench（uid 1000，和助手镜像的 node 用户同号）。两个卷归它：家目录 /home/workbench
# （里面有 ~/.sfly：Agent、共享 venv、任务目录；还有 --dev 装的 uv 和 sfly：~/.local、~/.cache）和 /work（工作区）。
# 命名卷首次挂载时沿用镜像里这两个目录的属主。
# 运行方式见 deploy/docker-compose.yml 的 assistant profile（Node 以外的进程也要有 init：`init: true` / `docker run --init`）。
# 入口脚本的约定（环境变量、「已经装好」怎么判断）写在 entrypoint.sh 的开头。

FROM debian:trixie-slim

# 在不能直接访问 deb.debian.org 的网络里构建时指向镜像站（例如 http://mirrors.ustc.edu.cn）；Release 构建不传。
# **不要带用户名和密码**：构建参数会留在镜像历史里（`docker history`），拿到镜像的人都读得到。
ARG DEBIAN_MIRROR=

# curl、ca-certificates：入口脚本和安装脚本下载用；procps：模型常用的 ps、pkill，也给健康检查用 pgrep；
# iptables：出网名单（firewall.py）用，工作台的用户没有 NET_ADMIN，用不了它。
# install.sh 要的 sh、sed、sha256sum、flock、tar 都是基础系统自带的。
RUN if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl fd-find git iptables jq procps python-is-python3 python3 ripgrep \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash workbench \
 && install -d -o workbench -g workbench /work

COPY --chmod=0755 entrypoint.sh /usr/local/bin/sfly-workbench-entrypoint
# 出网名单（#498）：compose 的 sfly-workbench-firewall 用同一个镜像以 root 运行它，工作台自己不运行。
COPY --chmod=0755 firewall.py /usr/local/bin/sfly-workbench-firewall

USER workbench
# --dev 装的 uv 和 sfly 在 ~/.local/bin：放在 PATH 最后，系统目录里有的命令不会被家目录（卷，模型写得了）里的盖掉。
# 入口脚本自己不看这个 PATH（它只用系统目录，exec Agent 之前才把 ~/.local/bin 加回去），这里是给 `docker exec` 进来的人用的。
ENV PATH="${PATH}:/home/workbench/.local/bin"
WORKDIR /work
VOLUME ["/home/workbench", "/work"]

# 不 EXPOSE、也不在 compose 里映射端口：Agent 的能力端口（默认 50052）没有认证（agent/src/peer.rs），
# 只让同一个网络里的控制面和助手服务连得到。
# 入口脚本结束（Agent 在前台运行）之前、第一次安装还在下载 uv 和 sfly 时，健康检查是 starting。
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --start-interval=5s --retries=3 \
    CMD ["pgrep", "-x", "sfly-agent"]

ENTRYPOINT ["/usr/local/bin/sfly-workbench-entrypoint"]
