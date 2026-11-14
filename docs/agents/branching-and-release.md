# 分支、PR 与发版

GitHub 上的规则集（`gh api repos/x7yue/sfly/rulesets`）强制执行下面带「强制」的条目；改动规则集时同步更新本文。

## `main`（强制）

- 只能经 PR 以 squash 方式合入，必须通过 CI 的 `check` 与 `e2e`；不能直接推送、强制推送或删除。
- 没有任何人可以绕过，包括代理：代理用的是维护者自己的 GitHub 身份，给维护者留的绕过权限代理也能用。
  紧急情况下由维护者在仓库设置里临时停用规则集 `main`，处理完立即恢复。
- 不要求 PR 基于最新的 `main`：合入后 `main` 上的 CI 仍会运行，发版前要求它通过。

## 分支命名

| 前缀 | 用途 |
|---|---|
| `spec/<issue>-<描述>` | 大功能的规格与实现 |
| `impl/<描述>` | 大功能拆出的实现分支 |
| `design/<描述>` | 设计文档、原型、ADR |
| `fix/<issue>-<描述>` | 修复缺陷 |
| `chore/<描述>` | 工具链、CI、开发环境、文档 |
| `release/X.Y.Z` | 只改版本号，为发版做准备 |

Cindy worktree 自动生成的 `cindy/<名字>` 分支，推送前改成上面的前缀：`git push -u origin HEAD:<前缀>/<描述>`。

## CI 什么时候运行

- PR（草稿也算）的每次推送、`main` 上的每个提交。分支上只推送、没有 PR 时不运行：要在合并前验证就开一个草稿 PR，
  或手动触发（`gh workflow run ci.yml --ref <分支>`）。
- PR 有新的推送时，上一次推送还没跑完的 CI 被取消；`main` 上每个提交的 CI 都跑完，连着合入几个 PR 也不会互相取消。
- 推送前的钩子（`.githooks/pre-push`）只跑版本号、生成代码、lint、类型检查；测试由 CI 负责，推送前想自己跑用 `pnpm test`。
- `check` 是汇总：`rust`、`py`、`ts`、`package` 四个 job 全部成功它才通过。规则集只认 `check` 与 `e2e` 这两个名字。
- CI 失败时先用 `pnpm ci:failures <运行 ID>` 看失败的测试和断言差异，不用下载完整日志。

## PR

- 标题用祈使句：squash 合入后它就是 `main` 上的提交标题（GitHub 自动追加 ` (#编号)`），各提交的信息成为正文。
- 加上分类标签，Release 说明按它分组（`.github/release.yml`）：`enhancement` 新功能、`bug` 修复、`documentation` 文档；其余归入「其他」。
- 让 API 客户端生成的类型（`packages/client/src/generated/`）出现不兼容变化的 PR，另加标签 `breaking-change`，并在描述里写明变了什么、自建页面要怎么改。Release 说明把带这个标签的 PR 放在最前面的「API 客户端的不兼容变化」里：1.0 之前不保证跨版本兼容（ADR 0022），用户要在升级前知道要改什么。
  - 不兼容的变化：删除或改名领域、方法、字段、事件；请求里新增必填的字段，或者可选的字段变成必填；字段的类型变了，或者响应里的枚举多了值（页面里穷举它的代码要跟着改）；响应里去掉字段，或者字段从总有值变成可能为空。只新增方法、可选的请求字段或响应字段不算。
  - 生成的类型提交在仓库里，看 PR 的 diff 里 `packages/client/src/generated/` 的变化来判断。
- 用 `gh pr merge <编号> --auto --squash` 合入：CI 通过后自动合入并删除分支，不用守着 CI。

### 关键路径的改动要贴 `pnpm perf` 结果

性能测试不进 CI（ARCHITECTURE §7.6），所以改动下面这些关键路径的 PR，由作者在本地运行 `pnpm perf`（约 10 分钟），
把报告的结论、总览和「与发版基线相比变化超过 20% 的数值」贴进 PR 描述。报告在本机结果目录
（默认 `~/.local/share/sfly/perf/<时间>/report.md`，命令结束时打印路径），每份报告同时与两份基准对比：
本机上一次（任何 worktree 里跑的都算），以及仓库里 `docs/perf/` 下最近一个版本的发版报告（发版基线）。

| 关键路径 | 主要位置 |
|---|---|
| Agent 日志转发 | `agent/src/logs.rs`（stdout/stderr 与事件管道合并、分批发往控制面、日志副本轮换、断线排队） |
| 事件通道（SDK → Agent，ADR 0015） | SDK 的 `ctx.metric()` / `ctx.log` / 进度写入（`sdk/python/src/sfly/context.py`）、`events.fifo` 的创建与读取（`agent/src/executor.rs`、`agent/src/logs.rs`） |
| 指标合并 | `agent/src/metrics.rs`（按「指标 × 秒」合并、断线排队与丢弃计数） |
| 控制面指标写入与查询（ADR 0009） | `apps/server/src/metrics/`（分段写入、摘要、降采样查询、保留期）及其表结构 |

