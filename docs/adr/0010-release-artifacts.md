# 发布：控制面打成单文件放进 Docker 镜像，Agent 用 musl 静态链接，产物放在 GHCR 和 Release 附件

推送 `vX.Y.Z` tag 后由 GitHub Actions 发布（`.github/workflows/release.yml`）。控制面在开发时继续用 tsx 直接运行源码，发布时用 esbuild 打成一个 `main.mjs`（含全部 npm 依赖），连同迁移、前端产物和同版本的 SDK wheel 放进以 `node:26-trixie-slim` 为基础的镜像。Agent 编译成 x86_64 和 aarch64 的 musl 静态二进制，不依赖目标机器的 glibc，老版本系统也能运行。镜像推送到 GHCR，Agent、SDK wheel、离线用的 `docker save` 镜像和 `SHA256SUMS` 作为 GitHub Release 附件。发布流程不使用 Actions Artifacts：私有仓库的 Artifacts 与 Packages 共用很小的存储额度，而 Release 附件不限总量和流量，GHCR 的容器镜像目前也不计费。各 job 直接上传到草稿 Release，全部成功后再发布。

Agent、SDK 运行时和控制面共用一个版本号（`scripts/release/version.sh`），因为控制面按「Agent 版本 == SDK wheel 版本」给 Agent 下发 SDK。

## Considered Options

- **镜像里继续用 tsx 运行源码**：不用改代码，但每次启动都要编译 TypeScript（实测启动约 1 秒、内存约 260 MB，打包后约 0.25 秒、110 MB），镜像还要带 72 MB 的依赖目录，其中包括分架构的 esbuild 原生二进制。
- **tsc 编译 + `pnpm deploy --prod`**（Fastify 和 pnpm 文档里的常规做法）：对依赖最没有限制，但 `@sfly/*` 工作区包直接导出 `.ts` 源码，要改成开发和发布两套导出，tsx、vite、vitest、tsc 都得配同样的解析条件；产物仍有约 50 MB。
- **Node 26 直接运行 TypeScript**：Node 只去除类型注解，不支持参数属性和 enum（v26 删除了 `--experimental-transform-types`），也不处理 `node_modules` 里的 TypeScript；导入路径还要从 `.js` 改为 `.ts`，改动太大。
- **Agent 用 glibc 动态链接**：在构建机的 glibc 版本以下的系统上无法运行。
- **产物放 Cloudflare R2**：可行，但要多维护一套凭据和桶；在 Release 附件和 GHCR 不受额度限制的前提下没有必要。

## Consequences

- 打包后，所有模块共用一个 `import.meta.url`，按源码位置推算的路径都会失效。`main.ts` 用 esbuild 定义的 `SFLY_BUNDLED` 区分两种情况，打包后改为使用 `main.mjs` 旁边的 `web/`、`sdk/`、`drizzle/`。新增依赖运行时文件的代码要照此处理。
- 依赖必须能被打进单文件：引入原生模块、按文件路径加载 worker 的库（例如 pino 的 transport，pino 官方说明打包时需要额外生成文件）或动态 `require` 时，要设为 external 并装进镜像，或者改用 tsc + `pnpm deploy`。CI 里真实 Agent 对接打包后的控制面跑通一条链（`pnpm test:bundle`），镜像能通过健康检查（`pnpm test:image`），这类问题会在合入前暴露。
- 只支持 `X.Y.Z` 版本：预发布版本在 Cargo（`0.2.0-rc.1`）和 Python（规范化为 `0.2.0rc1`）里的写法不同，控制面匹配不上，Agent 会拿不到 SDK。
- 镜像只带同版本的 SDK wheel，控制面和 Agent 要一起升级。
- 发布前要求 tag 指向的提交在 main 上且 CI 已通过，所以 main 上的 CI 不再因为新的推送而被取消。

## 修订

- 镜像里也带同版本的 Agent 二进制，由控制面提供下载和安装脚本（ADR 0011）；Agent 自更新见 ADR 0014。
