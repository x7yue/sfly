# sfly

面向内网测试的自动化任务编排平台：在画布上把用户用 Python SDK 开发的节点编排成链，派发到指定的 Agent 上执行。

## 文档

- [GLOSSARY.md](./GLOSSARY.md)：统一术语
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)：架构设计
- [docs/SEMANTICS.md](./docs/SEMANTICS.md)：场景执行语义规范
- [docs/DESIGN-SYSTEM.md](./docs/DESIGN-SYSTEM.md)：前端设计体系（token、组件、状态样式、快捷键、HTTP 契约用法）
- [docs/adr/](./docs/adr/)：架构决策记录
- [PRODUCT.md](./PRODUCT.md)：产品定位（用户、目的、原则）
- [DESIGN.md](./DESIGN.md)：界面的视觉设计系统（配色、字体、布局）
- [CODING_STANDARDS.md](./CODING_STANDARDS.md)：代码审查对照的规范（测试、数据库、文档）

## 开发

工具链：Node（当前 LTS，主版本只写在 `.node-version`，镜像和打包都读取它）、pnpm 10、Rust stable、protoc、uv；测试需要 PostgreSQL（`DATABASE_URL`，默认 `postgres://sfly:sfly@127.0.0.1:5432/sfly`，需要建库权限）。

| 命令 | 作用 |
|---|---|
| `pnpm bootstrap` | 安装 JS/TS、Rust、Python 依赖，并启用 `.githooks/`：推送分支前检查分支名前缀、Node 版本和依赖与锁文件是否一致，再运行版本号检查、gen:check、lint、typecheck（跳过用 `git push --no-verify`）；测试在 CI 里跑 |
| `pnpm gen` | 从 `proto/` 生成 TS 代码，从 `packages/schema` 导出 JSON Schema、路由清单和 API 客户端的类型（`pnpm gen:check` 检查这些生成物没有过期） |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 三种语言的 lint、类型检查、测试；lint 还检查 GitHub Actions 工作流（`pnpm lint:actions`，actionlint，需要 docker 或本机的 actionlint），以及手工抄在几处的版本号是否一致（`pnpm lint:node`：Node 主版本、CI 的 Playwright 镜像标签与 `@playwright/test`、Python 版本、PostgreSQL 镜像，不一致时报出是哪两处）。Agent 只能在 Linux 上编译，在 macOS 上 `lint:rust` 只检查 Agent 的库和可执行文件，测试代码由 CI 或 `pnpm linux` 检查；控制面里依赖真实 Agent 的测试文件在 macOS 上自动跳过（跑完时有提示），用 `pnpm linux pnpm --filter @sfly/server test` 运行 |
| `pnpm linux <命令>` | 在与 CI 相同工具链的 Linux 容器里运行命令（需要 docker），例如 `pnpm linux pnpm test:rust`。在 macOS 上跑 Agent 的测试和只有 Linux 能跑的检查用它；同步、依赖、PostgreSQL 与镜像源的说明见 `scripts/linux/run.sh`。卷 `sfly-linux` 里每个工作区一份副本（0.7 GB 起，编译之后几个 GB）：工作区删掉之后留下的副本每次运行前自动清（也可以 `pnpm linux --prune [--dry-run]` 手动清，`--clean` 只清当前工作区自己的）；一个工作区的编译结果超过 4 GB（`SFLY_LINUX_TARGET_LIMIT_MB`）时先删增量编译的缓存、还超就整个删，uv 缓存超过 1 GB（`SFLY_LINUX_UV_CACHE_LIMIT_MB`）时让 uv 清掉不再被引用的部分。`pnpm linux` 里 cargo 的调试信息只留行号表（`CARGO_PROFILE_DEV_DEBUG`、`CARGO_PROFILE_TEST_DEBUG` 默认 `line-tables-only`，`scripts/linux/cargo-env.sh`）：从头构建的编译结果小一半多、快几倍，panic 的回溯里文件和行号还在，只是调试器看不到变量的类型信息；CI 和直接跑 cargo 不受影响，宿主上设了这两个变量就用设的（要完整的调试信息设成 `true`）。**升级后第一次 `pnpm linux` 会把这个工作区已有的 `target` 整个重编一次**（调试信息是编译指纹的一部分），几分钟。同步只写内容变了的文件，写过的文件修改时间是现在、没变的不动（`scripts/linux/sync-copy.sh`）：cargo 按修改时间判断要不要重编，所以在容器里改过源码再还原、或宿主上换了一份修改时间更早的内容，下一次运行都会重编，不再沿用改过的二进制 |
| `pnpm heavy [--pg] <命令>` | 重型命令（完整测试、`pnpm test:e2e*`、`pnpm linux` 整套、`pnpm perf`）在本机同一把 flock 锁上排队、前台运行，并把 `TMPDIR`、`CARGO_TARGET_DIR` 指向按工作区区分的短目录（Unix socket 路径不能超过 108 字节）。多个工作区同时跑时用它。`--pg` 为这次运行单独起一个 PostgreSQL 容器并设置 `DATABASE_URL`，结束时删掉，避免共用的库超过连接上限；`pnpm heavy --clean` 删掉短目录和这个工作区没人在用的 PostgreSQL 容器（还有 heavy 在跑时保留短目录和它的容器）。同名、位置不同的两个检出会共用短目录和容器标签，目录名要不同。macOS 的 flock 用 `brew install flock` 安装，CI 上不加锁；锁文件和目录用 `SFLY_HEAVY_LOCK`、`SFLY_HEAVY_TMP_ROOT` 改，见 `scripts/heavy.sh`。`--pg` 的容器连它的匿名数据卷一起删（`docker rm -f -v`）；#525 修好之前的版本每跑一次留下一个没有容器引用的卷（50 到 80 MB），升级后清一次：先 `docker volume ls -qf dangling=true` 看一眼，再 `docker volume prune`（Docker 23 及以上只删匿名卷；更老的版本还会删没有容器在用的命名卷，例如 `pnpm linux` 的 `sfly-linux`，那时改用 `docker volume ls -qf dangling=true \| grep -E '^[0-9a-f]{64}$' \| xargs docker volume rm`）。没有容器引用的匿名卷里也包括本机别的项目留下的，不需要的再删 |
| `pnpm proto:breaking` | buf breaking 检查 |
| `pnpm check` | CI 执行的全部检查（GitHub Actions：push 到 `main` 和 `dev`、PR（含草稿），以及手动触发；CI 里按语言拆成并行的 job） |
| `pnpm test:e2e` | 构建 API 客户端和前端并运行 Playwright 端到端测试（`apps/web/e2e`；视觉回归只在设了 `SFLY_VISUAL=1` 时跑（`pnpm test:e2e:docker` 和 CI 的 e2e job 设了它），直接在本机运行时跳过；首次需 `pnpm --filter @sfly/web exec playwright install chromium`） |
| `pnpm test:e2e:docker` | 在 Playwright 官方镜像中运行（与 CI 相同，视觉基线以它为准；加 `--update-snapshots` 更新基线） |
| `pnpm test:e2e:stress <spec:行号>` | 复现 e2e 偶发失败：限制在 2 个 CPU 上重复运行（默认 40 次），修复后用同一命令确认失败降到 0；Linux 用 `taskset`，macOS 在 Playwright 镜像里用 `docker --cpus=2`。CI 上失败的用例用 `pnpm ci:failures` 查 |
| `pnpm test:e2e:changed [基准 [Playwright 参数…]]` | 把相比基准（默认 `origin/main`）新增或改动的 e2e spec 重复运行 2–5 次，基准后面的参数交给 Playwright（CI 分片时传 `--shard=i/4`）；CI 在 PR 上自动运行。`bash scripts/e2e-changed.sh --list` 只列出选中的 spec |
| `pnpm test:stress [-n 次数] <命令>` | 复现其他测试的偶发失败：限制在 2 个 CPU 上把同一条测试命令重复运行（默认 30 次），失败那几次的输出留在临时目录。例如 `pnpm test:stress cargo test --locked -p sfly-agent --test retention` |
| `pnpm ci:failures <运行 ID>` | 只看 CI 一次运行里失败的测试（vitest、Playwright、pytest、cargo test 的失败块和断言差异），不用翻完整日志。运行 ID 在 `gh pr checks <PR>` 给出的链接里（`.../actions/runs/<运行 ID>/job/...`） |
| `pnpm --filter @sfly/server dev` / `pnpm --filter @sfly/web dev` | 启动控制面 / 前端开发服务器（端口 3000，`/api` 代理到控制面） |
| `pnpm bundle:server` | 构建前端、SDK wheel 和 API 客户端安装包，把控制面打成单文件，连同用户文档（`docs/guide`）和 `out/agent/` 里两个架构的 Agent 组装到 `out/server/`（镜像的构建上下文，ADR 0010、0011；先 `pnpm pack:agents`） |
| `pnpm test:bundle` / `pnpm test:image` | 用打包后的控制面的 install.sh 安装 Agent 并跑通一条链，上一个 Release 的 Agent 在它上面跑完任务后自更新 / 构建镜像并检查健康检查、页面、API 和两个架构的 Agent（都需要先 `pnpm bundle:server`；后者需要 docker 和 psql） |
| `pnpm fetch:previous-agent [--simulate [版本]]` | 从 GitHub Release 下载上一个发布版本的 Agent 到 `out/previous-agent/`，给 `test:bundle` 的跨版本自更新测试用（需要 `gh` 已登录）；`--simulate` 用当前打包的 Agent 扮演上一版本，本地验证自更新的全流程（见 `docs/agents/branching-and-release.md`） |
| `pnpm pack:agent <target>` / `pnpm pack:agents` | 构建并打包 musl 静态链接的 Agent（`x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`；在别的架构上用 rust-lld 交叉编译，不运行产物）到 `out/agent/`；后者打包两个架构 |
| `pnpm perf [--only <项>]` / `pnpm perf:soak [--duration 1h]` | 本地性能测试（不进 CI，docs/ARCHITECTURE.md §7.6）：构建 release Agent 与打包后的控制面，用本机 PostgreSQL 跑负载测试与基准测试（约 10 分钟），报告写到仓库之外的本机结果目录（默认 `~/.local/share/sfly/perf/<时间>/report.md`），并与本机上一次、仓库里最近一个版本的发版报告（`docs/perf/<版本>/`）对比。`pnpm perf:soak` 是长时负载测试（默认 1 小时，报告在结果目录的 `soak/` 下，中途 Ctrl-C 也会写报告）。加 `--release` 时通过后把报告存进 `docs/perf/<当前版本>/`。发版前与改动关键路径的 PR 必跑，见 `docs/agents/branching-and-release.md` |
| `pnpm release:version show \| check \| set X.Y.Z` | 查看 / 校验 / 修改版本号（Agent、SDK、API 客户端、控制面、助手服务共用一个版本号） |

