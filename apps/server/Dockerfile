# 控制面镜像（ADR 0010）。构建上下文是 `pnpm bundle:server` 的产物 out/server/：
#
#   docker build -f apps/server/Dockerfile -t sfly-server out/server
#
# 产物是纯 JS，与 CPU 架构无关；这里只复制文件、没有 RUN，构建多架构镜像不需要模拟执行。
# 运行方式见 deploy/docker-compose.yml（Node 官方建议用 --init / `init: true` 启动）。
FROM node:26-trixie-slim

ENV NODE_ENV=production \
    SFLY_DATA_DIR=/data

# 程序文件归 root 所有，运行用户只读。
COPY . /app/

# 数据目录在 USER 之后创建，归 node 用户所有；命名卷首次挂载时沿用这个属主。
USER node
WORKDIR /data
VOLUME /data

# HTTP（页面、API、SSE、节点包与 SDK 下载）和 Agent 网关（gRPC）。
EXPOSE 8080 50051

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.SFLY_HTTP_PORT || 8080}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--enable-source-maps", "/app/main.mjs"]
