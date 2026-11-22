# 标准节点包改成辅助函数加三个节点，不再提供一组现成的节点

标准节点包 `sfly-std`（ADR 0017）有 17 个节点：Shell 命令、后台进程启停、系统与进程监控、等待条件、跟随日志、收集产物、拉文件、HTTP 请求、断言。对目前唯一的真实使用方做的只读核对是：它的三个场景、33 个节点里，标准节点的使用次数全是 0，场景没有引用这个包。功能相近的东西它都有，但形态不同——跑脚本是业务节点共用的一个内部函数，监控是自己写的节点（原因之一：标准的进程监控在进程重启后会失败，它需要按名字重新找进程、接着监控，而标准节点的行为改不了），拉文件和保存产物是在业务节点里直接调用 Agent 的文件能力和产物接口。规律是：真实的节点是「业务阶段」，不是小步骤；标准节点提供的正是那种小步骤，而且行为固定。仓库里还有 6 个标准节点除了自己的单测和文档页之外没有任何引用。助手可以按需写节点（ADR 0027）之后，预先做好一批小步骤的价值更低：助手需要的是积木，不是成品。

决定：**标准节点包从「一组现成的节点」改成「节点代码里可以调用的辅助函数，加三个薄节点」，包名仍是 `sfly-std`。**

## 规则

- **辅助函数是主体。** 这些能力里难写对的是逻辑，不是节点的外壳：进程组的启动、停止和看护；采样整机与进程的资源并报成指标；跟随日志文件（轮转、截断、去重）；判断文件是否写完；经 Agent 能力从另一台机器拉文件；等待端口、文件、日志行。它们是公开、有文档、有类型标注、有单测、向后兼容的函数，业务节点直接导入、自己组合：`sfly_std.commands`（`run_command`）、`sfly_std.processes`（`start_background_process`、`stop_background_process`、`background_exit_status`、`find_processes`）、`sfly_std.resources`（`monitor_system`、`monitor_processes`）、`sfly_std.logs`（`LogFile`、`follow_log_file`、`wait_for_log_line`）、`sfly_std.waiting`（`poll_until`、`wait_for_port`、`wait_for_file`）、`sfly_std.agent_files`（`pull_files_from_agent`、`watch_agent_files`）。使用方当初绕开标准节点，是因为节点的行为改不了；函数可以传参数、传回调，正好对上「节点是业务阶段」的写法。
- **兼容性承诺。** 一台 Agent 的共享环境里只有一个 `sfly-std` 版本（ADR 0002），所有依赖它的节点包用的是同一份，所以公开的接口只做向后兼容的改动：各模块 `__all__` 里的函数和类，签名只增不减（新增的参数是带默认值的关键字参数），返回值（数据类）只增加字段，异常的类型名不变；要改变已有行为或不再兼容，就加一个新名字的函数，旧的继续保留。以下划线开头的模块和不在 `__all__` 里的名字是内部实现，不对外承诺。`std/tests/test_public_api.py` 守着这些约定：公开的函数都有文档字符串和完整的类型标注，有默认值的参数都在 `*` 之后，数据类是 frozen 的，包外没有引用下划线开头的模块；公开模块里不带下划线的函数和类都在 `__all__` 里；承诺的内容本身提交成快照 `std/tests/public_api.txt`（每个公开名字的参数名、种类、默认值、返回值、字段、基类），测试把当前的接口和它比对，改接口必须同时改快照，评审时一眼看得见，不兼容的改动（改名、删除、改默认值、改类型）在比对里单独标出。
- **承诺生效前一次定下来的写法**（之后只能加、不能改）：结果都是 frozen 数据类，不返回裸的数字，以后才能加字段；路径参数接受 `str` 或 `os.PathLike`，返回的路径是 `Path`（`BackgroundProcess.log_path` 直接交给 `ctx.artifacts.save`）；字段和参数的后缀各有一种意思：`*_path` 是本地路径，`*_artifact` 是产物的名称，`*_ref` 是产物的引用（下载地址，不是本地路径：本地调试时它恰好是路径，上了 Agent 才坏）；时间参数的名字读得出是时长（`refind_within`、`appear_within`），写成布尔值报错；`Literal` 类型的参数（`read_from`、`on_exit`）写错值报错，不当成默认值；同一类的两个路径参数（`directory`、`local_dir`）只能按关键字传；`ProcessFinder`、`ProcessTarget` 不公开（用户要的「按名字找进程」有 `find_processes`，以后公开是兼容的新增，公开了收不回来）；同一个概念一种写法（日志从哪里读都叫 `read_from`，`stable` 在等文件和监听文件里是同一个意思，`include_children` 默认都是 True：一个服务指的是主进程和它启动的全部子进程）；`SYSTEM_METRICS` 这类常量是元组。
- **同一个节点里多次调用不互相覆盖。** 节点时代一个任务只调用一次，写死的产物名和日志文件名没问题；业务节点会反复调用辅助函数（起数据库再起被测服务，压测前、压测中各采一段）。默认的名字每次调用不同：第一次用原来的名字（`stdout.txt`、`processes.csv`、`<节点 ID>.log`），之后依次加 `-2`、`-3`；调用方可以自己指定名字（`stdout_artifact`、`csv_artifact`、`log_path`），返回值里带着实际用的名字和路径；自己给的名字在命令启动之前就检查。节点仍然传原来的名字，行为不变。
- **在 `finally` 里清理要在平台的收尾时间内做完。** 取消或超时时平台发 SIGTERM，10 秒（Agent 的 `--terminate-grace`）后强制杀掉整棵进程树，节点自己也在其中：`stop_background_process` 的宽限期默认 5 秒（短于平台的收尾时间），任务已经被取消（`ctx.cancelled()`）时再压到最多 3 秒。超时没有取消标记，所以默认值本身就要够短；这些上限是每次调用的，不是整个收尾的预算，超时时每停一个忽略 SIGTERM 的服务要用掉约 `grace` 秒，在 `finally` 里停两个及以上服务时要把 `grace` 给小。需要更长宽限期的服务用单独的 always 节点（`stop_process`）停；Agent 超时时也写取消标记，让这里的上限对超时同样生效，是 Agent 一侧的另一项改动。
- **节点只留三个**，都是辅助函数上的薄封装：`shell`、`start_process`、`stop_process`。`shell` 是不写代码就能跑通第一条链的入门，也是临时看一眼被测机的办法；后两个是执行语义里规定的「跨节点存活的进程」的做法。三个节点的参数、输出、错误类型名和行为与 0.3.0 一致（已有测试原样通过）：节点模块里定义和 0.3.0 同名的异常子类，把辅助函数的异常换成它，所以失败信息里的类型名不变。
- **进程重启不再让监控失败。** `monitor_processes` 的 `refind_within` 参数：按名字或命令行指定的目标，进程退出后最多再等这么多秒让新的进程出现，出现了就接着监控，超过才按 `on_exit` 处理；按进程号指定的目标不能这样找（进程号是一次性的）。`process_monitor` 节点随其余节点一起删除，这条能力以函数的参数提供，有测试。
- **其余 14 个节点删除**：`system_monitor`、`process_monitor`、`wait_port`、`wait_file`、`wait_log_line`、`follow_log`、`collect_artifacts`、`pull_files`、`watch_files`、`http_request`、`assert`、`file_assert`、`process_assert`、`port_assert`。其中值得留下的写法进用户文档和节点开发的技能，作为「怎么用辅助函数写自己的节点」的示例（起服务、等就绪、采样资源、收集日志、停服务）。`assert` 不留：阈值写在业务节点自己的代码里，GLOSSARY「指标」一条里「阈值由断言节点给出」的说法相应改掉。
- **不并进 SDK，也不换包名。** 这些函数依赖 psutil（进程和资源），而 SDK 的运行时只能用标准库（ADR 0002），版本还跟着 Agent 走。它仍是一个独立发布的包，节点包把它声明成依赖，沿用 ADR 0017 的发布流程；不新起一个名字：少一个概念。
- **依赖。** 删掉 `http_request` 之后包里没有代码用 `httpx`，0.4.0 只依赖 `psutil`；要发 HTTP 请求的业务节点自己依赖 `httpx`（辅助函数 `poll_until` 配它做「重试到成功」），不让每个装了 sfly-std 的 Agent 都带上它。
- **版本。** 已发布的 0.3.0 不可变，锁定它的场景不受影响。新版本按语义版本升次版本号，发布说明写明删了哪些节点、各自怎么替换。依赖 `sfly-std` 的节点包在不能访问 PyPI 的环境里怎么装上它：由控制面自带的包索引提供 `sfly-std`（#556），不要求访问 PyPI。