## 发布

推送 `vX.Y.Z` tag 后由 GitHub Actions（`.github/workflows/release.yml`，ADR 0010）发布：

1. 在 `release/X.Y.Z` 分支上运行 `pnpm release:version set X.Y.Z`，开 PR；在这个分支上运行 `pnpm perf --release`，把存进 `docs/perf/X.Y.Z/` 的报告提交进 PR，描述里贴结论与变化（不通过不发版）。合入 `main`，等 `main` 上的 CI 通过。
2. `git tag vX.Y.Z <main 上的提交> && git push origin vX.Y.Z`。
3. 工作流检查 tag 与版本号一致、`docs/perf/X.Y.Z/report.json` 已提交（没跑性能测试就发不出）、提交在 `main` 上且 CI 已通过，然后构建并发布：
   - 镜像 `ghcr.io/x7yue/sfly-server:X.Y.Z`（另有 `X.Y`、`latest` 标签，linux/amd64 与 linux/arm64）；助手镜像 `ghcr.io/x7yue/sfly-assistant:X.Y.Z` 和工作台镜像 `ghcr.io/x7yue/sfly-workbench:X.Y.Z`（可选，compose 的 `assistant` profile 用，标签和架构同上）
   - Release 附件：Agent `sfly-agent-X.Y.Z-{x86_64,aarch64}-unknown-linux-musl.tar.gz`、离线镜像 `sfly-server-X.Y.Z-linux-{amd64,arm64}.tar.gz`、`sfly-assistant-X.Y.Z-linux-{amd64,arm64}.tar.gz`、`sfly-workbench-X.Y.Z-linux-{amd64,arm64}.tar.gz`、SDK `sfly-X.Y.Z-py3-none-any.whl`、`SHA256SUMS`

助手镜像由 `pnpm bundle:assistant` 的产物构建（`apps/assistant/Dockerfile`，只复制文件，没有 RUN），工作台镜像由 `deploy/workbench/` 构建（要 apt 装工具，arm64 部分在工作流里用 QEMU 构建）。工作台镜像里没有 Agent：Agent、uv、sfly 命令行来自控制面，所以它的内容不随版本变，只是每个版本都打同版本的标签，部署的人用同一个 `SFLY_VERSION`。三个镜像在 CI 的 `package` 里各有一条冒烟检查：`pnpm test:image`（控制面）、`pnpm test:image:assistant`（助手：`/health` 返回版本）、`pnpm test:image:workbench`（工作台连上控制面、装好 Agent、在线），再加 `pnpm test:compose`（用 `deploy/docker-compose.yml` 本身起 `--profile assistant`：三个服务都在、工作台在线、假的模型端点做完一个会话、删掉工作台容器再建不重装）。要在不通外网的网络里验证整套（照评测集的 `./aeval.sh up --offline --isolated`，镜像站只用缓存），手动运行 `pnpm heavy pnpm test:offline-stack`（第一次加 `--record` 联网录一遍缓存）；它会在本机占用几分钟的 CPU 和内存，不进 CI。

只支持 `X.Y.Z`，不支持预发布版本（见 ADR 0010）。不使用 Actions Artifacts；失败时直接重新运行工作流，草稿 Release 会被复用。
CI 用上一个 Release 的 Agent 验证它能在当前控制面上跑完任务并自更新，含义与失败时的处理见 `docs/agents/branching-and-release.md`「跨版本自更新测试」。

标准节点包 `sfly-std`（`std/`，ADR 0017）版本号独立，推送 `std-vX.Y.Z` tag 后由 `.github/workflows/std-release.yml` 发布：
Release 附件 `sfly-std-X.Y.Z.sflypkg` 与 `SHA256SUMS`，部署者下载后以平台管理员的身份发布到控制面的公共项目（开发文档「标准节点」页）。步骤见 `docs/agents/branching-and-release.md`「发布 sfly-std」。

## 部署与运维

控制面以 Docker 镜像部署（`deploy/docker-compose.yml`，数据库用已有的 PostgreSQL）：

```sh
cd deploy && cp .env.example .env   # 填好 DATABASE_URL、SFLY_PUBLIC_URL 等
docker login ghcr.io                 # 私有镜像：用有 read:packages 权限的个人令牌登录
docker compose up -d
```

