# 助手镜像（ADR 0027）。构建上下文是 `pnpm bundle:assistant` 的产物 out/assistant/（scripts/bundle.ts）：
#
#   docker build -f apps/assistant/Dockerfile --build-arg NODE_MAJOR="$(cat .node-version)" \
#     -t sfly-assistant out/assistant
#
# 只复制文件、没有 RUN。运行：
#
#   docker run --init -e SFLY_ASSISTANT_SECRET=<至少 32 个字符> -e SFLY_ASSISTANT_MODEL=<提供方>/<模型> \
#     -v <模型文件>:/config/models.json:ro -v sfly-assistant-data:/data sfly-assistant
#
# 模型文件是 pi 的格式，密钥写成 "$变量名"、经 -e 传入同名环境变量。compose 和发布是 #549。

# Node 主版本只写在仓库根目录的 .node-version，构建时传入（没有默认值，漏传会直接失败）。
ARG NODE_MAJOR
FROM node:${NODE_MAJOR}-trixie-slim

ENV NODE_ENV=production \
    SFLY_ASSISTANT_DATA=/data

# 程序文件归 root 所有，运行用户只读。
COPY . /app/

# 工作区在助手容器里的同名目录（两边路径相同）：空的，助手服务用户可写；pi 在这里运行，只放助手服务复制的 skill。
RUN mkdir /work && chown node:node /work

# 数据目录（每个会话一个目录、pi 的设置目录）在 USER 之后创建，归 node 用户所有；命名卷首次挂载时沿用这个属主。
USER node
WORKDIR /data
VOLUME /data

EXPOSE 8090

# 健康检查也要带共享密钥（助手服务的每个请求都校验）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8090/health', { headers: { authorization: `Bearer ${process.env.SFLY_ASSISTANT_SECRET}` } }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--enable-source-maps", "/app/main.mjs"]
