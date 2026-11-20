# 臂 B 的 pi 运行环境：工作台镜像加上打包好的远程工具扩展（单个 extension.mjs，依赖都打进去，
# 只有 @earendil-works/pi-coding-agent 留给 pi 自己提供）。
# 构建上下文由 aeval 组装：evals/assistant/remote-tools/ 和 packages/proto/src/gen/sfly/agent/v1/，
# 保持在仓库里的相对位置，扩展的 import 路径不用改。
ARG WORKBENCH_IMAGE=sfly-aeval-workbench:pi-1.6.0
ARG NODE_IMAGE=node:26-trixie

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /build
# 版本和仓库的 pnpm-lock.yaml 一致。
RUN npm init -y >/dev/null \
 && npm install --ignore-scripts --registry "$NPM_REGISTRY" \
      esbuild@0.25.12 @bufbuild/protobuf@2.16.0 @connectrpc/connect@2.3.0 @connectrpc/connect-node@2.3.0
COPY . /build/src/
RUN npx esbuild src/evals/assistant/remote-tools/extension.ts --bundle --platform=node --format=esm \
      --target=node22 --external:@earendil-works/pi-coding-agent --outfile=/build/extension.mjs

FROM ${WORKBENCH_IMAGE}
COPY --from=build /build/extension.mjs /opt/aeval-remote/extension.mjs