- 镜像里是打成单文件的控制面、前端产物、数据库迁移、同版本的 SDK 运行时 wheel 和 API 客户端安装包；以 `node` 用户运行，数据（节点包、日志、产物）在卷 `/data`，启动时自动执行迁移，健康检查请求 `/api/health`。
- 无法访问 ghcr.io 时，用 Release 附件里的离线镜像：`gunzip -c sfly-server-X.Y.Z-linux-amd64.tar.gz | docker load`。
- 助手和工作台是可选的，不带 `--profile assistant` 时只有控制面：设置和步骤见下面「助手和工作台」。
- 控制面是单进程设计，**同一个数据库只能运行一个实例**；控制面与 Agent 要升级到同一版本（镜像只带同版本的 SDK wheel）。
- **升级时先停掉旧版控制面，再启动新版**，不要让两个版本同时连着同一个数据库：新版的迁移给场景、运行、Agent、节点包和飞书机器人加上了所属的项目（非空的列），迁移完成之后，旧版代码再插入运行或场景会因为缺这一列而失败。
- 镜像（ADR 0012）：控制面统一配置 PyPI 镜像 `SFLY_PYPI_MIRROR` 和 GitHub Release 镜像 `SFLY_GITHUB_RELEASE_MIRROR`，在握手时下发给所有 Agent：Agent 从 GitHub Release 镜像安装 uv、下载 Python，从 PyPI 镜像安装节点包依赖。两项都没有默认值，不配置时 Agent 用 uv 的官方来源。内网用中科大镜像时：

  ```sh
  SFLY_PYPI_MIRROR=https://mirrors.ustc.edu.cn/pypi/simple
  SFLY_GITHUB_RELEASE_MIRROR=https://mirrors.ustc.edu.cn/github-release
  ```

  单台机器可以在本机覆盖（Agent 的 `--index-url`、`--github-release-mirror`、`--python-install-mirror`，即 `agent.env` 的 `SFLY_INDEX_URL`、`SFLY_GITHUB_RELEASE_MIRROR`、`SFLY_PYTHON_INSTALL_MIRROR`），install.sh 和 `sfly init` 读取同样的配置，见用户文档「安装 Agent」的「单台机器覆盖镜像」。

  install.sh 和 Agent 用 curl、wget 下载时带 User-Agent `sfly-agent/<版本>`（镜像站会封禁它们的部分默认 User-Agent，[ustclug/discussions#479](https://github.com/ustclug/discussions/issues/479)），本机可以用 `SFLY_USER_AGENT`（Agent 的 `--user-agent`）换成自己机构的标识，见用户文档「安装 Agent」的「下载用的 User-Agent」。

- 飞书通知（ADR 0020）：控制面直接访问飞书机器人的 Webhook 地址（不写死飞书域名），这是控制面第一次主动对外发 HTTP 请求，所以**控制面所在的机器要能直接访问飞书**（不支持代理；官方飞书是 `open.feishu.cn` 的 443 端口，私有部署的飞书按登记的地址）。Agent 不需要出网。
  - 飞书群里的机器人开启了 IP 白名单时，填**控制面**访问飞书的出口 IP，不是 Agent 的 IP。sfly 不支持签名校验，机器人只能用关键词或 IP 白名单。
  - 在「飞书机器人」页登记机器人后，点「发送测试消息」立即验证；失败时页面用中文写出原因和下一步。
  - 消息先存在数据库里，控制面重启后接着投递。发不出去时（网络错误、超时、飞书限流或服务不可用）退避重试，从入队算起 10 分钟还没送达就放弃；每个机器人每秒最多发 5 条、每分钟最多 100 条，积压超过 1000 条时丢弃最旧的。「飞书机器人」页显示每个机器人最近一次投递的时间和结果，以及积压的条数，据此发现某个群发不出去。
  - 运行通知卡片上的「查看运行」按钮用 `SFLY_PUBLIC_URL` 拼出链接（`<SFLY_PUBLIC_URL>/runs/<运行 ID>`），所以要让用户在群里点得开，就把 `SFLY_PUBLIC_URL` 配成浏览器能访问的控制面地址；没有配置时卡片不显示按钮。
  - Webhook 地址相当于一个凭据：数据库里明文保存，界面和日志里只露出开头和结尾。平台没有认证（ADR 0004），能打开页面的人可以新增、替换、删除机器人，也能让它往群里发测试消息。
- 跨域（ADR 0022）：用户自建的页面托管在别的来源，浏览器调用控制面前先预检。控制面默认允许所有来源（不带凭据）；设置 `SFLY_CORS_ORIGINS`（逗号分隔的来源，例如 `https://dash.example.com,http://localhost:5173`）后只允许名单里的来源，名单外的页面被浏览器拦下。没有登录时，「允许所有来源」意味着内网用户在浏览器里打开的任何网页都能调用他访问得到的控制面，包括触发和取消运行；不放心时收窄成名单。控制台自己的页面同源，命令行和 Agent 不经浏览器，都不受影响。自建页面托管在公网、控制面在内网时 Chrome 另有限制（页面要是 HTTPS，用户要允许访问本地网络），见用户文档「用 API 客户端做自己的页面」。
- 保留期、大小上限和登录的空闲期限（`SFLY_RETENTION_DAYS`、`SFLY_METRIC_RETENTION_DAYS`、`SFLY_LOG_LIMIT_MB`、`SFLY_ARTIFACT_LIMIT_MB`、`SFLY_METRIC_LIMIT_MB`、`SFLY_LOGIN_IDLE_HOURS`）在 `deploy/.env.example` 里写明了取值范围，docker compose 会把它们传给控制面：保留天数大于 0、最大 36500（约 100 年，**不想清理就填 36500**，没有别的「永不清理」的写法），大小上限换算成字节后在 1 到 2^53 − 1 之间，登录的空闲期限 2 分钟（写 0.0334 小时或更大）到 876000 小时。不是数、不是有限的数、超出范围的值在控制面启动时就报错退出（写明变量名、填的原文和范围，几个一起报），不会启动之后才悄悄出错。字符串类的也一样（#619）：`SFLY_PUBLIC_URL`（带协议和主机的 http 或 https 地址）、`SFLY_PUBLIC_GRPC_URL`、`DATABASE_URL`（数据库连接库 pg 自己解析得了的连接串，Unix 套接字的写法也行）、两个镜像（http 或 https 地址；PyPI 镜像还认 `file://` 地址和绝对路径，GitHub Release 镜像还认 `file://` 地址：内网、离线的部署用共享目录做镜像）、`SFLY_CORS_ORIGINS`、`SFLY_TRUST_PROXY`，以及要一起给的 `SFLY_ADMIN_LOGIN` 和 `SFLY_ADMIN_PASSWORD`，和数值类的一起检查、一次报完（报错的顺序是读的顺序，是稳定的）。检查不比真正用这个值的一方更严：连接库、uv 认的写法，检查就认。报错里回显填的值只经过一处（`apps/server/src/config/echo.ts`），而且只有数值类的回显、最多 12 个字符（端口、天数、大小上限、代理的层数；更长的只说有多少个字符）：地址类（对外地址、两个镜像、`SFLY_CORS_ORIGINS`、`SFLY_DEV_ORIGINS`）、代理信任的地址段、数据库地址、管理员的登录名和密码一律不回显，说明里只说是哪个变量、第几项、哪里不对和一个正确的写法，所以凭据不会进启动输出和容器日志（地址的主机位置没有长度上限，什么都装得下，所以不回显它）。哪些变量启动时检查、哪些留给第一次用到见 `docs/ARCHITECTURE.md`「启动时检查哪些环境变量」。其余配置见 `apps/server/src/main.ts` 顶部注释。
- **升级前检查 `.env`**（这几个变量以前不在 `docker-compose.yml` 里，换上新的 compose 之后行为会变）：
  - **以前写了也不生效的，换上新的 compose 之后会生效（这一条最要紧）。** `SFLY_RETENTION_DAYS`、`SFLY_METRIC_RETENTION_DAYS`、`SFLY_LOG_LIMIT_MB`、`SFLY_ARTIFACT_LIMIT_MB`、`SFLY_METRIC_LIMIT_MB`、`SFLY_LOGIN_IDLE_HOURS` 以前不在 compose 的 `environment` 里，`.env` 里写了控制面也读不到，一直是默认值。例如 `.env` 里一直放着 `SFLY_RETENTION_DAYS=7`：升级之后保留期从 30 天变成 7 天，运行结束超过 7 天的日志和产物会被清理（不可恢复）。升级前先看一眼 `.env` 里有没有这几项、值是不是你现在想要的，不想要的删掉或留空。
  - **以前能启动、现在启动失败的写法**（按部署方式分开看）：
    - **用 compose 部署的**：这六个变量以前根本没传进容器（见上一条），所以 `.env` 里这六项现在不合法的**任何**写法（`10MB`、`30d`、`0`、`abc`、保留天数超过 36500、登录的空闲期限不到 2 分钟……）以前都能启动，升级后控制面启动失败。
    - **直接给进程设环境变量的**（`docker run -e`、从源码起）：以前能启动、现在失败的有——`Infinity`、`1e400`（保留天数、日志和指标的上限、登录的空闲期限都受影响；保留天数写 `Infinity` 正是以前「清理每分钟报错、悄悄不清理」的那种）；保留天数超过 36500（想「永不清理」而填了很大的数的，改填 36500；36501 到约 247 万这一段以前真的能用，效果就是不清理）；十六进制（`0x1E`）；日志和指标的上限换算成字节后不到 1 字节（`0.0000001`，以前上限就是 0 字节）或超过 2^53 − 1（`8589934592`、`1e300`：这两个上限以前不检查范围，只有产物的上限检查）；登录的空闲期限超过 876000 小时或不到 2 分钟；端口写成 `+8080`、`8080.0`、`1e3`、`0x1F90`、`-0`。（`10MB` 这种带单位的写法以前直接设环境变量就启动不了，不在这一类。）
    - **端口的空串**是行为变化，不是启动失败：以前读成 0（让系统随机选端口），现在用默认端口，仍然能启动。
    - **地址类的变量**（#619，compose 和直接设环境变量的都受影响）：`SFLY_PUBLIC_URL`、`SFLY_PUBLIC_GRPC_URL`、`SFLY_PYPI_MIRROR`、`SFLY_GITHUB_RELEASE_MIRROR` 以前原样往下传。没写协议（`sfly.internal:8080`、`mirrors.ustc.edu.cn/pypi/simple`）以前也能启动：对外地址残缺，Agent 拿到的下载地址和网关地址是坏的，镜像到 Agent 装依赖时才失败；现在启动时就报错。要写成 `http://` 或 `https://` 开头、有主机的地址（镜像还认 `file://`，见下面「镜像」一条）；对外地址和网关地址另外不能带用户名密码、`?`、`#`，网关地址不能带路径。compose 会把 `SFLY_PUBLIC_URL` 和两个镜像传进容器，升级前看一眼 `.env` 里这几项的写法。协议写错（`http//sfly:8080`）以前是 HTTP 已经开始监听之后才带着堆栈崩溃，现在启动前就是一行说明。`SFLY_TRUST_PROXY`、`SFLY_CORS_ORIGINS`、`SFLY_ADMIN_LOGIN` 和 `SFLY_ADMIN_PASSWORD` 写错以前也是启动失败（带堆栈的未捕获错误），现在和别的一起、一次报完，没有堆栈。
    - **`DATABASE_URL`**（#619）：以前原样交给连接库（pg），现在启动时先用连接库自己解析连接串的那个函数检查，**只拒连接库也解析不了的写法**（端口不是数字或超出范围、地址里有不该有的字符、写了多个主机、`sslcert`、`sslkey`、`sslrootcert` 指的文件读不到……）：这些以前在第一次连数据库时才失败（带堆栈），现在启动前就是一行说明（说明里不回显填的值，里面有密码）。连接库认的写法都照旧能用，包括 Unix 套接字的三种（`postgres://用户:密码@/库名?host=/var/run/postgresql`、`/var/run/postgresql 库名`、`socket:/var/run/postgresql?db=库名`，主机写成 `%2F` 编码的目录也行）、多个参数、`sslmode`、IPv6 地址；**写成 `用户:密码@主机/库名`（带 `@`、没有 `://`）的启动时就拒绝**：连接库不是照这个写法的意思用它，而是把整串当成库名、主机取默认值，第一次连库时把这串（含密码）当库名发给默认的主机；说明是固定的文字（「看起来带了用户名和密码，但没有写协议」，不回显填的值）。别的不带 `://` 的写法照旧放行：Unix 套接字的路径、单独一个库名。**空串（`DATABASE_URL=`）和只有空白的行为变了**：以前原样交给连接库，它退回去读 `PG*` 环境变量（`PGHOST`、`PGUSER`、`PGDATABASE`……）；现在和别的变量一个规矩，当作没设置，用内置的默认地址 `postgres://sfly:sfly@127.0.0.1:5432/sfly`。靠「`DATABASE_URL` 留空加 `PG*`」连数据库的部署（直接设环境变量的；compose 里 `DATABASE_URL` 是必填的，不能留空），升级前把 `DATABASE_URL` 写成完整的连接串。`reset-password` 子命令读 `DATABASE_URL` 用的是同一个函数，写法和结果和控制面一致。
    - **镜像**（#619）：`SFLY_PYPI_MIRROR` 和 `SFLY_GITHUB_RELEASE_MIRROR` 认 uv 认的写法：`http://`、`https://` 地址（可以带用户名密码；Agent 的日志和失败原因里写 `***`，#733。凭据写在地址里只在 Agent 握手时下发（#494 之后只给带 Agent 凭据的连接；过渡期没配共享令牌时，连得上 Agent 网关又知道旧方式登记的名字的连接也拿得到）；不用登录就能读的 `/install.sh` 和 `/sdk/project-settings`（`sfly init` 读它）给的是去掉用户名和密码的地址（按单个地址去，去不干净的当没配、启动时警告），#755：开发机上要认证的，凭据放各台机器的 `~/.netrc`，见用户文档「安装 Agent」的「带用户名和密码的私有索引」），PyPI 镜像还认 `file://` 地址和绝对路径（`/mnt/mirror/pypi/simple`），GitHub Release 镜像还认 `file://` 地址（裸的绝对路径 curl 不认，要写成 `file:///mnt/mirror/github-release`）。
    - compose 里 `.env` 的 `SFLY_HTTP_PORT`、`SFLY_GRPC_PORT` 只是宿主机端口的映射，控制面看不到，不受影响。
  - **`SFLY_TRUST_PROXY`、`SFLY_PUBLIC_GRPC_URL`**（#650）：以前 `.env` 里写了也传不进容器（compose 的 `environment` 里没有它们），现在传进去了。`.env` 里已经写着它们的部署，升级后行为会变，这正是写它们时想要的行为：写了 `SFLY_TRUST_PROXY` 的，登录限速开始按它取来源地址（反向代理后面不再所有人共用一个来源地址）；写了 `SFLY_PUBLIC_GRPC_URL` 的，下发给 Agent 的网关地址开始用它（以前取 `SFLY_PUBLIC_URL` 的主机加 50051），之后新装的 Agent 才会写进新的地址。**写错的值现在会让控制面启动失败**（#619 起启动时检查：代理信任只认地址段、层数、关键字；网关地址要带协议、不带路径）：升级前对着 `deploy/.env.example` 和下面「登录与反向代理」看一眼 `.env` 里这两项写的值。初始管理员（`SFLY_ADMIN_LOGIN`、`SFLY_ADMIN_PASSWORD`）有意不在 compose 里传，说明在 `deploy/.env.example`。
  - **数据目录、监听地址**（#651）：`SFLY_DATA_DIR` 指的目录写不了（Docker 卷、挂载的宿主机目录的属主不对最常见：镜像里控制面以 `node`（uid 1000）运行）以前控制面照常启动，要到第一次写文件（上传产物、写任务日志、存节点包）才报错；现在启动时试写一次，写不了就启动失败，说明里写目录、当前用户和怎么改（`docker compose logs sfly` 第一行）。目录不存在时控制面会建它。`SFLY_HTTP_HOST`、`SFLY_GRPC_HOST` 现在只认 IP 地址或主机名（空串当作没设置），写成带协议、用户名密码、端口或路径的地址启动失败（以前原样交给监听，失败的报错会把整串带出来）；compose 没有把这两个变量传进容器（容器里监听的就是 0.0.0.0），直接设环境变量运行的才会碰到。**空串的行为变了**：以前空串原样交给监听，同时监听 IPv4 和 IPv6（`::`）；现在和没设置一样，只监听 IPv4 的 `0.0.0.0`。靠空串同时监听 IPv6 的，改写成 `::`。**主机名只认字母、数字、连字符、下划线和点**（每一段不超过 63 个字符、总长不超过 253 个字符；IPv6 地址不带方括号，带区域标识时区域标识也算在总长里）；以前能监听的写法里，带别的字符的现在启动失败。检查认的写法监听时仍可能失败（解析不了、本机没有这个地址）：说明只写变量名、端口和错误码，不带地址。`SFLY_DATA_DIR` 写成 `~` 开头的现在不合法（环境变量里没有人展开它，以前会在当前目录下建出一个叫 `~` 的目录），要写绝对路径；数据目录写不了时说明里写它的完整路径（启动输出和 `docker compose logs` 里都看得到：不要把要保护的东西写进目录的路径）。
  - **启动失败时**：`restart: unless-stopped` 会让容器反复重启，页面和 Agent 一直连不上。看控制面的启动日志（`docker compose logs sfly`）：第一行是「sfly: 控制面没有启动，…」，写明是哪个变量和要求（数值类的还写填的值，最多 12 个字符；地址、名单、代理、数据库地址、监听地址、密码一律不回显；数据目录写不了时写它的完整路径），几个不合法的一次报完。改 `.env` 里对应的值，再 `docker compose up -d`。
- 需要 TLS 或统一入口时，按 Fastify 官方建议在前面加反向代理。SSE 要关闭代理缓冲；Agent 网关是 gRPC（HTTP/2），要么单独开放 50051，要么用 `grpc_pass` 转发。nginx 示例：

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_buffering off;          # SSE
      proxy_read_timeout 1h;
      client_max_body_size 1g;      # 节点包与产物上传
      proxy_set_header Host $host;                              # 原样传 Host，见下面「登录与反向代理」
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # 把对端地址追加在最后
  }
  ```

- 日志下载（`GET /runs/:id/logs/download`、`GET /tasks/:id/logs/download`）靠 `proxy_http_version 1.1` 才分得出「没下完」：控制面在下载的过程中发现日志文件被删除、被截短，会断开连接。代理用 HTTP/1.0 连控制面时（nginx 1.29.7 之前 `proxy_http_version` 的默认值就是 1.0）响应靠关闭连接来结束，断开和正常结束分不出来，客户端拿到的文件只有断开之前的行，也不报错；用上面的示例（`proxy_http_version 1.1`）就看得出来（curl 退出码非 0，命令行 `sfly run logs --all` 报 `download_incomplete`）。命令行另外按响应头 `x-sfly-log-expect`（范围内有日志的任务数、各任务最后一个序号之和，大小固定）核对：代理用 HTTP/1.0 时，命令行也看得出没下完（浏览器的下载是普通下载，不核对；旧的控制面没有这个头，不核对）。

- **登录与反向代理**（ADR 0029）：
  - **浏览器要用 `SFLY_PUBLIC_URL` 打开控制台。** 登录 Cookie 只认同源的请求；内网用 http 访问时浏览器不发 `Sec-Fetch-Site`，控制面看请求的 `Origin`：配了 `SFLY_PUBLIC_URL` 就和它比，没配就和请求的 `Host` 比。对不上（主机名对 IP、端口不同、反向代理改写了 `Host` 又没配公开地址）时，页面看起来登录着，写请求却被当作没有登录，登出也不生效。登录页和控制台顶部会提示「请用 <公开地址> 打开」。所以反向代理后面要配 `SFLY_PUBLIC_URL`（浏览器看到的地址），或者让代理原样传 `Host`（nginx 的 `proxy_set_header Host $host`）。
  - **来源地址（登录限速用）和 `SFLY_TRUST_PROXY`**：来源地址默认取 TCP 对端的地址。反向代理把它看到的客户端地址追加在 `X-Forwarded-For` 的最后，客户端自己写的在前面，所以要取「可信代理之前的那一个」，最左边的一段不作数（每次换一个就能绕过限速）。每个取值的意思：
    - 不设置（空、`false`、`0`）：不看 `X-Forwarded-For`，来源地址是 TCP 对端。**在反向代理后面这样配，所有人是同一个来源地址**：一个人输错很多次，这个地址上的所有人都被限速。
    - 代理的地址段，例如 `127.0.0.1,10.0.0.0/8`（推荐）：连接控制面的对端在段里，才信它带来的 `X-Forwarded-For`，从右往左跳过段里的地址，第一个不在段里的就是客户端；直连的客户端不在段里，写什么都不作数。
    - 代理的层数 `1`（也可以写 `true`）、`2`……（最多 10）：不管直连的对端是谁，都跳过右边这几个地址。用它时控制面的端口只能经代理访问（防火墙、只监听内网地址），否则直连的客户端能伪造来源。**层数要和实际的代理层数一致**：配多了，取到的是客户端自己写的地址，限速会被伪造的来源绕过；配少了（两层代理只写 `1`），取到的是内层代理的地址，所有人落在同一个限速桶里（偏向多拦，不是绕过）。
    - 写错了（认不出的值）启动失败，不会悄悄退回到不信任或全信任。

    限速用的来源地址会去掉端口，IPv6 按 /64 归在一起（同一个用户通常拿到一整个 /64）。
  - **限速的维度**：按「登录名 + 来源地址」连续失败 5 次之后每次失败等待翻倍（2 秒起，上限 15 分钟），同一个来源地址上失败 30 次之后整个地址也限速；验证在途的尝试也算（并发的请求绕不过）。没有只按登录名（不看来源）的限速：那样任何人都能不停地输错，把某个账号（尤其是管理员）锁在外面，忘了密码的补救只有主机上的命令。另有并发上限：同时验证（和计算）的密码最多 2 个，再多的排队（最多 16 个），队列满了直接回 503 并带 `Retry-After`，不去算哈希：scrypt 和任务日志、产物、节点包下载共用一个线程池，没有上限时一阵并发的登录就能拖慢它们。
  - **事件流**：登录被注销、用户被停用、令牌被吊销时，进程内立即关掉他已经打开的事件流；主机上的 `reset-password` 命令、直接改库、空闲期限到了这些进程内收不到通知的失效，由控制面每 30 秒重新检查一次打开着的流的凭据：**最迟 30 秒之后流被关**。
  - **控制面用独立的主机名**，不和不受信任的应用共用父域：同站的别的子域可以写一个同名的 Cookie 盖住登录 Cookie（`__Host-` 前缀这一步没有做）。

不用 Docker 时，在 `.node-version` 指定的 Node 上直接运行 `pnpm bundle:server` 的产物：`node --enable-source-maps out/server/main.mjs`（前端、SDK、API 客户端、迁移、用户文档、Agent 目录和 install.sh 自动取 `main.mjs` 旁边的 `web/`、`sdk/`、`client/`、`drizzle/`、`docs/`、`agent/`、`install.sh`）。

Agent：从 Release 附件下载对应架构的 `sfly-agent-X.Y.Z-<arch>-unknown-linux-musl.tar.gz`，静态链接，不依赖 glibc 版本（已在 CentOS 7 上验证）。机器上不需要预装 uv 或 Python。启动参数见 `sfly-agent --help`（`--server`、`--name`、`--token`、`--slots`、`--venv`、`--uv`、`--index-url`、`--github-release-mirror`、`--python-install-mirror`、`--user-agent`、`--python` 等，均可用 `SFLY_*` 环境变量设置）。

- Agent 的文件都在 `SFLY_HOME`（默认 `~/.sfly`）下：共享 venv 默认 `$SFLY_HOME/venv`，任务工作目录默认 `$SFLY_HOME/work`，`sfly dev` 用的本地 socket 默认 `$SFLY_HOME/work/agent.sock`，从哪个目录启动都一样。
- 启动时读取 `$SFLY_HOME/agent.env`：每行一个 `KEY=VALUE`，键是参数对应的环境变量名（如 `SFLY_SERVER`、`SFLY_AGENT_NAME`、`SFLY_TOKEN`），`#` 开头的行是注释；命令行参数和环境变量优先于它。`sfly publish` 在没有 `--server` 和 `SFLY_SERVER` 时使用其中的 `SFLY_CONTROL_PLANE_URL`（控制面 HTTP 地址）。
- `--token`（`SFLY_TOKEN`，写在 `agent.env` 里）是 **Agent 凭据**（`sfly_agt_` 开头，管理员为这台 Agent 签发；过渡期里控制面还接受共享注册令牌）：放进 Hello，下载节点包归档和上传产物时带 `Authorization: Bearer`（只对控制面下发的地址带，重定向到别的主机时不带）。控制面派发任务时下发的**任务凭据**只放进执行器的环境变量 `SFLY_TASK_TOKEN`（不写日志和任务目录）。被控制面拒绝（凭据无效或被吊销、名字和凭据不一致、Agent 被停用……）时 Agent 不退出，按 30 秒起翻倍、5 分钟封顶的等待重试（每次取算出来的时长的一半到全部，不按同一个节奏一起重试），原因只在第一次和变了的时候打一行到标准错误，管理员改好之后自己连上，不需要重启；被拒绝期间手上的任务照常跑完，所以吊销、停用一台 Agent 不会停下它手上正在跑的任务，要停下那台机器上的工作得停掉 Agent 服务。凭据经环境变量 `SFLY_TOKEN` 交给 Agent 时，Agent 起的所有子进程（执行器、`exec.run` 的命令和它留下的后台进程、装依赖的进程、准备环境的进程……）的环境里都没有它：起进程只有一个出口（`agent/src/subprocess.rs`），有测试守着；例外只有启动 Agent 自己的新版本（多一层防护，不是隔离：节点和 Agent 同一个系统用户，读得到 `agent.env`）。
- 连上控制面、收到 Welcome（带控制面配置的镜像）之后准备运行环境：
  - uv：没有 `--uv` 时使用 `$SFLY_HOME/bin/uv`，不存在时用 GitHub Release 镜像上 `astral-sh/uv/LatestRelease/uv-installer.sh` 安装到 `$SFLY_HOME/bin`（不修改 PATH；安装脚本需要 curl 或 wget，下载时带 `--user-agent` 的 User-Agent）。指定了 `--uv` 时 Agent 不管理 uv。
  - 共享 venv 不存在时用 `uv venv --python 3.13` 创建，Python 从 GitHub Release 镜像的 `astral-sh/python-build-standalone/` 下载；之后不主动升级 Python。`--python` 可以指定别的版本或解释器。
  - 环境准备失败（没有可用的 uv、安装 uv 失败、创建 venv 失败）时 Agent 以退出码 78 退出，标准错误打印失败的命令、完整输出和镜像地址（标明来自控制面还是本机覆盖），请把它报告给平台管理员。
