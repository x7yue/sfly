# 标准节点

标准节点包 `sfly-std` 由平台维护，是**节点代码里可以直接调用的辅助函数**，加 **三个节点**：`shell`、`start_process`、`stop_process`。难写对的是逻辑（进程组的起停和看护、采样资源、跟随会轮转的日志、判断文件写完、经 Agent 能力拉文件、等条件），不是节点的外壳：这些逻辑做成函数，你在自己的业务节点里导入、组合；三个节点是这些函数上的薄封装，不写代码也能跑通第一条链，也是执行语义里「跨节点存活的进程」的做法。它就是一个普通的节点包：在 Agent 上执行，场景锁定它的版本，可以用 `sfly debug` 和 `sfly.testing` 调试。

`sfly-std` 有自己的版本号，不随控制面发布，也不会自动出现在控制面上：部署者从 Release 下载后上传一次，之后有新版本时再上传。业务相关的节点仍然由你自己开发（见 [开发节点](sdk-reference.md)）。0.4.0 起只保留三个节点，0.3.0 的其余 14 个节点删除了，怎么替换见 [从 0.3.0 升级](#从-030-升级)。

## 上传 sfly-std

`sfly-std` 要发布到**公共项目**：平台自己维护的节点包放在那里，任何凭据都能读，只有**平台管理员**能发布；控制面的包索引也只列公共项目里的 `sfly-std`，依赖它的节点包装依赖时从那里取（见 [安装 Agent](install-agent.md) 的「控制面的包索引」）。

在本仓库的 GitHub Release 里找到 tag 为 `std-vX.Y.Z` 的版本，下载附件 `sfly-std-X.Y.Z.sflypkg` 和 `SHA256SUMS`。在下载目录里校验，再用平台管理员的个人令牌上传到公共项目（发布请求加查询参数 `project=public`）：

```sh
cd ~/Downloads
sha256sum -c SHA256SUMS --ignore-missing
curl -fsS -H 'content-type: application/octet-stream' -H "authorization: Bearer $SFLY_ADMIN_TOKEN" \
  --data-binary @sfly-std-0.4.0.sflypkg '{{SFLY_URL}}/packages?project=public'
```

- 上传成功时返回节点包的版本信息（JSON）。装了 sfly 命令行时也可以用 `sfly publish sfly-std-0.4.0.sflypkg --project public`（命令行带令牌随 API 令牌那部分提供，见下一条）。
- **需要平台管理员的凭据**（登录，或 `Authorization: Bearer <个人令牌>`）：项目管理员、项目令牌、会话令牌、Agent 凭据、不带凭据都不行，不带凭据是 401，其余是 403，信息写明原因；`project` 现在只能写 `public`，写别的值是 400；不写 `project` 就是发布到默认项目，和以前一样（`sfly-std` 在默认项目里不会出现在包索引里）。发布记录里有发布人（用户和令牌的名称），也在平台管理员的写记录里。平台管理员的凭据怎么得到：第一个管理员和登录已经有了（#490：控制台的 `/setup` 页用初始化码建第一个管理员），个人令牌的签发和命令行的 `sfly login` 在 #491，还没有合入；在那之前拿不到个人令牌，上面的命令行写法还不能照着用。这是过渡的写法，路径带项目（#488）之后改成 `/projects/public/packages`。
- 上传后 `sfly-std` 出现在 [节点包管理](/packages) 页面，它的节点出现在画布的节点选择里，`{{SFLY_URL}}/simple/sfly-std/` 也提供它的 wheel。Agent 第一次执行时从控制面安装它，依赖（`psutil`）从 PyPI 镜像安装。
- Release 说明写明了需要的**最低 Agent 版本**。Agent 版本更旧时任务以 `env_error` 失败并提示升级（见 [需要的 SDK 版本](publish.md#需要的-sdk-版本)）；Agent 跟随控制面的版本，升级控制面即可。
- 已上传的版本不能覆盖。升级时上传新版本，再在场景里把 `sfly-std` 换成新版本；旧场景不受影响。发布到公共项目时，和已有版本按 PEP 440 规范化之后相同的版本（已有 `0.9.0` 再发 `0.9`、`0.9.0.0`）也会被拒绝：409，信息写明已有的是哪个。

## 安全说明

`shell` 等节点让任何能编辑场景的人在 Agent 上以 Agent 的用户身份执行任意命令。这没有扩大攻击面：控制面的发布接口本来就没有认证，任何人都能发布执行任意代码的节点包。在平台有认证和权限控制之前：

- 只让可信的网络访问控制面；
- 用权限受限的专用用户运行 Agent，不要用 root；
- 不要把密钥直接写进节点参数，参数和日志在运行监控页上对所有人可见。

## 通用约定

- 节点名是英文标识符，标题是中文；下文表格里的参数名和输出名就是节点表单与引用上游输出时用的名字。
- 运行时间由节点的超时（timeout，默认 1 小时）限制；超时和取消一样终止节点的整棵进程树。
- 运行时的输出实时转为任务日志。节点输出不超过 1 MB，大内容保存为产物。
- 产物在任务结束后由 Agent 上传到控制面，一个任务的产物合计不能超过控制面的产物上限（默认 1 GB，部署者用 `SFLY_ARTIFACT_LIMIT_MB` 调整）。上限随任务下发给 Agent，Agent 上传之前先把产物加一遍：超过时放得下的产物（从小到大）照常上传，放不下的不传，任务以 `env_error` 失败（不重试），错误信息写明产物合计、上限和没上传的产物；节点本来就失败时保留原来的错误，没上传的产物附在后面。其他原因（网络、控制面拒绝）上传失败时，任务以 `node_error` 失败，错误信息以「上传产物失败」开头并写明是哪个产物。产物随运行一起按保留期清理，清理后引用它的下载得到「产物已被清理」。
- 失败时错误信息写明原因和关键参数，在运行监控页的节点详情里查看。
- 进程类的节点作用于执行它的 Agent 所在的机器：`start_process` 和后面停止它的 `stop_process` 要选同一个 Agent。

## 辅助函数

标准节点包的主体是**节点代码里可以直接调用的辅助函数**（从 `sfly-std` 0.4.0 起提供，0.3.0 里没有）。这些能力里难写对的是逻辑，不是节点的外壳：进程组的启动、停止和看护，采样整机与进程的资源，跟随会轮转的日志，判断文件写完了没有，经 Agent 能力从另一台机器拉文件，等端口、文件、日志行。把它们做成函数，你在自己的业务节点里导入、组合，行为由你的代码决定：函数有参数可以调（例如「进程重启之后按名字重新找到它」的 `refind_within`），`poll_until` 还收回调，不像上面的标准节点那样固定。

用法：节点包把 `sfly-std` 写进依赖（只写下限，例如 `sfly-std>=0.4`），然后从下面的模块导入。**依赖怎么装上**：`sfly-std` 不在 PyPI 上，由控制面的包索引提供（见 [安装 Agent](install-agent.md) 的「控制面的包索引」一节）：`sfly init` 生成的项目已经把 `sfly-std` 绑到它（见 [创建节点包项目](init-project.md)，开发机上 `uv add sfly-std` 就能装上），Agent 装节点包的依赖时也从它取，不用往自己的 PyPI 镜像里放。索引里的是**公共项目**里已发布的 `sfly-std`，上传接口现在只往默认项目发（见上面「上传 sfly-std」），所以新部署里要先让平台管理员把它发布进公共项目（这个办法在 #573 合入之后才有，在那之前新部署里没有办法发布进去），依赖它的节点包才装得上。

| 模块 | 函数 | 做什么 |
|---|---|---|
| `sfly_std.commands` | `run_command` | 执行一段命令，输出实时转成任务日志，返回退出码和输出的末尾，可以把完整输出存成产物 |
| `sfly_std.processes` | `start_background_process`、`stop_background_process`、`background_exit_status` | 启动跨节点存活的后台进程（新会话、有看护进程记退出码）、停止它所在的进程组（先 SIGTERM、宽限期后 SIGKILL）、查它的状态（现在还在不在，退出了的话退出码是什么；默认看一眼就返回，要等它退出时传 `wait`） |
| `sfly_std.processes` | `find_processes` | 按进程号、进程名或命令行找进程，可以连同子孙进程；每次都重新找，进程重启后按名字能找到新的 |
| `sfly_std.resources` | `monitor_system`、`monitor_processes` | 按间隔采样整机或一组进程的 CPU、内存、磁盘、网络等并上报指标；`monitor_processes` 的 `refind_within` 让进程重启后按名字重新找到它、接着监控 |
| `sfly_std.logs` | `LogFile`、`follow_log_file`、`wait_for_log_line` | 像 `tail -F` 一样读日志（处理轮转和截断）、把日志转成任务日志并在出现错误行时失败、等日志里出现某一行 |
| `sfly_std.waiting` | `poll_until`、`wait_for_port`、`wait_for_file` | 反复检查直到条件成立或超时、等端口可以连接、等文件出现并写完 |
| `sfly_std.agent_files` | `pull_files_from_agent`、`watch_agent_files` | 经 Agent 能力把另一台 Agent 上匹配的文件一次性拉过来、持续盯着一个目录拉新出现的 |

每个函数都有文档字符串和类型标注（编辑器里直接看参数和会抛出什么异常）；资源采样、跟随日志、监听文件上报的指标由调用它们的节点在 `@node(metrics=...)` 里声明，模块里提供现成的声明：`SYSTEM_METRICS`、`SYSTEM_CHARTS`、`PROCESS_METRICS`、`PROCESS_CHARTS`、`FOLLOW_METRICS`、`WATCH_METRICS`（都是元组，要加自己的指标时 `PROCESS_METRICS + (Metric(…),)`）。

写法上的约定，所有函数一致：

- **结果是数据类**（`frozen`）：`run_command` 返回 `CommandResult`，`monitor_system` 返回 `SystemMonitorResult`，`wait_for_port` 返回 `PortReady`，`wait_for_file` 返回 `FileReady`，`wait_for_log_line` 返回 `LogLineMatch`，`follow_log_file` 返回 `FollowResult`，`background_exit_status` 返回 `BackgroundExit`，`poll_until` 返回 `PollResult`；以后只会增加字段。
- **路径参数可以是 `str` 或 `Path`，返回的路径是 `Path`**：`start_background_process` 返回的 `log_path` 是 `Path`，直接交给 `ctx.artifacts.save(名称, 它)` 就是存这个文件。**字段和参数的后缀各有一种意思**：`*_path` 是本地文件路径（`Path`），`*_artifact` 是产物的名称，`*_ref` 是产物的引用（下载地址，交给后面的节点用 `ctx.artifacts.download` 下载，**不是本地路径**：本地调试时它恰好是路径，上了 Agent 就不是，别拿它去 `open`）。
- **时间都以秒为单位**：`wait`、`poll`、`duration`、`interval`、`stable`、`grace`、`refind_within`、`appear_within` 和返回值里的 `waited`；时间参数写成布尔值（`refind_within=True` 会被当成 1 秒）会抛出 `ValueError`。
- **从哪里读日志**都叫 `read_from`（`"end"` 只看之后新写入的，`"start"` 从头看起）；**`stable`**（文件至少这么多秒没有修改才算写完）在 `wait_for_file` 和 `watch_agent_files` 里是同一个意思，默认 0；**`include_children`**（连同子孙进程）在 `find_processes`、`monitor_processes` 里默认都是 True：一个服务指的是它的主进程和启动的全部子进程，只要匹配到的进程本身时传 False。
- **同一个节点里可以多次调用**：默认的产物名和日志文件名每次调用不同，前一次的不会被覆盖。`run_command(save_output=True)` 的产物第一次是 `stdout.txt`、`stderr.txt`，再调用依次是 `stdout-2.txt`、`stderr-2.txt`……；`monitor_processes` 的明细是 `processes.csv`、`processes-2.csv`……；`start_background_process` 的日志是 `procs/<节点 ID>.log`、`<节点 ID>-2.log`……（起数据库再起被测服务，两个日志不会混在一起）。要自己决定名字时传 `stdout_artifact`、`stderr_artifact`、`csv_artifact`、`log_path`，实际用的名字在返回值里（`CommandResult.stdout_artifact`、`ProcessMonitorResult.csv_artifact`、`BackgroundProcess.log_path`）；自己给的产物名称不合法、`stdout_artifact` 和 `stderr_artifact` 相同时马上抛出 `ValueError`，命令不会先跑起来。
- `find_processes` 返回的是 `psutil.Process`，psutil 的接口也是这里的接口。`Literal` 类型的参数（`read_from`、`on_exit`）写成别的值会抛出 `ValueError`，不会当成某个默认值；`pull_files_from_agent`、`watch_agent_files` 的 `directory`、`local_dir` 只能按关键字传。
- 函数是同步的：想在业务动作进行的同时采样（`monitor_processes`、`follow_log_file`、`watch_agent_files`），把采样放在子流程里的另一个节点（和动作并行）、由停止子流程节点停止，或者放进线程里用 `duration` 限定时长；现在没有「动作做完就停下」的回调（以后可以加一个关键字参数，不影响现有的用法）。

**兼容性承诺**：一台 Agent 的共享环境里只有一个 `sfly-std` 版本，所有依赖它的节点包用的是同一份，所以公开的接口只做向后兼容的改动：上面这些模块里 `__all__` 列出的函数和类，签名只增不减（新增的参数是带默认值的关键字参数，已有参数的名字、默认值、类型不变），返回值只增加字段，异常的类型名不变；要改变已有行为就加一个新名字的函数，旧的继续保留。以下划线开头的模块（`sfly_std._process` 这类）是内部实现，不要导入。承诺的内容就是 `std/tests/public_api.txt` 里的快照，改它必须出现在评审里。

### 给自己的节点写单元测试

用辅助函数的业务节点有两种测法。`sfly.testing.run_node` 在真实的执行器进程里跑整个节点（取消、指标、产物都能测），见 [开发节点](sdk-reference.md)。只想测节点里的一段逻辑、直接调用辅助函数时，要有一个 `Context`：`sfly.Context` 的构造函数是公开的，把事件、取消标记、产物目录、后台进程目录都指到临时目录就行：

```python
from sfly import Context, TaskInfo


def make_context(root):
    return Context(
        events_path=root / "events.jsonl",
        cancel_path=root / "cancel",  # 写出这个文件，`ctx.cancelled()` 就为真
        artifacts_dir=root / "artifacts",
        artifacts_url="http://artifacts.invalid",
        task=TaskInfo(run_id="run", node_id="node", task_id="task", attempt=1),
        procs_dir=root / "procs",
    )
```

`sfly.testing` 里目前没有现成的函数给出这样的 `Context`（`std/tests/direct_context.py` 的 `DirectRun` 是 sfly-std 自己的测试用的，还能读回日志和指标，不在包里发布）：直接调用辅助函数的单元测试要像上面这样自己造，这是个缺口，有需要时再补一个公开的写法。

### 示例：起服务、等就绪、采样资源、收集日志、停服务

下面的节点启动被测服务，等它打出就绪日志、端口可以连接，就绪后采样服务进程的资源，停掉服务，把服务日志存成产物。启动服务和停止服务在同一个节点里，所以放在 `try`/`finally` 里：节点失败或被取消时服务也会被停掉，日志也会存下来。它在 `std/tests/service_example.py` 里被真正跑过（起一个 HTTP 服务、采样、收集日志、停掉；服务忽略 SIGTERM、节点被取消时也不留下进程）。

```python
"""示例业务节点：起服务、等就绪、采样资源、收集日志、停服务。"""

from typing import Annotated, TypedDict

from sfly import Context, Doc, node
from sfly_std.logs import wait_for_log_line
from sfly_std.processes import start_background_process, stop_background_process
from sfly_std.resources import PROCESS_CHARTS, PROCESS_METRICS, monitor_processes
from sfly_std.waiting import wait_for_port


class ServiceCheckOutputs(TypedDict):
    samples: Annotated[int, Doc("采样了多少次")]
    log: Annotated[str, Doc("服务日志的产物引用")]
    exit_code: Annotated[int | None, Doc("停止服务时它的退出码")]


@node(
    title="服务冒烟检查",
    metrics=PROCESS_METRICS,
    charts=PROCESS_CHARTS,
    primary_metric="cpu_percent",
)
def service_check(
    ctx: Context,
    command: Annotated[str, Doc("启动被测服务的命令")],
    port: Annotated[int, Doc("服务监听的端口")],
    ready_line: Annotated[str, Doc("服务就绪时打出的日志行（正则）")],
    observe: Annotated[float, Doc("就绪后采样资源的秒数")] = 10,
) -> ServiceCheckOutputs:
    """起服务，等它就绪，采样它的资源，收集日志，最后停掉服务。

    副作用：启动的服务在节点结束前会被停掉，包括节点失败、被取消的时候：先发 SIGTERM，服务
    没有退出就在 5 秒后发 SIGKILL（被取消时最多等 3 秒）。服务日志在服务停掉之后存成产物，
    节点失败时也存。

    失败：服务 60 秒内没有就绪，或者采样期间服务退出了。
    """
    service = start_background_process(ctx, command)
    try:
        try:
            wait_for_log_line(ctx, service.log_path, ready_line, read_from="start", wait=60)
            wait_for_port(ctx, port, wait=10)
            monitor = monitor_processes(ctx, pid=service.pid, duration=observe)
        finally:
            # 在 finally 里清理要在平台给的收尾时间（默认 10 秒）内做完：stop_background_process
            # 的宽限期默认 5 秒，被取消时最多 3 秒，来得及发 SIGKILL。
            stopped = stop_background_process(ctx, service.pid)
    finally:
        # 服务停掉之后再存：日志里有它停止时的输出；节点失败时（最需要日志的时候）也存。
        log = ctx.artifacts.save("service.log", service.log_path)
    return {"samples": monitor.samples, "log": log, "exit_code": stopped.exit_code}
```

几个要点：

- `start_background_process` 启动的进程不属于任务的进程树，节点结束后它继续运行：要么像上面这样在 `finally` 里停，要么由场景里另一个节点（设为 always 节点）停止，用 `start_process` 和 `stop_process` 这两个节点就是这种做法。
- **在 `finally` 里清理，要在平台给节点的收尾时间内做完**：任务被取消或超时时，平台向节点发 SIGTERM，10 秒（Agent 的 `--terminate-grace`，默认 10 秒）后强制杀掉整棵进程树，节点自己也在其中。`stop_background_process` 的 `grace`（从 SIGTERM 到 SIGKILL）默认只有 5 秒，所以**一个**忽略 SIGTERM 的服务也来得及发 SIGKILL；任务已经被取消（`ctx.cancelled()`）时再压到最多 3 秒。这些上限是**每次调用**的，不是整个收尾的预算：任务**超时**时平台不写取消标记（`ctx.cancelled()` 为假，宽限期不会压短），每停一个忽略 SIGTERM 的服务要用掉约 `grace` 秒，两个这样的服务用默认值就是 10 秒，第二个来不及 SIGKILL，它和它的看护进程会留下来，日志也存不了；取消时每个最多约 3 秒（三个服务的收尾约 9.4 秒）。所以**在 `finally` 里停两个及以上服务时，把 `grace` 给小**（各 2 秒，总和留在 10 秒以内），或者用单独的 always 节点停。你自己的清理里等的时间加起来不能超过这个时间；服务退出得慢、需要更长的宽限期时不要在 `finally` 里停，用单独的 always 节点（`stop_process`，它是一个单独的任务，有自己的时间）。
- 保存服务日志放在 `finally` 里、停服务之后：服务没有就绪、采样失败的时候最需要日志，停止时服务打的最后几行也在里面。
- `monitor_processes` 的指标要在 `@node` 里声明：`metrics=PROCESS_METRICS, charts=PROCESS_CHARTS`；不设置 `duration` 时它一直采样到任务被取消，所以要和压测同时跑的监控放在子流程里。
- `ctx.artifacts.save(名称, 数据)`：数据是 `str` 或 `bytes` 时保存的是这段内容；要保存一个文件，传 `Path`。`service.log_path` 是 `Path`，直接传就是存这个文件；传成字符串（`str(service.log_path)`）会把路径当成内容存进去。
- 被监控的进程会重启（崩溃后被拉起、发版时被替换）时，按名字或命令行指定目标并给 `refind_within`，进程退出后最多再等这么多秒让新的进程出现，出现了就接着监控，超过才按 `on_exit` 处理：

  ```python
  monitor_processes(ctx, name="gateway", refind_within=30, duration=600)
  ```

  按 `pid` 指定的目标不能这样找（进程号是一次性的），退出了就按 `on_exit` 处理。两点要知道：

  - 重新出现的进程是新的进程号：按进程的那组指标（标签 `pid`、`name`）因为 `pid` 标签变了，从这时起是新的一条序列；合计的指标（`cpu_percent`、`rss_bytes` 等）接着原来的序列，等待的那一段是断开的（等待期间没有进程可统计，不会上报全是 0 的合计）。目标有好几个、只有一个在重启时，其余的照常采样和上报。
  - 等待期间任何名字或命令行符合条件的进程都算「重新出现」，同名的无关进程也一样，所以 `name`、`match` 要写得足够具体。

### `monitor_processes`：每个进程的明细和按进程的序列

`monitor_processes` 上报所有目标进程（默认连同它们的全部子孙进程）的合计，并按每个进程（标签 `pid`、`name`）各上报一个序列；每个进程每次采样的明细写进产物 `processes.csv`（同一个节点里再调用依次是 `processes-2.csv`……，也可以用 `csv_artifact` 指定名称）：

| `processes.csv` 的列 | 说明 |
|---|---|
| `time` | 采样时间（UTC，ISO 8601，到毫秒），同一次采样的各行相同 |
| `pid` | 进程号 |
| `ppid` | 父进程号 |
| `name` | 进程名 |
| `cpu_percent` | 这个进程在上一次采样以来的 CPU 占用 |
| `rss_bytes` | 常驻内存（字节） |
| `threads` | 线程数 |
| `open_fds` | 打开的文件描述符数 |
| `io_read_bytes_per_s` | 磁盘读取速率（字节/秒） |
| `io_write_bytes_per_s` | 磁盘写入速率（字节/秒） |
| `cmdline` | 命令行 |

- `processes.csv` 每采样一次就写入：被停止、取消、因目标退出失败时，已采集的明细都在产物里。第一次采样在开始后一个 `interval` 时（CPU 占用要两次读数才能算出来）；某个进程第一次被采样时它的 IO 速率为空。
- 默认图表（`PROCESS_CHARTS`）：CPU、内存、线程与文件描述符、磁盘读写这四张画合计；CPU（按进程）、内存（按进程）、线程数（按进程）、文件描述符（按进程）、磁盘读写（按进程）这五张每个进程一条曲线，图例是 `进程号 · 进程名`。按进程的指标和 `processes.csv` 里同一次采样的那一行数值相同。
- 别的用户的进程读不到文件描述符数和 IO（Agent 不是 root 时），`processes.csv` 里这两项为空，不计入合计，也不上报这个进程的 `open_fds_by_process`、`io_read_bytes_per_s_by_process`、`io_write_bytes_per_s_by_process`。
- 进程名为空时（读不到进程名，例如某些内核线程），这个进程不上报按进程的指标（标签值不能为空），合计和 `processes.csv` 照常包括它。
- 每个进程是一个序列：进程很多或者频繁启停（例如每个请求起一个子进程）时序列会很多，一个任务最多 1000 个序列（见 [SDK 参考](sdk-reference.md) `ctx.metric` 一节的「序列上限」），超出后新进程的点不再上报，任务日志里每个按进程的指标有一条警告；合计和 `processes.csv` 不受影响。

## 节点一览

| 类别 | 节点 | 标题 | 用途 |
|---|---|---|---|
| 执行 | `shell` | Shell 命令 | 执行一段命令，输出退出码、标准输出和标准错误 |
| 执行 | `start_process` | 启动后台进程 | 启动被测系统等常驻进程，节点结束后进程继续运行 |
| 执行 | `stop_process` | 停止后台进程 | 停止 `start_process` 启动的进程组，适合作为 always 节点清理 |

## 压测期间监控被测服务

一个典型的压测场景：启动被测服务，等它就绪，压测期间监控机器和服务进程；压测结束后停止监控、停掉服务。链上的节点依次执行，要和压测同时运行的监控节点都放在子流程里，压测结束后用停止子流程节点把它们停下来。下面的节点都选被测机器上的同一个 Agent。`shell`、`start_process`、`stop_process` 是标准节点，其余是自己写的节点（用辅助函数，写法见上面的示例）。

**主链**：

1. `server`（`start_process`）：启动被测服务，`log_file` 设为 `/srv/bench/out/server.log`；
2. `ready`（自己的节点）：用 `wait_for_log_line`、`wait_for_port` 等服务就绪；
3. 异步任务节点：触发子流程「监控」，把 `server` 的输出 `pid` 作为参数传进去；
4. `bench`（`shell`）：执行压测工具，把报告写到 `/srv/bench/out`；
5. 停止子流程节点（always 节点）：选中子流程「监控」；
6. `stop_server`（`stop_process`，always 节点）：`pid` 引用 `server` 的输出 `pid`；
7. `check`（自己的节点）：读 `/srv/bench/out` 里的压测报告，错误数不为 0 就抛异常；用 `ctx.artifacts.save(名称, Path(文件))` 把报告和服务日志存成产物（想在压测失败时也收集，把它设为 always 节点）。

**子流程「监控」**：子流程入口声明参数 `pid`。同一条链上的节点依次执行，两个不会自己结束的监控节点要各占一条链：入口之后先用一个异步任务节点触发下级子流程「进程监控」，再接 `system`（自己的节点，调用 `monitor_system`）；「进程监控」里是 `process`（自己的节点，调用 `monitor_processes`，`pid` 引用子流程参数 `pid`）。两个节点都不设置 `duration`，各用自己的 `@node(metrics=…, charts=…)` 声明指标（系统指标和进程指标有同名的 `cpu_percent`，不能放进同一个节点）：

```python
from sfly import Context, node
from sfly_std.resources import PROCESS_CHARTS, PROCESS_METRICS, monitor_processes


@node(
    title="监控被测服务进程",
    metrics=PROCESS_METRICS,
    charts=PROCESS_CHARTS,
    primary_metric="cpu_percent",
)
def process(ctx: Context, pid: int) -> None:
    """统计被测服务进程（连同子孙进程）的资源，直到被停止子流程节点停止。"""
    monitor_processes(ctx, pid=pid)
```

这样安排的效果：

- 监控从压测开始前一直持续到压测结束。停止子流程节点停止「监控」时，连同它触发的下级子流程一起停止，监控节点记为「已停止」，不算失败。运行监控页上能看到整个压测期间的系统指标和进程指标，`monitor_processes` 的产物里有每个进程的明细 `processes.csv`。
- 停止子流程节点要设为 always 节点：压测失败时也要停止监控，否则监控一直运行到节点超时，运行迟迟不能结束。
- 停止子流程节点放在 `stop_server` 之前：先停监控再停服务，否则 `monitor_processes` 会因为服务退出而失败（默认 `on_exit="fail"`）。
- 服务在压测中意外退出时 `monitor_processes` 失败（`on_exit` 默认 `fail`）；服务会被拉起重启时给 `refind_within`（秒），它按名字重新找到新进程、接着监控。子流程失败不影响主链继续执行，但运行最终记为失败，在运行监控里能看到是哪个子流程。
- 压测时长固定、不需要停止子流程节点时，给监控函数设置 `duration`，到期后自己成功结束；它们仍然要放在子流程里才能和压测同时运行。

## `shell`：Shell 命令

用解释器执行一段命令：`<shell> -c <command>`。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `command` | 必填 | 要执行的命令 |
| `shell` | `/bin/sh` | 解释器：/bin/bash、python3 等任何能用 -c 执行一段命令的程序 |
| `env` | 无 | 追加的环境变量（对象，值为字符串），在 Agent 的环境变量之上 |
| `cwd` | 任务工作目录 | 工作目录，必须已经存在 |
| `ok_exit_codes` | `[0]` | 算作成功的退出码 |
| `save_output` | `false` | 保存完整输出：为 true 时把完整的标准输出和标准错误各保存为一个产物 |

| 输出 | 说明 |
|---|---|
| `exit_code` | 退出码；命令被信号终止时为 128 + 信号值（与 shell 的 $? 相同） |
| `stdout` | 标准输出的最后 64 KiB |
| `stderr` | 标准错误的最后 64 KiB |
| `stdout_file` | 产物 stdout.txt（完整的标准输出）的引用；save_output 为 false 时是空值 |
| `stderr_file` | 产物 stderr.txt（完整的标准错误）的引用；save_output 为 false 时是空值 |

- 标准输出和标准错误实时转为任务日志（来源分别是 stdout 和 stderr），`save_output` 不影响这一点。
- `stdout`、`stderr` 超过 64 KiB 时只保留末尾，截断点不会落在一个多字节字符中间。要完整内容时打开 `save_output`：两个产物是命令输出的原始字节，边运行边写入，命令失败、被取消时已有的内容也保留。后续节点引用 `stdout_file`、`stderr_file`，用 SDK 的 `ctx.artifacts.download` 下载（见 [开发节点](sdk-reference.md) 的「下载产物」）；产物在控制面上，后续节点在哪一台 Agent 上执行都能下载。
- 两个产物的大小上限和保留期见上文「通用约定」。
- `stderr`、`save_output`、`stdout_file`、`stderr_file` 从 sfly-std 0.3.0 起有；锁定旧版本的场景只有 `exit_code` 和 `stdout`，行为不变。
- 退出码不在 `ok_exit_codes` 里时节点失败，错误信息是退出码、命令和标准错误的末尾（约 4 KiB）。解释器或工作目录不存在时也失败，错误信息写明是哪一个。
- 取消或超时时，命令和它启动的全部子进程都被终止：先发 SIGTERM，宽限期过后强制杀掉。自己调用 `setsid` 脱离进程组的进程不在其中。
- 命令退出时还在运行的后台进程（例如 `server &`）不会被终止。它们还持有输出管道时，节点最多再等 2 秒；这之后的输出不再转为日志，也不进 `stdout`、`stderr` 和 `save_output` 的产物，产物停在那一刻的内容。

例：构建后把版本号交给后面的节点。节点 `build` 的参数：

```json
{
  "command": "make dist && cat VERSION",
  "shell": "/bin/bash",
  "cwd": "/srv/app",
  "env": { "BUILD_MODE": "release" }
}
```

后面的节点在参数里引用 `build` 的输出 `stdout` 拿到版本号（含末尾的换行）。允许 `grep` 没有匹配（退出码 1）时，把 `ok_exit_codes` 设为 `[0, 1]`。

## `start_process`：启动后台进程

在新会话里执行 `<shell> -c <command>`，不等它结束：节点立即成功，进程在节点结束后继续运行，用来启动被测系统等常驻进程。之后用 `stop_process` 停止它。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `command` | 必填 | 要执行的命令 |
| `shell` | `/bin/sh` | 解释器，与 shell 节点相同 |
| `env` | 无 | 追加的环境变量（对象，值为字符串），在 Agent 的环境变量之上 |
| `cwd` | 任务工作目录 | 工作目录，必须已经存在 |
| `log_file` | `$SFLY_HOME/procs/<运行 ID>/<节点 ID>.log` | 进程的标准输出和标准错误追加写入的文件；相对路径相对于 cwd，目录不存在时自动创建 |

| 输出 | 说明 |
|---|---|
| `pid` | 进程号：交给 stop_process、process_monitor 等节点 |
| `log_file` | 日志文件的绝对路径：交给 wait_log_line、follow_log、collect_artifacts 等节点 |

- 进程在新的会话和进程组里，不属于任务的进程树：节点结束、任务被取消或超时都不会终止它，运行结束后也不会自动停止，**一定要配一个 `stop_process`**（见下一节的例子）。
- 进程的输出不转为任务日志，只写进 `log_file`。默认位置不在任务目录里：任务目录被清理时不受影响，和任务目录按同一个保留期清理（运行还有任务在这个 Agent 上时不动，后台进程还在写日志时不会被删，见 [安装 Agent](install-agent.md)）。同一个节点重试时追加到同一个文件。
- 节点只负责把进程启动起来：命令随后失败退出时节点仍然成功，用 `wait_port`、`wait_log_line` 等节点等它就绪，用 `stop_process` 的 `exit_code` 查看它是否异常退出过。解释器或工作目录不存在时节点失败。
- 进程运行在执行这个节点的 Agent 所在的机器上，后面引用它的节点（`stop_process`、监控节点等）要选同一个 Agent。

例：启动被测服务。节点 `server` 的参数：

```json
{
  "command": "exec ./bin/server --port 8080",
  "cwd": "/srv/app",
  "env": { "LOG_LEVEL": "debug" }
}
```

命令前加 `exec` 让解释器直接换成服务进程，`pid` 就是服务本身的进程号（不加时是解释器的进程号，服务是它的子进程，`stop_process` 同样能把它们一起停掉）。

## `stop_process`：停止后台进程

终止 `pid` 所在的整个进程组：先发 SIGTERM，宽限期过后还没退出的发 SIGKILL。进程已经不在时直接成功。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `pid` | 无 | 要停止的进程号，通常引用 start_process 的输出 pid；为空时什么也不做、直接成功 |
| `grace` | `10` | 从 SIGTERM 到 SIGKILL 的宽限期（秒） |

| 输出 | 说明 |
|---|---|
| `was_running` | 开始停止时进程是否还在运行 |
| `exit_code` | 进程的退出码：被信号终止时为 128 + 信号值（SIGTERM 为 143，被 SIGKILL 强制杀掉为 137）；拿不到时为 null |

- 终止的是整个进程组：`start_process` 启动的命令和它的子进程（包括命令自己已经退出、留在后台的进程）都会被终止。自己调用 `setsid` 脱离进程组的进程不在其中。
- `exit_code`：进程由同一次运行里、同一个 Agent 上的 `start_process` 启动时能拿到。`was_running` 为 false、`exit_code` 不是 0 时，说明进程在停止之前就异常退出了。
- 宽限期加 SIGKILL 后进程仍没有退出（例如卡在不可中断的磁盘读写里）时节点失败。

**放在 always 节点里清理**：把 `stop_process` 设为 always 节点，前面的节点失败或运行被取消时它仍然执行，被测进程不会留在机器上。`start_process` 本身失败时，引用的 `pid` 解析为空，`stop_process` 直接成功。例：场景依次是 `server`（`start_process`）、等待就绪、压测，最后是 always 节点 `stop_server`（`stop_process`），参数里的 `pid` 引用节点 `server` 的输出 `pid`，宽限期设为 30 秒：

```json
{
  "grace": 30
}
```

`stop_server` 要和 `server` 选同一个 Agent。压测中服务意外退出时，`stop_server` 的输出是 `was_running` 为 false、`exit_code` 为服务的退出码。

## 从 0.3.0 升级

0.4.0 只保留 `shell`、`start_process`、`stop_process` 三个节点（行为和 0.3.0 一致），其余 14 个节点删除，逻辑成了上面的辅助函数。已发布的 0.3.0 不变，锁定它的场景不受影响；要升级到 0.4.0 的场景，引用了被删节点的地方按下表改成自己的节点（和 Release 说明里的表相同）。

| 删掉的节点 | 怎么替换 |
|---|---|
| `system_monitor` | 自己的节点里调用 `sfly_std.resources.monitor_system`（指标和图表声明：`SYSTEM_METRICS`、`SYSTEM_CHARTS`） |
| `process_monitor` | `sfly_std.resources.monitor_processes`（`PROCESS_METRICS`、`PROCESS_CHARTS`）；新增参数 `refind_within`：进程重启后按名字重新找到它、接着监控；节点的 `wait_for_process` 在函数里叫 `appear_within`，节点输出的 `processes_csv` 是结果的 `csv_ref` |
| `wait_port` | `sfly_std.waiting.wait_for_port` |
| `wait_file` | `sfly_std.waiting.wait_for_file` |
| `wait_log_line` | `sfly_std.logs.wait_for_log_line` |
| `follow_log` | `sfly_std.logs.follow_log_file`（指标声明：`FOLLOW_METRICS`） |
| `collect_artifacts` | 自己的节点里用 `ctx.artifacts.save(名称, Path(文件))` |
| `pull_files` | `sfly_std.agent_files.pull_files_from_agent`（`directory`、`local_dir` 只能按关键字传；节点输出的 `files` 是结果的 `paths`，元素是 `Path`） |
| `watch_files` | `sfly_std.agent_files.watch_agent_files`（`directory`、`local_dir` 只能按关键字传；指标声明：`WATCH_METRICS`） |
| `http_request` | 自己的节点里直接用 `httpx`（写进节点包自己的依赖）；要重试到成功用 `sfly_std.waiting.poll_until` |
| `assert` | 阈值和判断写在自己的节点代码里，不满足就抛异常 |
| `file_assert` | 自己的节点里读文件、判断后抛异常（等文件写完用 `sfly_std.waiting.wait_for_file`） |
| `process_assert` | 自己的节点里用 `sfly_std.processes.find_processes(…, include_children=False)` 数进程（`include_children` 默认 True，会连子进程一起找出来）、判断后抛异常 |
| `port_assert` | 自己的节点里用标准库 `socket.create_connection` 检查端口（等端口出现用 `sfly_std.waiting.wait_for_port`） |

依赖的变化：0.4.0 只依赖 `psutil`；`httpx` 随 `http_request` 一起去掉了，要用的节点包自己依赖它。
