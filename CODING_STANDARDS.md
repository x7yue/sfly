# 编码规范

代码审查逐条检查本文。这里只放需要判断的规则；能机械检查的写进 lint 或测试（biome、ruff、clippy、`biome-plugins/`）。
`biome-plugins/` 的每个规则配一组「应该命中」和「不应命中」的样例（`biome-plugins/fixtures/`），由 `apps/server/test/biome-plugins.test.ts` 检查：规则匹配的写法改了名，测试会失败，而不是规则静默地不再拦任何东西。

其他规范来源，审查时一并对照：

- `GLOSSARY.md`：术语。
- `docs/DESIGN-SYSTEM.md`：界面、样式与文案。
- `docs/guide/sdk-reference.md`：节点代码的写法（sfly-std 是范例，同样适用）。
- `docs/SEMANTICS.md`：调度与状态语义。

对照这几份靠判断：它们写的是语义和界面规则，要读懂改动才能对照；其中能机械查的（secret 的旧说法）已在 `pnpm lint:docs`。

## 测试

- **异步结果在等待条件里断言。** 触发异步动作（发消息、派发、取消、杀进程、写库）之后，要断言的状态放进等待条件，
  等它落定再继续：TS 用 `test/support/eventually.ts`，Agent 测试用 `wait_until`/`wait_for`，Python 用文件里的 `wait_for`。
  - 不在动作之后立即断言。靠判断：静态看不出前一个调用是不是异步动作。
  - 不先 sleep 固定时长再断言。e2e 里的 `waitForTimeout` 由 `biome-plugins/e2e-fixed-wait.grit` 拦下；确实只能等一段时间、确认某件事没有发生时，
    在它上一行写 `// biome-ignore lint/plugin/e2e-fixed-wait: <原因>`。
  - 耗时只作超时上限，不作断言区间（例如 `0.45 <= elapsed < 2`）。靠判断：耗时的写法不固定（`elapsed`、两次取时间相减……），lint 查不全。

  这类写法在 CI 的 2 核 runner 和本机高负载时会偶发失败（#108、#129、#136）。
- **断言路径时用真实路径。** 命令行和被测代码输出的是 resolve 过的路径，临时目录经过符号链接（macOS 的 `/tmp`、`/var`）时和 `tmpdir()` 不同：
  建临时目录后 `realpath` 一次，再拿它拼路径。
- **端到端里量尺寸、位置、字号时，读实际值，不比屏幕像素，也不等界面上四舍五入过的数字。** 读生成它的值（例如画布的 `--canvas-zoom`），
  或比较相对某个元素的倍数。屏幕像素受缩放、字体渲染和舍入影响，在不同机器与 CI 上会差一点。
  靠判断：断言比的是生成它的值还是屏幕像素，要看语义。
- **测试只碰自己建的东西**：临时目录、端口、数据库、git 仓库。靠判断：资源是谁建的要看它从哪来。
  - 测试里启动 git 子进程时去掉继承来的 `GIT_*` 变量。靠判断：起 git 的测试只有十来个文件，不值得为它写 lint。
  - 不依赖 GNU coreutils 的特有行为：CI 的 Ubuntu 用 Rust 版 coreutils，复制改名后的系统命令会拒绝运行。
    靠判断：GNU 特有的行为列不全；违反时测试在 CI 上失败。
- **修偶发失败的 PR 写明加压复现**：修复前在加压下失败几次，修复后跑多少次全部通过（`pnpm test:stress`，e2e 用 `pnpm test:e2e:stress`，macOS 上它在 Docker 里运行）。
  不能只靠调大超时；确实要调时，写明原来的超时为什么不合理。靠判断：这些写在 PR 描述里，超时合不合理要人看。
- **PR 里新增或改动的 e2e spec 在 CI 里会重复运行几次**（`pnpm test:e2e:changed`）：那一步失败说明用例不稳定，不要重跑碰运气；
  本地用 `pnpm test:e2e:stress $(bash scripts/e2e-changed.sh --list)` 复现。不重跑靠判断：重跑是人在 GitHub 上的操作。

## 数据库

- **事务回调里只用事务对象。** 不另从连接池取连接（`this.deps.db`、`deps.db`），读写都走事务对象（`tx`），包括事务里调用的函数：
  这类函数的数据库参数写成 `Db | Tx`，由调用方明写传 `tx` 还是连接池；不要在工厂函数里把连接池存进闭包，让函数自己去取（#380 的预检就是这样）。
  回调里直接写出的 `deps.db`、`this.deps.db` 由 `biome-plugins/tx-callback-pool.grit` 拦下；经过一层函数调用之后拦不住，靠上面的参数写法。