- 随后若 venv 里的 SDK 运行时版本与 Agent 自身版本不一致，Agent 从控制面下载同版本的 wheel，校验 sha256 后用 `uv pip install` 安装；版本一致时不重装。控制面没有对应版本的 wheel 时保留现状并在日志里告警。
- 节点包依赖从控制面下发的 PyPI 镜像安装；Agent 上的 `--index-url` 优先。本机的 `--github-release-mirror`、`--python-install-mirror` 同样优先于下发的 GitHub Release 镜像和由它推导的 Python 下载镜像。

### 助手和工作台

助手（会话功能，ADR 0027）是可选的：compose 里放在 `assistant` profile 里，不带它时只有控制面（`docker compose config` 的输出和没有这两个服务时一样），不用助手的部署不带 pi。带上 `--profile assistant`（或 `COMPOSE_PROFILES=assistant`）多两个服务，**都不映射端口**：

| 服务 | 镜像 | 卷 | 谁连得到它 |
|---|---|---|---|
| `sfly-assistant` | `ghcr.io/x7yue/sfly-assistant:<SFLY_VERSION>`：助手服务和 pi（Node） | `sfly-assistant-data`（会话目录）；模型文件只读挂载到 `/config/models.json`；内存上限 2 GiB | 同一个网络里的容器（含工作台）都连得到它的端口，但每个请求要带共享密钥 `SFLY_ASSISTANT_SECRET`：只有控制面有它，工作台没有 |
| `sfly-workbench` | `ghcr.io/x7yue/sfly-workbench:<SFLY_VERSION>`：Debian slim 加 git、ripgrep、fd、jq、curl、procps、python3；**没有 Node，没有 pi，没有 Agent**，非 root 用户（uid 1000） | `sfly-workbench-home`（家目录）、`sfly-workbench-work`（工作区 `/work`） | 同一个网络里的控制面和助手服务：Agent 的能力端口没有认证（`agent/src/peer.rs`），所以不映射 |

