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
| `pnpm release:version show \| check \| set X.Y.Z` | 查看 / 校验 / 修改版本号（Agent、SDK、API 客户端、控制面共用一个版本号） |

## 发布

推送 `vX.Y.Z` tag 后由 GitHub Actions（`.github/workflows/release.yml`，ADR 0010）发布：

1. 在 `release/X.Y.Z` 分支上运行 `pnpm release:version set X.Y.Z`，开 PR；在这个分支上运行 `pnpm perf --release`，把存进 `docs/perf/X.Y.Z/` 的报告提交进 PR，描述里贴结论与变化（不通过不发版）。合入 `main`，等 `main` 上的 CI 通过。
2. `git tag vX.Y.Z <main 上的提交> && git push origin vX.Y.Z`。
3. 工作流检查 tag 与版本号一致、`docs/perf/X.Y.Z/report.json` 已提交（没跑性能测试就发不出）、提交在 `main` 上且 CI 已通过，然后构建并发布：
   - 镜像 `ghcr.io/x7yue/sfly-server:X.Y.Z`（另有 `X.Y`、`latest` 标签，linux/amd64 与 linux/arm64）
   - Release 附件：Agent `sfly-agent-X.Y.Z-{x86_64,aarch64}-unknown-linux-musl.tar.gz`、离线镜像 `sfly-server-X.Y.Z-linux-{amd64,arm64}.tar.gz`、SDK `sfly-X.Y.Z-py3-none-any.whl`、`SHA256SUMS`

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
- 保留期、大小上限和登录的空闲期限（`SFLY_RETENTION_DAYS`、`SFLY_METRIC_RETENTION_DAYS`、`SFLY_LOG_LIMIT_MB`、`SFLY_ARTIFACT_LIMIT_MB`、`SFLY_METRIC_LIMIT_MB`、`SFLY_LOGIN_IDLE_HOURS`）在 `deploy/.env.example` 里写明了取值范围，docker compose 会把它们传给控制面：保留天数大于 0、最大 36500（约 100 年，**不想清理就填 36500**，没有别的「永不清理」的写法），大小上限换算成字节后在 1 到 2^53 − 1 之间，登录的空闲期限 2 分钟（写 0.0334 小时或更大）到 876000 小时。不是数、不是有限的数、超出范围的值在控制面启动时就报错退出（写明变量名、填的原文和范围，几个一起报），不会启动之后才悄悄出错。字符串类的也一样（#619）：`SFLY_PUBLIC_URL`（带协议和主机的 http 或 https 地址）、`SFLY_PUBLIC_GRPC_URL`、`DATABASE_URL`（`postgres://` 或 `postgresql://` 开头）、两个镜像（http 或 https 地址）、`SFLY_CORS_ORIGINS`、`SFLY_TRUST_PROXY`，以及要一起给的 `SFLY_ADMIN_LOGIN` 和 `SFLY_ADMIN_PASSWORD`，和数值类的一起检查、一次报完；报错里不出现密码、密钥和地址里的用户名密码（带 `@` 的值整个不回显，数据库地址一律不回显）。哪些变量启动时检查、哪些留给第一次用到见 `docs/ARCHITECTURE.md`「启动时检查哪些环境变量」。其余配置见 `apps/server/src/main.ts` 顶部注释。
- **升级前检查 `.env`**（这几个变量以前不在 `docker-compose.yml` 里，换上新的 compose 之后行为会变）：
  - **以前写了也不生效的，换上新的 compose 之后会生效（这一条最要紧）。** `SFLY_RETENTION_DAYS`、`SFLY_METRIC_RETENTION_DAYS`、`SFLY_LOG_LIMIT_MB`、`SFLY_ARTIFACT_LIMIT_MB`、`SFLY_METRIC_LIMIT_MB`、`SFLY_LOGIN_IDLE_HOURS` 以前不在 compose 的 `environment` 里，`.env` 里写了控制面也读不到，一直是默认值。例如 `.env` 里一直放着 `SFLY_RETENTION_DAYS=7`：升级之后保留期从 30 天变成 7 天，运行结束超过 7 天的日志和产物会被清理（不可恢复）。升级前先看一眼 `.env` 里有没有这几项、值是不是你现在想要的，不想要的删掉或留空。
  - **以前能启动、现在启动失败的写法**（按部署方式分开看）：
    - **用 compose 部署的**：这六个变量以前根本没传进容器（见上一条），所以 `.env` 里这六项现在不合法的**任何**写法（`10MB`、`30d`、`0`、`abc`、保留天数超过 36500、登录的空闲期限不到 2 分钟……）以前都能启动，升级后控制面启动失败。
    - **直接给进程设环境变量的**（`docker run -e`、从源码起）：以前能启动、现在失败的有——`Infinity`、`1e400`（保留天数、日志和指标的上限、登录的空闲期限都受影响；保留天数写 `Infinity` 正是以前「清理每分钟报错、悄悄不清理」的那种）；保留天数超过 36500（想「永不清理」而填了很大的数的，改填 36500；36501 到约 247 万这一段以前真的能用，效果就是不清理）；十六进制（`0x1E`）；日志和指标的上限换算成字节后不到 1 字节（`0.0000001`，以前上限就是 0 字节）或超过 2^53 − 1（`8589934592`、`1e300`：这两个上限以前不检查范围，只有产物的上限检查）；登录的空闲期限超过 876000 小时或不到 2 分钟；端口写成 `+8080`、`8080.0`、`1e3`、`0x1F90`、`-0`。（`10MB` 这种带单位的写法以前直接设环境变量就启动不了，不在这一类。）
    - **端口的空串**是行为变化，不是启动失败：以前读成 0（让系统随机选端口），现在用默认端口，仍然能启动。
    - **地址类的变量**（#619，compose 和直接设环境变量的都受影响）：`SFLY_PUBLIC_URL`、`SFLY_PUBLIC_GRPC_URL`、`SFLY_PYPI_MIRROR`、`SFLY_GITHUB_RELEASE_MIRROR` 以前原样往下传。没写协议（`sfly.internal:8080`、`mirrors.ustc.edu.cn/pypi/simple`）以前也能启动：对外地址残缺，Agent 拿到的下载地址和网关地址是坏的，镜像到 Agent 装依赖时才失败；现在启动时就报错。要写成 `http://` 或 `https://` 开头、有主机的地址；对外地址和网关地址另外不能带用户名密码、`?`、`#`，网关地址不能带路径。compose 会把 `SFLY_PUBLIC_URL` 和两个镜像传进容器，升级前看一眼 `.env` 里这几项的写法。协议写错（`http//sfly:8080`）以前是 HTTP 已经开始监听之后才带着堆栈崩溃，现在启动前就是一行说明。`SFLY_TRUST_PROXY`、`SFLY_CORS_ORIGINS`、`SFLY_ADMIN_LOGIN` 和 `SFLY_ADMIN_PASSWORD` 写错以前也是启动失败（带堆栈的未捕获错误），现在和别的一起、一次报完，没有堆栈。
    - compose 里 `.env` 的 `SFLY_HTTP_PORT`、`SFLY_GRPC_PORT` 只是宿主机端口的映射，控制面看不到，不受影响。
  - **启动失败时**：`restart: unless-stopped` 会让容器反复重启，页面和 Agent 一直连不上。看控制面的启动日志（`docker compose logs sfly`）：第一行是「sfly: 控制面没有启动，…」，写明是哪个变量、填的值和要求（带密码的值不回显），几个不合法的一次报完。改 `.env` 里对应的值，再 `docker compose up -d`。
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
- 连上控制面、收到 Welcome（带控制面配置的镜像）之后准备运行环境：
  - uv：没有 `--uv` 时使用 `$SFLY_HOME/bin/uv`，不存在时用 GitHub Release 镜像上 `astral-sh/uv/LatestRelease/uv-installer.sh` 安装到 `$SFLY_HOME/bin`（不修改 PATH；安装脚本需要 curl 或 wget，下载时带 `--user-agent` 的 User-Agent）。指定了 `--uv` 时 Agent 不管理 uv。
  - 共享 venv 不存在时用 `uv venv --python 3.13` 创建，Python 从 GitHub Release 镜像的 `astral-sh/python-build-standalone/` 下载；之后不主动升级 Python。`--python` 可以指定别的版本或解释器。
  - 环境准备失败（没有可用的 uv、安装 uv 失败、创建 venv 失败）时 Agent 以退出码 78 退出，标准错误打印失败的命令、完整输出和镜像地址（标明来自控制面还是本机覆盖），请把它报告给平台管理员。
- 随后若 venv 里的 SDK 运行时版本与 Agent 自身版本不一致，Agent 从控制面下载同版本的 wheel，校验 sha256 后用 `uv pip install` 安装；版本一致时不重装。控制面没有对应版本的 wheel 时保留现状并在日志里告警。
- 节点包依赖从控制面下发的 PyPI 镜像安装；Agent 上的 `--index-url` 优先。本机的 `--github-release-mirror`、`--python-install-mirror` 同样优先于下发的 GitHub Release 镜像和由它推导的 Python 下载镜像。

## 约定

- 主分支：`main`，受保护，只能经 PR 以 squash 方式合入；`dev` 是路线图的集成分支，规则相同，路线图的 PR 以它为目标；分支命名、PR、`dev` 与发版规范见 [docs/agents/branching-and-release.md](./docs/agents/branching-and-release.md)
- 提交信息使用祈使句，简洁说明改动意图