- **同一个事务里一条接一条地读，不用 `Promise.all` 并发查询。** 要读几样东西就依次 `await`，缓存读到的值，不缓存 Promise。
  缓存的是不是 Promise 靠判断：要看数据流。

  事务持有行锁，连接池里其余的连接可能正在等这把锁：事务再去连接池取连接，或者在同一个连接上并发查询（pg 会排队并打弃用警告，
  pg@9 不再支持），会和等锁的写入互相等死。#354 的验收复现过（连接池只有 10 个连接，十个并发写入就卡住）。
  测试用只有一个连接的连接池（`apps/server/test/support/single-connection.ts`），断言同一个连接上同时在等结果的查询不超过一条。

- **迁移日志按编号严格递增。** drizzle 按 `apps/server/drizzle/meta/_journal.json` 里每条的 `when` 决定要不要执行一个迁移（只执行比库里
  最后一个已执行迁移新的），比的不是编号。几个 PR 同时加迁移、后合入的一方重新排号时，除了改编号和文件名，还要把 `when` 改得比前一条大：
  否则这个迁移在已经执行过前一条的库上被静默跳过，CI 从空库开始抓不到；快照还要接在前一条快照的后面（`prevId`），否则下一次
  `db:generate` 拿错的基准算差异。后合入的一方合并 `dev` 之后重新排号：删掉自己的迁移（SQL 文件、快照和日志里那一条），运行
  `pnpm --filter @sfly/server db:generate --name <描述>` 重新生成，编号、`when`（当前时间）和快照的衔接就都是新的。
  **迁移里有手写的语句时**（种子数据、回填、带默认值加列再去掉默认值等），重新生成只会得到按表结构推出来的语句：把新生成的 SQL 换回原来
  手写的那份，日志和快照用新生成的。改完再运行一次 `db:generate`，应当提示没有变化（No schema changes），然后运行 `pnpm lint:migrations`。
  换回手写的 SQL 靠判断：检查不知道原来手写过什么。
  `scripts/check_migrations.py`（`pnpm lint:migrations`，推送前钩子和 CI 都跑）检查条目按编号排、`when` 严格递增、编号连续、每一条有
  SQL 文件和快照、没有多余的文件、快照的 `prevId` 接成一条链，报错写明哪两条不对、怎么改；
  `apps/server/test/migration-upgrade.test.ts` 先迁到倒数第二个、再执行全部，确认最后一个被执行了。

## 日志与错误

- **控制面往终端写东西只走 `apps/server/src/util/output.ts`**（`printError`、`printWarning`、`printInfo`、`writeStdout`；给操作者看的一行说明用 `describeError`）。错误一律先过 `safeError`，数据库错误里的查询参数（密码的哈希、令牌的哈希、secret 参数的值、飞书 Webhook 的地址）不会进日志。`apps/server/src` 里直接碰 `console`、`process.stdout`、`process.stderr` 的写法由 lint 规则 `no-direct-output` 拦，**这条规则是方便，不是保证**：它认的是规则文件开头清单里的写法（每一种有名字、有样例），清单之外的不保证拦住（存进变量的 `process`、再导出、拼出来的名字……），靠审查。出口文件自己加函数要登记（`test/error-log.test.ts` 的 `REGISTERED`，那条测试用同一条规则查出口文件的副本）。`printWarning`、`printInfo`、`writeStdout` 收字符串：不要把错误拼进去，要打印错误用 `printError`。错误拼进字符串之后类型和 lint 都认不出，靠审查。
- **助手服务往终端写东西只走 `apps/assistant/src/output.ts`**（`writeLog`、`printError`、`describeError`、`writeRawLog`；#693），同一条规则 `no-direct-output` 管着 `apps/assistant/src`。错误先过 `describeError`（只取 message，按形状打码、截到上限）；会话里的原文（上游的错误、工作台连接上的报错）先过 `sessions.ts` 的 `#forLog`（按这个会话的 secret 值打码）；哪段文字是会话原文要看来源，靠审查。出口文件自己加函数要登记（`apps/assistant/test/output.test.ts` 的 `REGISTERED`）。
- **Fastify 的日志（`app.log`、`request.log`）是另一条出口，错误一律用 `err` 这个键传**：`log.error({ err: error }, "说明")`，或者第一个参数就是错误。日志入口（`hooks.logMethod` 的 `sanitizeLogArgs`）会把所有参数里的错误去掉查询参数——别的键（`{ error }`）、后面的参数、嵌套的对象和数组里的也处理——但**不要把错误拼进字符串或先 `util.inspect` 再交给日志**：那时它已经是字符串，认不出来；**不要用 `log.child({ error })` 的绑定放错误**：绑定不经过日志入口，处理不到。**错误自己的属性里放着的错误**（`Object.assign(new Error("外层"), { original: 查询错误 })`）只在 `err` 键下（或第一个参数就是它）、而且直接放在属性上时才处理；`{ error: 外层 }`、`"%o"`、`printError("…", 外层)`、属性里套着数组或对象的都不处理：错误一律用 `err` 键直接传，不要把错误包进别的错误的属性里。这几种写法靠审查：拼接和嵌套的形状太多，lint 认不全。
- **新加的 lint 规则（`biome-plugins/*.grit`）如果有好几种拦的写法，给每一种起名字**（`$form = "名字"`，诊断以 `[名字]` 开头）并在 `hit/` 里各配至少一个样例：`biome-plugins.test.ts` 要求规则里的每个名字至少有一个样例命中它，规则里新加一种没配样例、或某个名字的样例全删了，测试会红（同一个名字下少几个样例它看不出来，所以名字分得细一点：写法不同就起不同的名字）。规则认的写法是一个封闭的清单，写在规则文件开头；清单之外的写法不保证拦住，规则是方便，不是保证。