## Considered Options

- **留 9 个**（`shell`、`start_process`、`stop_process`、`system_monitor`、`process_monitor`、`collect_artifacts`、`pull_files`、`watch_files`、`assert`）：九个节点仍然是一组行为固定的成品，同样会被业务节点绕开，每个都要继续维护文档页的一节、元信息、测试，而真实使用方一个都没用。
- **只留三四个**最通用的：问题不在数量，在形态——留下的节点行为仍然改不了，难写对的逻辑（进程组、轮转日志、判断文件写完）没有以别的形式提供出来，业务节点还是要自己重写一遍。
- **并进 SDK**：会破坏「SDK 运行时只用标准库」，让 psutil 成为每个 Agent 上每个任务的必需依赖，并把这些函数的版本绑到 Agent 的版本上，改一个函数要发一个平台版本。
- **新起一个包名，旧的包名保留 0.3.0 不动**：多一个概念，两个包都要在公共项目里维护；0.3.0 不可变，已经满足「锁定它的场景不受影响」。

## Consequences

- `sfly-std` 的内部模块整理成公开模块（`_waiting` → `waiting`、`_logfile` → `logs`，新增 `commands`、`processes`、`resources`、`agent_files`），节点模块变成外壳；下划线开头的模块（`_names`、`_params`、`_process`、`_supervise`、`_sampling`、`_assertions`、`_pull`）仍是内部实现。
- 辅助函数和节点分开测：函数有直接调用的单测（`std/tests/test_*.py`，用 `direct_context.py` 的 `DirectRun` 造 `Context`；用户给自己的业务节点写单测时用公开的 `sfly.Context` 构造函数造，开发文档「标准节点」页有写法，`sfly.testing` 里目前没有现成的函数，是个缺口），节点仍用 `sfly.testing.run_node` 在真实的执行器里测。节点对外的行为（状态、错误类型和信息、日志、输出、指标名、产物名）另有一份夹具 `std/tests/node_behavior.json`：用重构之前每个节点自己实现逻辑的版本生成，`test_node_behavior.py` 要求之后逐字不变，PR2 删节点、以后改辅助函数时都有它守着。
- 删节点是破坏性变更：场景里引用被删节点的，要锁在 0.3.0 或改成自己的节点；发布说明和 PR 里逐个写明替换办法。平台自己的测试、e2e、性能测试和「开始使用」文档里用到被删节点的，改用保留的三个节点或 `testdata/` 里的包。
- 任务派发的协议和执行语义没有变，`verify-task-dispatch` 的模型不涉及。