- 与发版基线的变化包含上次发版以来所有已合入的改动。要分清哪些来自这个 PR，在改动前（例如 `main` 上）先跑一次，
  再看改动后与本机上一次的对比。
- 发版基线是在发版那台机器上跑的：换了机器时报告里写明「不是同一台机器跑的，不对比」，这时按上一条在改动前后各跑一次，
  贴与本机上一次的对比，并说明发版基线为什么没有对比。
- 硬性断言不满足（结论「不通过」）说明有 bug，修好再合入；变差超过 20% 的数值在描述里说明原因。
  机器负载会让吞吐、延迟、CPU 波动，这类数值只有明显变差、复跑仍然如此时才需要处理。
- 只改了其中一段时可以先用 `pnpm perf --only <项>` 排查（`pnpm perf --list` 列出各项），贴进 PR 的是完整一次的报告。
- 长时负载测试 `pnpm perf:soak`（默认 1 小时，`--duration` 指定）只在维护者要求时运行，同样贴报告。

### 专项测量

为做决定而做的测量（比较两种实现、找瓶颈、验证一个假设），不属于 `pnpm perf` 的固定项目，按下面的规则留存，
让以后的人找得到、看得懂、能复现：

- 完整报告贴在对应 issue 或 PR 的评论里：数值、测量方法、机器（CPU、内存、系统）、提交号、样本量（轮数、每轮次数、时长）。
- 调研文档（`docs/research/`）只写结论与关键数值，链接到那条评论。
- 以后还要用的测量脚本整理成 `pnpm perf` 的一项（`apps/server/perf/items/`，ARCHITECTURE §7.6）；一次性的脚本不进仓库，
  但报告里写清楚怎么测的（命令、参数、负载），别人照着能重做。
- 测量的中间文件和结果不放 `/tmp`（小、重启即清，还会挤满）：放在本机的固定目录，例如 `pnpm perf` 的本机结果目录
  `~/.local/share/sfly/perf/` 旁边自建子目录；也不要只留在会被清理的 worktree 里。

## 发版

1. 从 `main` 新建 `release/X.Y.Z`，运行 `pnpm release:version set X.Y.Z`，提交并开 PR。
2. 在这个分支上、提交好之后运行 `pnpm perf --release`（必跑，约 10 分钟：release 构建的 Agent、打包后的控制面与本机
   PostgreSQL，ARCHITECTURE §7.6）。它与 `pnpm perf` 相同，只是通过后再把报告存进 `docs/perf/X.Y.Z/report.{json,md}`；
   有未提交的改动、被中断或结论不通过（硬性断言不满足或某项出错）时不存，命令以退出码 1 结束并说明原因。
   不通过时不发版，先修复后重跑。把 `docs/perf/X.Y.Z/` 提交进发版 PR；描述里只贴结论和变化（与发版基线——上一个版本的
   报告——相比变化超过 20% 的数值，变差的说明原因或确认是机器波动），不贴整份报告。确认后合入。
   维护者要求跑长时负载测试时，用 `pnpm perf:soak --release`，存为同一目录下的 `soak.{json,md}`。
3. 等 `main` 上这个提交的 CI 通过，在它上面打 tag 并推送：`git tag vX.Y.Z <提交> && git push origin vX.Y.Z`。
4. `.github/workflows/release.yml` 接手：校验版本号、确认提交在 `main` 上且 CI 已通过，构建并发布（产物见 README「发布」）。
   Release 说明里的变更列表从上一个平台版本起算（见下文「变更列表的起点」）。

- 版本号：0.x 阶段新功能升次版本号，修复升补丁版本号；只支持 `X.Y.Z`（ADR 0010）。
- 只发布 `main` 上的提交，不维护旧版本的修复分支：有问题就修复后发新的补丁版本。
- `v*` tag 推送后不能更新或删除（强制），Release 发布后附件与 tag 都不能修改（Immutable releases）。发错版本时，发一个新的补丁版本。

## 发布 sfly-std

标准节点包 `sfly-std`（`std/`，ADR 0017）的版本号独立于平台，写在 `std/pyproject.toml` 的 `[project].version`，不受
`pnpm release:version` 管理。

1. 从 `main` 新建 `release/std-X.Y.Z`，改 `std/pyproject.toml` 的版本号（用到新版 SDK 的接口时同时调高
   `[tool.sfly] requires-sdk`，用到新的 Agent 能力时同时调高 `requires-agent`），`uv lock` 后提交并开 PR 合入。