**开助手，按顺序做：**

1. 在 `.env` 里设置（`deploy/.env.example` 里每一项都有说明）：

   ```sh
   SFLY_ASSISTANT_URL=http://sfly-assistant:8090   # compose 里助手服务的服务名；控制面和助手服务读同一个 SFLY_ASSISTANT_SECRET
   SFLY_ASSISTANT_SECRET=<openssl rand -hex 24 的输出>
   SFLY_WORKBENCH_NAME=workbench                   # 工作台容器里那台 Agent 的名字（不写就是 workbench）：下面按这个名字签发凭据、登记
   SFLY_ASSISTANT_MODEL=gateway/<模型 id>          # 模型文件和这几项的写法见下面「助手的模型」
   SFLY_ASSISTANT_MODELS_FILE=./assistant-models.json
   MODEL_API_KEY=<模型的密钥>                      # 模型文件里 "$MODEL_API_KEY" 引用的变量，只传给助手容器
   ```

   `SFLY_WORKBENCH_TOKEN` 先留空，下一步才有。
2. 先起控制面并建好管理员：`docker compose up -d`，用启动日志里的初始化码在 `/setup` 页建第一个平台管理员（见「登录与反向代理」前面的说明）。
3. **给工作台签发它自己的 Agent 凭据**（不用共享令牌 `SFLY_AGENT_TOKEN`：共享令牌能冒充任何一台 Agent；Agent 凭据只对签发时指定的名字有效，泄露了吊销它就行）。在装了 `sfly` 命令行的机器上（Release 附件的 wheel，或别的开发机）：

   ```sh
   sfly login --server <控制面地址>        # 管理员登录
   sfly api POST /agents/workbench/credentials
   ```

   响应里的 `token`（`sfly_agt_` 开头）是原值，**只显示这一次**，填进 `.env` 的 `SFLY_WORKBENCH_TOKEN`（`.env` 里写着凭据，权限设成只有部署的人读得到）。`workbench` 换成你在 `SFLY_WORKBENCH_NAME` 里写的名字。等价的专用命令是 `sfly agent credentials issue workbench --token-only`（只把原值写到标准输出）。