## 文档

- **已接受的 ADR 是当时的决定记录，改名或换做法时不回头改它的正文。** 命令、接口、术语改名后，ADR 里的旧名照旧保留：读者要能看到当时决定的是什么。
  决定被推翻时写一份新的 ADR，在旧 ADR 末尾加一行指向它（例如「已被 ADR 0021 取代」；部分取代的写清是哪一部分）。新 ADR 写了「取代 / 推翻 / 修订 ADR 00NN」，而 ADR 00NN 末尾没有指向它的一行时，`pnpm lint:docs` 报错。现行的说明写在 `docs/ARCHITECTURE.md`、`docs/guide/` 和 GLOSSARY 里，这些随改名一起改。
- **文档里的路径、章节号、链接和手写的 HTTP 接口有 `pnpm lint:docs` 守着**（`scripts/check_doc_references.py`，接口那一类对照契约和助手服务的路由表，规则在 `scripts/doc_routes.py`，报错写明位置和改法；查什么、不查什么见脚本开头的说明）。动笔前要知道的是章节引用的写法：文档的仓库路径、空格、`§`、章节号，`docs/SEMANTICS.md §3.4`；一组沿用前面的文档（`docs/SEMANTICS.md §1.2、§2.4`），章节里的第几条写在后面（`docs/SEMANTICS.md §4 第 6 条`）；`docs/SEMANTICS.md`、`docs/ARCHITECTURE.md`、`docs/DESIGN-SYSTEM.md` 自己里面只写 `§` 加章节号。
  检查做不了、要人判断的：它只确认章节有标题，指没指对要人核对，改动、合并、拆分章节时用 `git grep -n 'docs/SEMANTICS.md §'` 找出引用它的注释一起改；顶层目录整个改名后，旧名开头的路径查不出。
- **secret 参数的旧说法（敏感、保密、机密）有 `pnpm lint:docs` 守着**（`scripts/check_terms.py`，只查这一个概念，词表写在脚本里，不读 GLOSSARY.md：GLOSSARY.md 里别的 `_Avoid_` 不查；要再守一个概念，在脚本的 `DEPRECATED` 里加一项并在 `scripts/tests/test_check_terms.py` 里加用例）。这个概念写 secret；`大小写不敏感` 这类固定搭配不算（列在脚本的 `INSENSITIVE_PHRASES`）；历史材料 `docs/adr/`、`docs/research/`、`docs/prototype/`、`docs/perf/` 不查；确实要写这几个词的（别的意思），在 `scripts/terms.allow` 加一行 `文件 | 原文 | 原因`，只放过原文里的那一处。其余的词按 GLOSSARY.md 写：界面文案、日志和错误信息、文档、注释和测试名都一样。