2. 等 `main` 上这个提交的 CI 通过，打 tag 并推送：`git tag std-vX.Y.Z <提交> && git push origin std-vX.Y.Z`。
3. `.github/workflows/std-release.yml` 接手：确认提交在 `main` 上且 CI 已通过，运行 `scripts/release/std.sh pack`
   （tag 与版本号一致、节点包元信息检查、构建 `.sflypkg`、`SHA256SUMS` 和含最低 Agent 版本的发布说明），上传到草稿 Release
   后发布。不标为 Latest，不推镜像，不自动登记到控制面。发布说明后面附上与上一个 `std-vX.Y.Z` 相比的变更列表，
   首次发布不附。

- 发布前在本地 dry-run：`bash scripts/release/std.sh pack std-vX.Y.Z`，产物在 `out/std/`，与 Release 附件相同，只是不上传。
- 与平台一样只支持 `X.Y.Z`，发布后不可修改；发错时发新的补丁版本。

## 变更列表的起点

平台（`vX.Y.Z`）与 sfly-std（`std-vX.Y.Z`）的 tag 在同一个仓库里，版本号各自独立。GitHub 自动生成变更列表时自己挑上一个
tag，可能跨系列选到另一边的，所以两个工作流都显式指定起点：上一个 Release——已发布（非草稿、非预发布）、同一前缀的
`X.Y.Z` 里按语义版本比当前小的最大者（`v0.0.10` 的起点是 `v0.0.9`，不会是 `std-v0.1.0`），没有时（首次发布）不附起点。
只看已发布的 Release 而不是所有 tag：tag 推送后不能删除，发版失败被放弃的 tag 不能当起点，否则那段改动不会出现在任何
已发布 Release 的说明里。与「跨版本自更新测试」的「上一个 Release」是同一个定义，选择逻辑都在 `scripts/release/previous-tag.sh`
（从标准输入读候选 tag）。

- 发版前在本地确认起点（sfly-std 传 `std-vX.Y.Z`），工作流的日志里也会打印「变更列表起点」：

  ```sh
  gh release list --exclude-drafts --exclude-pre-releases --limit 1000 --json tagName --jq '.[].tagName' |
    bash scripts/release/previous-tag.sh vX.Y.Z
  ```

- 测试在 `scripts/tests/test_previous_tag.py`（`pnpm test:py` 运行），喂候选 tag 列表验证选出的起点。

## 跨版本自更新测试

Agent 只跟随控制面的版本（ADR 0014）：升级控制面后，旧 Agent 要在新控制面上把手上的任务跑完，再自更新到新版本。
所以相邻两个版本之间的会话协议（Hello、心跳、日志、结果与 Ack、Welcome 里的更新字段）必须兼容，由 CI 保证：

- `pnpm fetch:previous-agent`（CI 的 Previous release agent 步骤）从 GitHub Release 下载「上一个 Release」——已发布的
  `vX.Y.Z` 里低于当前版本号的最高版本——的 Agent 和同版本的 SDK wheel，按 `SHA256SUMS` 校验。只用 Release 附件，不用 Actions Artifacts（ADR 0010）。
  发版前把版本号改成 X.Y.Z 之后，测试的就是「上一个发布版本的 Agent 能否升级到 X.Y.Z」。
- `pnpm test:bundle` 的 `bundle-self-update.test.ts`：旧 Agent 装在 `$SFLY_HOME/bin`，先连上以上一个版本号启动的控制面、
  接到一个闸门任务；任务运行中换成当前打包的控制面（同一个数据库和端口），验证 Agent 重连后下载新二进制、上报「等待任务结束」，
  任务结束、结果被 Ack 后替换自己并 execve（进程号不变），以当前版本握手并照常接新任务。
- 上一个 Release 的 Agent 还不支持自更新（二进制不认识 `--no-auto-update`）或没有更旧的 Release 时，测试标为跳过，
  原因写在输出里。第一个带自更新的版本没有可比较的旧版本，从它的下一个版本起生效。
- 本地验证全流程：`pnpm bundle:server && pnpm fetch:previous-agent --simulate && pnpm test:bundle`（用当前打包的 Agent
  加隐藏的版本覆盖参数扮演版本 0.0.0）。

失败时：先看卡在哪一步——旧 Agent 重连不上或报错、更新状态没有到「等待任务结束」、任务没有成功（例如被当成 `agent_lost`）、
替换后没有以当前版本握手。这说明当前控制面与已经部署出去的上一个版本的 Agent 不兼容，升级后那些 Agent 会掉线或丢任务：
修改当前代码，让它继续理解旧 Agent 的消息（proto 只做向后兼容的新增，新增的语义在旧 Agent 不发送时保持原样）。不要跳过或放宽
这项测试来发版，也不能靠修改已发布的 Release 修复（Release 不可变）。确实需要不兼容的改动时，先与维护者确认，并在 Release 说明里
写明老 Agent 要手动升级。`fetch:previous-agent` 本身失败（下载或校验不过）时查 `gh` 的登录、网络和那个 Release 的附件。