4. 起助手和工作台：`docker compose --profile assistant up -d`。第一次启动工作台时它从控制面装 Agent、uv 和 sfly 命令行，要一两分钟（下面「工作台容器」）。
5. **登记工作台**：工作台在 Agent 页上在线（它用自己的 Agent 凭据连上来过）之后，项目管理员登记它（控制面里没有指名工作台的环境变量，不登记就是「助手」页写「没有登记工作台」）：

   ```sh
   sfly api PUT /projects/default/workbench --body '{"agent": "workbench"}'
   ```

   `workbench` 换成工作台那台 Agent 的名字。**登记之后控制面只接受 Agent 凭据，共享令牌（`SFLY_AGENT_TOKEN`）和不带凭据的连接都被拒绝**，对整个部署生效、不只这个项目；条件、被拒绝时怎么办见下面「登记工作台」。
6. 确认：`docker compose --profile assistant ps` 里三个服务都在；控制台的 Agent 页上 `workbench` 在线、「与控制面一致」是「是」；「助手」页顶上的就绪状态是可以用（没有就绪时它写明缺什么：模型没配、没有登记工作台、工作台不在线……）。

**登记工作台**（`PUT /projects/<项目>/workbench`，请求体 `{"agent": "<Agent 的名字>"}`，项目管理员；用 `sfly login` 登录的个人令牌或控制台的登录，项目令牌、会话令牌不行）：

- **条件**（任何一条不满足就是 409，不改任何东西，响应的 `error.code` 说是哪条）：
  - 这台 Agent 在这个项目里，而且**用自己的 Agent 凭据连上来过**（最近一次连接用的是 Agent 凭据）、没有被停用：`workbench_agent_unknown`（没有这台 Agent，或它在别的项目里：说法一样）、`workbench_agent_not_on_credential`、`workbench_agent_disabled`；
  - **部署里没有停用的 Agent 都已经换成 Agent 凭据**：`agents_not_on_credentials`，`error.details.agents` 列出还没换的 Agent 的名字。「换了」按每台 Agent **最近一次连接用的是不是 Agent 凭据**算：只签发过凭据、没用它连上来过的不算换了（要换进它的 `agent.env`、重启，连上来之后才算）；停用的 Agent 不算。
- **被拒绝时怎么办**：对列出的每一台，二选一，然后再登记一次：① 给它换成 Agent 凭据（`sfly agent credentials issue <名字> --token-only` 签发，写进那台机器的 `agent.env` 里的 `SFLY_TOKEN`（`.env` 不是它的配置），重启 Agent，到 Agent 页上看它「最近一次连接用的是 Agent 凭据」；换法见用户文档「安装 Agent」的「Agent 凭据」）；② 不用它了就停用（`sfly api POST /agents/<名字>/disable`），停用的不挡登记，停用的 Agent 连不上也不派发。
- **登记之后，各种连接的去留**：带 Agent 凭据的 Agent 照常；**共享令牌的连接和不带凭据的连接都被拒绝**（包括以前能连上的、已经登记过的名字），Agent 不退出，标准错误里写着「控制面已经登记了工作台，只接受 Agent 凭据」，换上 Agent 凭据之后它自己连上；已经连着的带 Agent 凭据的连接不受影响。登记不会断开任何已经连着的连接（条件保证登记那一刻没有以旧方式连着的 Agent）；检查和登记在引擎的锁里一起做，和连接的登记互斥，所以登记的那一刻一台旧方式的 Agent 同时连上来，要么登记被拒绝并列出它，要么它被拒绝。这个开关由库里是不是有项目登记了工作台得出，控制面重启之后照旧。
- **换一台工作台**：用另一台 Agent 再登记一次（同样的条件）；响应里的 `previous_agent` 是换下来的。登记同一台是幂等的。**没有注销登记的接口**：共享令牌不再接受是有意的单向开关（注销等于重新打开共享令牌的口子）。确实要退回登记之前（例如要退回旧版本的控制面），停掉控制面，在库里 `update projects set workbench_agent = null`，再启动。
- **名字被占用时**：Agent 带着有效的 Agent 凭据却被拒绝，说「这个名字已经被这个部署里另一个项目的 Agent 登记了」：过渡期里用共享令牌或不带凭据连上来的 Agent 都登记在默认项目里，一个名字在整个部署里只能属于一个项目。没有删除 Agent 的接口（停用不释放名字），所以给这台 Agent 换一个名字：用新名字签发凭据，把 `agent.env` 里的 `SFLY_AGENT_NAME` 和 `SFLY_TOKEN` 换成新的，重启 Agent。

**工作台容器**（`deploy/workbench/`）：

- **Agent 不烤进镜像**，来自控制面：入口脚本（`entrypoint.sh`，开头的注释写全了约定）从控制面（compose 里的服务名 `http://sfly:8080`）下载 `install.sh`，按用户文档「安装 Agent」的 `--dev` 方式装好（Agent、uv、sfly 命令行，版本和控制面一致），然后前台启动 Agent。Agent 之后自己自更新（ADR 0014），**`sfly` 命令行不会**（它钉在装时的版本），所以每次启动入口脚本还要对一下控制面的 `install.sh`，变了就重装（下面「已经装好」）。所以镜像只在操作系统工具变化时才不同。
- **`SFLY_PUBLIC_URL` 写浏览器看到的地址，工作台容器也要连得到它。** 它同时决定登录 Cookie 的跨站检查（见下面「登录与反向代理」：从别的地址打开控制台，写请求会被当成没有登录）和 `/install.sh` 里写给 Agent 的控制面地址、网关地址（`SFLY_PUBLIC_GRPC_URL`，不设时取同一个主机的 50051）。**不要为了让工作台连得上把它改成服务名 `http://sfly:8080`**：浏览器和飞书卡片里的链接都会指向打不开的地址。让工作台容器连得上这个地址，在 `docker-compose.override.yml` 里二选一：

  - 公开地址是 `http://<主机名>:8080`、网关是 50051（容器里的端口）：给 `sfly` 服务加一个和公开地址主机名相同的网络别名，容器里这个主机名就指到控制面容器：

    ```yaml
    services:
      sfly:
        networks:
          default:
            aliases: [sfly.example.com]   # SFLY_PUBLIC_URL 里的主机名
    ```

  - 公开地址经过宿主机上的反向代理（https、80、443……），或端口不是 8080 和 50051（宿主机映射的端口和容器里的不一样）：让工作台把这个主机名指到宿主机，连宿主机上发布出来的端口。**前提两条**：宿主机的防火墙放行从容器网段到这些端口的连接；反向代理监听的是所有地址，不只 `127.0.0.1`（容器是从宿主机的网桥地址连进来的）。公开地址写的是 IP 地址时通常什么都不用改（容器里本来就连得到）：

    ```yaml
    services:
      sfly-workbench:
        extra_hosts: ["sfly.example.com:host-gateway"]   # 主机名换成 SFLY_PUBLIC_URL 里的
    ```

  改了公开地址之后重启工作台容器（`docker compose --profile assistant restart sfly-workbench`）：入口脚本发现 `install.sh` 变了会重装，`agent.env` 里的地址随之更新。
- **已经装好、控制面也没变就不重装。** 入口脚本的判断（全部满足才算装好）：`~/.sfly/.workbench-installed`（第一行 `name=` 是这台 Agent 的名字，第二行 `install_sh_sha256=` 是装的时候那份 `install.sh` 的 sha256）、`~/.sfly/bin/sfly-agent`、`~/.sfly/agent.env`、`~/.local/bin/sfly` 都在。标记是安装脚本成功结束之后才写的，所以上次装到一半被打断（容器在下载或装 uv 的中途被停掉）时下次启动会重装，不会把半套当成装好；卷里留着的下载到一半的临时文件会先清掉。装好之后每次启动再用几秒的超时取一次控制面的 `install.sh`（它的内容只取决于控制面的版本和配置，不随请求变）：和标记里的 sha256 不一样（控制面升级了，或改了 `SFLY_PUBLIC_URL`、镜像）就重装（幂等，工作区和装好的节点包环境不动）；一样就直接启动；取不到（控制面连不上）也直接启动，不挡着已经装好的 Agent。**重装失败也不挡着**（升级时镜像暂时不通、离线缓存缺新版 `sfly` 命令行的依赖、切到要认证的镜像还没挂 `.netrc`）：这条分支不先删标记，失败时打印原因，`sfly-agent` 和 `agent.env` 还在就照常启动已有的 Agent，标记不动、`sfly` 命令行还是旧版本，下次启动再试；看启动日志里的「重新安装没有成功」，解决之后重启容器。要强制重装：`docker compose --profile assistant exec sfly-workbench rm /home/workbench/.sfly/.workbench-installed` 再重启容器；要从头来，删掉 `sfly-workbench-home` 卷。
- **删掉容器再建，工作区和环境都在**：家目录（里面有 `~/.sfly` 的 Agent、共享 venv、任务目录，`~/.local`、`~/.cache` 里的 uv 和 sfly 命令行）和 `/work` 都是命名卷；`docker compose --profile assistant rm -sf sfly-workbench` 之后再 `up -d`，Agent 不重装、已经装好的节点包环境还在。卷首次挂载时沿用镜像里的属主（uid 1000）；改成挂宿主机目录时要先 `chown -R 1000:1000` 它，写不了时入口脚本写明是哪个目录、怎么改，容器不会带着半个环境起来。
- **换工作台凭据**：只是轮换（没有怀疑泄露）：签发新的、改 `.env`、`docker compose --profile assistant up -d` 重建工作台；每次启动都把环境里的凭据交给 Agent（环境变量优先于 `agent.env`），不用重装。**凭据可能已经在工作台上泄露时（最常见的是模型把它读走了），只换凭据不够**：家目录卷里的 Agent 二进制、`~/.local/bin`、`agent.env` 都是模型写得了的，入口脚本下次启动会执行卷里的 Agent 二进制、把新凭据交给它，模型换掉的程序就拿到了新凭据。要这样做：① 吊销旧凭据（`sfly agent credentials revoke <名称> <凭据 id>`）；② `docker compose --profile assistant rm -sf sfly-workbench`，再删掉家目录卷 `sfly-workbench-home`（`docker volume rm <compose 项目名>_sfly-workbench-home`）；**`/work` 里的内容当作不可信**（脚本、`.git` 里的钩子和配置都可能被改过），要留的先审过再拷出来；③ 签发新凭据、改 `.env`、`up -d`：第一次启动重新从控制面装。
- **控制面升级之后**：`SFLY_VERSION` 改成新版本，`docker compose --profile assistant up -d`（三个服务的镜像标签都变了，都会重建）；工作台起来时发现控制面的 `install.sh` 变了，重装：Agent 二进制、`agent.env` 和 `sfly` 命令行换成新版本。**只升级了控制面、工作台容器没有重建时**（例如镜像标签用的是 `latest`），要自己重启它：`docker compose --profile assistant restart sfly-workbench`。不要省这一步：`sfly` 命令行和控制面版本不一致时会提示「重新运行 install.sh --dev」，工作台上的模型照做、又不带 `--name`，会向控制面注册一台新的开发 Agent、改掉 `agent.env`。
- **凭据**：`SFLY_WORKBENCH_TOKEN` 只传给工作台这一个服务（不进控制面和助手容器的环境，不写进镜像、不进日志）；入口脚本经环境变量 `SFLY_TOKEN`（不是命令行参数，`ps` 看不到）把它交给安装脚本和 Agent，并把自己的变量从环境里去掉；Agent 起的命令的环境里没有它。**但同一枚凭据还在这几处，工作台上的模型（同一个系统用户）都读得到**：`~/.sfly/agent.env`；Agent 进程的环境（`/proc/<Agent 的 pid>/environ`）；容器的 1 号进程（`docker-init`）的环境（`/proc/1/environ`：容器创建时的环境，里面一直有 `SFLY_WORKBENCH_TOKEN`，入口脚本去不掉）。这是 ADR 0029 的已知边界：凭据只对这一个名字有效，不能用来冒充别的 Agent；泄露了怎么办见上面「换工作台凭据」。入口脚本自己用的命令（`cat`、`curl`、`sh`……）只在系统目录里找，不会执行家目录里模型放的同名程序；**但这只管入口脚本自己，卷里的程序碰得到凭据**：`install.sh` 重装时在系统目录里找不到 `uv` 会用 `~/.local/bin/uv`（模型改标记就能逼出一次重装），它和卷里的 Agent 二进制一样在 exec Agent 之前执行、环境里有 `SFLY_TOKEN`。这是同一个已知边界：家目录卷里模型写得了的程序会拿到凭据，所以凭据可能泄露时要删卷（上面「换工作台凭据」）。
- **出网**：工作台现在出网不受限（出网名单是 #498）：模型的命令能访问工作台容器能访问到的一切网络，包括内网。控制面所在的网络里有不该被它碰到的东西时，现在要用网络本身（防火墙、单独的 Docker 网络）挡。

**离线部署**：先加载三个镜像附件（`gunzip -c sfly-server-X.Y.Z-linux-amd64.tar.gz | docker load`，助手和工作台同样）。工作台装 Agent、uv、Python 包走控制面下发的镜像（上面「镜像」一条的 `SFLY_PYPI_MIRROR`、`SFLY_GITHUB_RELEASE_MIRROR`，内网用共享目录做镜像时写 `file://` 地址），Agent 本身来自控制面镜像，所以工作台容器不需要出网，只要连得到控制面和镜像；助手容器里的 pi 用 `--offline` 启动、只启用读、写、编辑、命令四个工具，不会去下载 `rg`、`fd`。只有助手容器要连得到模型端点（见下面「助手的模型」）。

**镜像要认证时怎么配工作台**（私有索引、内网镜像站要用户名密码）：控制面不再把带凭据的镜像地址写进不用登录就能读的 `/install.sh`（#755），工作台上的安装脚本靠 `~/.netrc` 认证。工作台的家目录是卷，第一次启动时里面没有 `.netrc`：装 uv 和 `sfly` 命令行会 401、安装失败、容器反复重启。所以在 `docker-compose.override.yml` 里把一个 uid 1000 读得到的 netrc 只读挂进去：

```yaml
services:
  sfly-workbench:
    volumes:
      - type: bind
        source: ./workbench.netrc   # 宿主机上的文件：属主 uid 1000、权限 600（chown 1000:1000 workbench.netrc && chmod 600 workbench.netrc）
        target: /home/workbench/.netrc
        read_only: true
```

文件里每个镜像主机一段：`machine <镜像主机>`、`login <用户名>`、`password <密码>`（PyPI 镜像和 GitHub Release 镜像不在同一台主机时各写一段）。**这个文件工作台上的模型读得到**；控制面的镜像地址带用户名密码时，Agent 握手拿到的是带凭据的原值，装节点包依赖时 `uv` 的 `--default-index` 参数里就是它，`ps` 看得到（`agent/src/install.rs`；Agent 写进日志的地址里是 `***`，但进程参数里是原值）。两种配法凭据都在模型够得着的地方：**给工作台单独一个只读、最小权限的镜像账号，不要用别处也在用的账号**。

**助手容器的内存**：助手服务同时最多 8 个 pi 进程（`apps/assistant/src/sessions.ts` 的 `MAX_PROCESSES`，到了上限先关掉最久没用的空闲进程），容器上限 2 GiB（compose 的 `mem_limit: 2g`）。数字按完整会话算：8 个进程 × 约 194 MiB（一个 pi 进程跑完整的一个会话，峰值 191–194 MiB，量的是 `VmHWM`）≈ 1.55 GiB，加上助手服务自己和读写，上限留出约 0.45 GiB 的余量。**这是用假的模型端点量到的下限，不是真实模型的数**：真实模型的上下文更长，每个进程的峰值只会更高；用很短的一轮（探针）量到的每个进程只有约 141 MiB（空闲常驻）到 162 MiB（一轮峰值），也不要拿它定上限。内存紧、会话多时，容器可能被内核杀掉（Docker 按 `restart` 策略重启它，正在做的一轮中断）：这时在 `docker-compose.override.yml` 里调大 `sfly-assistant` 的 `mem_limit`，上线之前用真实模型和真实长度的会话量一次。

### 助手的模型

助手（ADR 0027）用的模型和它的密钥只放在**助手容器**里：模型的四个工具都在工作台上执行，够不着助手容器，所以密钥不需要经过工作台，工作台也不需要连得到模型端点。**离线部署时只有助手容器要连得到模型端点**（内网的模型网关，或离线的模型服务）；控制面、工作台、浏览器都不用。

- **模型文件**：给助手容器挂一份 pi 的 `models.json`（容器里的路径 `SFLY_ASSISTANT_MODELS`，默认 `/config/models.json`）。格式就是 pi 的，字段见 pi 文档的「Models Configuration」一页（[models-configuration.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md)，助手镜像里装的 pi 版本的同一页随包带在 `node_modules` 里）：内网的兼容端点常要按它验证过的差异开兼容开关（`compat`），所以不自己另定一套格式。下面的模板对应 `evals/assistant/models.example.json` 里内网档的那一项（`endpoint` 是 `baseUrl`，`model` 是 `id`），不含任何供应商的名字：

  ```json
  {
    "providers": {
      "gateway": {
        "name": "内网模型网关",
        "baseUrl": "https://llm-gateway.internal/v1",
        "api": "openai-completions",
        "apiKey": "$MODEL_API_KEY",
        "models": [
          {
            "id": "<模型 id>",
            "name": "<显示名>",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 131072,
            "maxTokens": 16384,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
  ```

- **密钥用环境变量引用，不写进文件**：`apiKey`、`headers` 的值里写 `"$变量名"` 或 `"${变量名}"`（可以夹在文字里，`"Bearer $MODEL_API_KEY"`），值由助手容器的环境变量给出（`docker run -e MODEL_API_KEY`、compose 的 `environment`，不要把值写在命令行或镜像里）；助手服务只把模型文件引用到的变量交给 pi，别的环境（含共享密钥 `SFLY_ASSISTANT_SECRET`）都不给。不支持 `"!命令"` 的写法。密钥的值不会出现在会话事件、日志、`/health` 和接口的响应里。
- **`SFLY_ASSISTANT_MODEL`**：用文件里的哪个模型，写成 `<提供方>/<模型 id>`，和文件里 `providers` 下的名字、`models` 里的 `id` 对上，例如 `gateway/<模型 id>`；末尾可以带思考强度（`:high`）。页面上没有选择，一个部署一个模型。
- **配得对不对在页面上看得到**：助手服务**不会因为模型没配好而拒绝启动**，而是照常起来，`GET /health` 的 `model.configured` 为 false，`reason` 写明缺的是哪一项（模型文件不在或读不了、不是合法的 JSON、有不支持的写法、`SFLY_ASSISTANT_MODEL` 没设或不在文件里、选中的提供方引用的环境变量没有值）：只写变量名和文件路径，不写任何值（变量名只在像常见的环境变量名——大写字母、数字、下划线——时才写；名字不像的，多半是把密钥本身写在了 `$` 后面，这时只写它在文件里的位置并提示）。引用 `SFLY_ASSISTANT_` 开头的变量（助手服务自己的配置）也算没配好：启动 pi 时不会交给它，换个名字。页面「助手」顶上的就绪状态写「没有配置模型：<缺什么>」，「开始」不可用；改好文件之后不用重启（环境变量要重启容器）。共享密钥太短（少于 32 个字符）仍然拒绝启动。
- **试连**：助手服务启动时和之后每 5 分钟（上一次连不上时每 30 秒，连上了再回到 5 分钟）对模型端点（`baseUrl` 的主机和端口）建一次连接，https 含 TLS 握手，**只建连接，不发请求、不调模型、不花钱**；`/health` 报连得上还是连不上、上次检查的时间和端点的主机端口（不带路径和参数）。连不上时就绪状态写「连不上模型端点 主机:端口：<原因>（上次检查：N 分钟前）」，新的一轮开始之前被拒绝（503 `model_unavailable`）。证书照默认规则验（pi 调模型时也一样）：验不过时试连失败，原因写「证书验不过」。
- **模型出故障时**：一轮里模型报错，pi 自己重试（时间线写「模型暂时不可用（429 被限流），正在第 2/3 次重试，4 秒后」），重试用尽或不该重试的错误（密钥被拒绝、额度不足）这一轮以「模型不可用」结束，原因写类别和状态码（上游的错误原文不进事件，只进助手服务的日志，打过码），已经做的步骤和工作区的改动还在。
- **助手容器的内存**：控制面和助手服务断线时，助手服务在内存里留着断线期间的持久事件，好在重连后补给控制面（#545）：最多 1 万条、合计不超过 64 MiB（按序列化后的字节算），超过就从最早的丢，丢到补不全时重连的 `hello.gap` 为真、控制面在做的会话记一条「事件缺失」的提示。除此之外是 pi 进程的内存（每个在做的会话一个）：给容器的内存上限按「64 MiB + 同时在做的会话数 × 一个 pi 进程」留余量（评测环境用 2 GiB）。

## 约定

- 主分支：`main`，受保护，只能经 PR 以 squash 方式合入；`dev` 是路线图的集成分支，规则相同，路线图的 PR 以它为目标；分支命名、PR、`dev` 与发版规范见 [docs/agents/branching-and-release.md](./docs/agents/branching-and-release.md)
- 提交信息使用祈使句，简洁说明改动意图
