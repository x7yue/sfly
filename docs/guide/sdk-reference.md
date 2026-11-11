# 开发节点（SDK 参考）

节点包里的每个节点都是一个用 `@node` 声明的 Python 函数。发布后，sfly Agent 每执行一个任务就启动一个新的 Python 进程，导入节点函数，把输入作为关键字参数传进去，把返回值作为输出。

本页是 `sfly` SDK 的完整参考，也随 SDK 打进 `sfly init` 生成的项目（`.agents/skills/sfly-node-dev/reference.md`）。

## 项目结构

`sfly init` 生成的项目已经符合下面的约定：

| 位置 | 内容 |
|---|---|
| `pyproject.toml` 的 `[project]` | `name`（节点包名：小写字母、数字、`-`、`_`，以字母或数字开头）、`version`、`requires-python`（默认 `>=3.10`）、`dependencies` |
| `src/<模块>/` | 节点代码；模块名是包名把 `-` 换成 `_`。也可以是 `<模块>/` 或 `<模块>.py` |
| `pyproject.toml` 的 `[tool.sfly]` | `requires-sdk`：节点包需要的 SDK 版本，例如 `>=0.0.4`（见下文） |
| `[dependency-groups] dev` | `sfly[cli]`（锁定为控制面版本）、pytest、ruff |
| `tests/` | 单元测试（`sfly.testing`） |

- `sfly build` 导入模块及其全部子模块，收集其中的 `@node`。节点名在一个节点包里不能重复。
- 依赖只写在 `[project].dependencies`（pyproject 没有声明 dependencies 时读 `requirements.txt`）。Agent 上所有节点包共用一个 venv，只写宽松的下限。
- `sfly` 不能写进 `[project].dependencies`：Agent 自带 SDK 运行时，`sfly build` 遇到它直接报错。
- Agent 上 SDK 运行时的版本就是 Agent 的版本。`requires-sdk` 声明节点包需要的 SDK 版本，`sfly build` 把它写进节点包元信息的 `requires_sdk`；没写时用构建时 SDK 的版本作为下限（`>=<版本>`），`sfly init` 生成的项目写的是当时控制面的版本。格式是逗号分隔的比较符加数字版本号（`>=`、`>`、`<=`、`<`、`==`、`!=`、`~=`），例如 `>=0.0.4`。用到新版 SDK 才有的接口时调高它：派发到版本不满足的 Agent 时任务以 `env_error` 失败，错误信息写明需要的 SDK 版本和 Agent 的版本，提示升级 Agent。触发前检查比较的是控制面的版本（Agent 会先自更新到控制面的版本再执行任务），不满足时提示升级控制面。

## `@node`

```python
from typing import TypedDict

from sfly import Chart, Context, Metric, node


class CheckOutputs(TypedDict):
    status: int
    report: str


@node(
    title="HTTP 检查",
    metrics=[Metric("latency_ms", unit="ms"), Metric("requests", kind="counter")],
    charts=[Chart("延迟", type="line", metrics=["latency_ms"])],
    primary_metric="latency_ms",
)
def http_check(ctx: Context, url: str, expect: int = 200) -> CheckOutputs:
    ...
```

`@node` 和 `@node(...)` 都可以用，装饰器不改变函数本身。只能用于模块顶层的函数。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `name` | 函数名 | 节点名，场景和 `sfly run` 用它引用节点 |
| `title` | 节点名 | 画布上显示的名称 |
| `outputs` | 从返回类型读取 | 输出键：键名列表，或 键名 → 类型注解 的字典 |
| `metrics` | 无 | 指标声明（`Metric`），最多 50 个 |
| `charts` | 无 | 图表声明（`Chart`），最多 20 张 |
| `primary_metric` | 无 | 主指标名，必须是已声明、不带标签键的指标，显示在紧凑位置 |

## 输入

函数的首个参数是任务上下文：注解为 `Context`，或名为 `ctx` 且没有注解。其余参数都是输入，按名称传入（不支持 `*args`、`**kwargs` 和仅位置参数）。`sfly build` 按类型注解生成输入的 JSON Schema，画布据此渲染参数表单。

| 注解 | 输入 |
|---|---|
| `str`、`int`、`float`、`bool` | 字符串、整数、数字、布尔值 |
| `Literal["a", "b"]`、`enum.Enum` 子类 | 取值之一（Enum 取成员的值） |
| `list[T]`、`Sequence[T]` | 数组 |
| `dict[str, T]`、`Mapping[str, T]` | 对象（键必须是 `str`） |
| TypedDict | 有固定键的对象（非 `total` 的键可选） |
| `T \| None`、`Optional[T]`、其他 `Union` | 任一成员 |
| `Annotated[T, ...]` | 同 `T` |
| `sfly.AgentName` | 「Agent」类型：Agent 名称（字符串），见下文 |
| 没有注解、`Any`、`object` | 任意 JSON 值，不校验 |

- 有默认值的参数是可选输入，默认值必须能序列化为 JSON；没有默认值的是必填输入。
- 派发任务前按 schema 校验：缺少必填输入、或声明了的输入类型不符时，任务以 `config_error` 失败，节点不会执行。没有声明的输入不检查。
- 不支持的注解（例如自定义类）让 `sfly build` 报错。

### 「Agent」类型的输入

```python
from sfly import AgentName, Context, node


@node(outputs=["files"])
def clean(ctx: Context, source: AgentName, backup: AgentName | None = None) -> dict:
    """source 是日志所在的 Agent，节点在另一台 Agent 上清洗它的日志。"""
    target = ctx.task.agents[source]
    ctx.log.info("来源 Agent %s 在 %s:%d", source, target.address, target.port)
    ...
```

把输入参数标成 `AgentName`，表示节点会访问这台 Agent。`AgentName` 在运行时就是 `str`：节点收到的值是 Agent 名称。可以写成 `AgentName | None`（可选参数）；不能用在列表、字典或输出里，`sfly build` 会报错。

这个类型从 SDK 0.2.0 起可用。用到它的节点包把 `requires-sdk` 调到 `>=0.2.0`：更旧的 Agent 上没有这个类型，声明之后任务在派发前就以 `env_error` 失败并提示升级，不会运行到一半才报错。

- `sfly build` 在输入 schema 里标记它：`{"type": "string", "x-sfly-type": "agent"}`。
- 画布的检查器里它是 Agent 下拉框，列出已注册的 Agent 及在线状态；也可以用「插入引用」改为引用入口参数。
- 选的 Agent 必须已注册（不要求在线）：常量不是已注册的 Agent 时保存给出警告、触发前的预检阻断，并指出是哪个节点的哪个参数；引用入口参数时按触发时传入的实际值检查；值来自前面节点的输出时在派发时检查，没有注册过时任务以 `config_error` 失败。目标 Agent 不在线不阻断：节点运行时连不上它，访问它的那一步才会失败。
- 派发任务时，控制面把这些 Agent 的名称、地址、端口随任务下发，节点用 `ctx.task.agents` 读到（见下文）。地址在派发时解析：Agent 重新注册换了地址后，之后派发的任务用新地址。
- 本地调试（`sfly run`、`sfly.testing.run_node`）照常接受这种参数，值就是 Agent 名称，不检查它是否注册过；`ctx.task.agents` 里只有名称，地址为空、端口为 0。

## 输出

- 用 TypedDict 返回类型声明输出键和类型；或用 `@node(outputs=...)` 声明。
- 返回值必须是 dict，序列化为 JSON 后不超过 1 MB；返回 `None` 视为空对象。不满足时任务失败。
- 后续节点可以引用输出里的值；大块数据存成产物，输出里放产物引用。

## 失败

节点抛出的任何异常都让任务以 `node_error` 失败：错误消息形如 `ValueError: steps 必须大于 0，收到 0`，并附带 traceback。`node_error` 按场景里配置的重试次数重试，每次重试是一个新任务。消息里写清原因和相关参数值。

## `ctx.log`：日志

```python
ctx.log.info("检查 %s", url)            # 按 % 格式化参数，与标准库 logging 相同
ctx.log.warning("重试第 %d 次", n)       # 也可以写 ctx.log.warn
ctx.log("自定义级别", level="debug")
try:
    ...
except OSError:
    ctx.log.exception("连接失败")        # error 级别，附上当前异常的 traceback
    raise
```

- 级别：`debug`、`info`、`warn`（`warning` 等同 `warn`）、`error`。
- `print` 和子进程的输出也会进入日志：标准输出记为 info，标准错误记为 error，来源分别是 stdout / stderr；`ctx.log` 的来源是 sdk。
- 任务执行中途 Agent 机器的系统时间被改动（超过 2 秒）时，Agent 会往日志里写一行来源为 agent 的提示，写明跳变前后的时间；本地调试时没有这一行。
- 每行日志带两种时间：Agent 时间（执行任务的那台机器的系统时间，方便和被测系统自己的日志对照）和控制面时间。运行监控页的日志时间列默认显示 Agent 时间，可以切换成控制面时间；点一行在时间线上定位、框选时间范围筛选日志，用的都是控制面时间。下载的日志每行两种时间都有：`agent_time` 和 `time`（控制面时间）。升级之前写入的日志只有 Agent 时间，`time` 为空，这些行不能在时间线上定位。

## `ctx.progress`：进度

```python
ctx.progress(current, total=None, message="")
ctx.progress(3, 10, "第 3 批")
```

`current` 是当前值，`total` 是总数（未知时省略），`message` 是说明。可以频繁调用，Agent 按秒合并后上报。

## `ctx.metric`：指标

```python
Metric(name, unit="", kind="gauge", description=None, labels=())
Chart(title, type="line", metrics=())
ctx.metric("latency_ms", 12.5)
ctx.metric("conn_latency_ms", 8.2, labels={"host": "db-1", "port": 5432})
```

- 指标要先在 `@node(metrics=...)` 里声明再上报。指标名是标识符（字母、数字、下划线，不以数字开头），不能重复。
- `kind`：`gauge` 是瞬时值（例如延迟、队列长度），`counter` 是累计值（例如已发送的请求数，上报当前累计值）。
- `Chart.type`：`line`、`area`、`bar`、`stat`；`metrics` 列出至少一个已声明的指标。没有被任何图表引用的指标由平台生成默认图表：瞬时值画折线，累计值画数值卡，带标签的指标一律画折线。
- `labels`：标签键，用来在一个节点里同时上报多个对象的同一个指标（例如每个连接、每个进程）。最多 3 个键，命名规则同指标名，不能重复；`sfly build` 检查这些规则。
- 上报时 `labels` 给出这个点的标签值。一个指标在一组确定的标签值下的全部点是一个**序列**，运行监控页的折线和面积图里每个序列画一条线，图例用标签值以「 · 」连接（按声明的标签键顺序），图表引用多个指标时前面再加上指标名。不带标签的指标仍然只有一个序列。平台不对多个序列求和或求平均，需要合计时另报一个不带标签的指标。
- 带标签的指标只能画在 `line`、`area` 图表里，同一张图表可以混用带标签和不带标签的指标（例如把「合计」和「各进程」画在一起）；`stat`（数值卡）和 `bar`（柱状图）不能引用带标签的指标，带标签的指标也不能作为 `primary_metric`，需要时另报一个不带标签的合计指标作为主指标。`sfly build` 和控制面发布时都检查这些约束。
- 在运行监控页上点图例项可以显示或隐藏对应的线；序列超过 10 个时，默认只显示当前时间范围内平均值最高的 10 个，其余在图例里置灰。悬停时提示列出每条显示中的线在那一刻的值，以及这个点的控制面时间和 Agent 时间（图表的横轴是控制面时间；Agent 时间是节点所在机器当时的时间，机器的时间被改过时两者不同）。
- 声明了标签键的指标，每个点都要给全这些键；没声明标签键的指标不能带标签。标签值是不超过 128 个字符的非空字符串，数字自动转成字符串。
- `ctx.metric` 可以随意频繁调用：Agent 按「序列 × 秒」合并，每秒最多上报一次（`gauge` 取这一秒最后一个值并带最小、最大值，`counter` 取这一秒结束时的值）。
- 以下点被丢弃，并写一条 warn 日志（每个指标名、每种原因只写一次）：未声明的指标名、非有限数值（NaN、无穷大）、缺少声明过的标签键、带了未声明的标签键、给没声明标签键的指标带标签、标签值为空或超过 128 个字符。
- **序列上限**：每个任务所有指标合计最多 1000 个序列，不带标签的指标各算 1 个（预先占好名额，总是能上报）。这个数固定，不能配置。超出后不再建立新序列：新序列的点被丢弃，每个指标写一条 warn 日志；已经有的序列照常上报。控制面也按同一上限兜底，被拒的点计入任务的丢弃数，运行监控页显示「序列超限」。本地调试（`sfly run`、`sfly.testing`）的行为相同。标签值用来区分少量对象（进程、网卡、连接），不要用请求 ID、时间戳这类取值很多的值。序列上限和单任务约 50 MB 的点数上限互不影响。

## `ctx.artifacts`：产物

```python
ref = ctx.artifacts.save("report.html", html)             # bytes 或 str（UTF-8）写入内容
ref = ctx.artifacts.save("logs/server.log", Path(tmp))    # 路径：复制该文件
path = ctx.artifacts.path("capture.pcap")                 # 直接写入的本地路径（父目录已创建）
...                                                       # 写完 path 之后
ref = ctx.artifacts.ref("capture.pcap")
return {"report": ref}
```

- 名称是产物目录内的相对路径，可以用 `/` 分隔子目录；不能有空段、`.`、`..` 或反斜杠。
- 任务结束后 Agent 把产物上传到控制面，运行视图里可以下载。
- **产物引用**：在 Agent 上是产物在控制面上的下载地址，写进输出交给后续节点，后续节点用 `ctx.artifacts.download` 下载；本地调试时是本地文件路径。

### 下载产物

```python
from pathlib import Path

from sfly import Context, node


@node(outputs=["lines"])
def count_lines(ctx: Context, log_file: str) -> dict:
    """log_file 是前面的节点输出的产物引用。"""
    path = ctx.artifacts.download(log_file, "downloads/server.log")
    with path.open("rb") as f:
        return {"lines": sum(1 for _ in f)}
```

`ctx.artifacts.download(ref, dest, *, retries=3, timeout=30.0)` 把产物引用 `ref` 指向的产物下载到本地路径 `dest`，返回写入的路径（`Path`）。

这个接口从 SDK 0.2.0 起可用。用到它的节点包把 `requires-sdk` 调到 `>=0.2.0`：更旧的 Agent 上没有这个接口，声明之后任务在派发前就以 `env_error` 失败并提示升级，不会运行到一半才报错。

- `dest` 是相对任务工作目录的路径或绝对路径；父目录不存在时创建，已有的文件被覆盖。
- 流式读写，内存占用与产物大小无关。内容先写到旁边的 `<文件名>.part`，全部写完才改名成 `dest`：失败或取消时不留下半个文件。
- 连不上控制面、连接中断、控制面返回 5xx 时自动重试，最多 `retries` 次（间隔 0.5 秒起每次加倍）；`timeout` 是连接和每次读取的超时秒数。
- 失败时抛出 `sfly.ArtifactDownloadError`，消息里有原因和产物引用：

  | 消息 | 原因 |
  |---|---|
  | 产物引用无效 | `ref` 不是 http(s) 下载地址，也不是已有的本地文件：传进来的不是 `ctx.artifacts.save` / `ref` 返回的引用 |
  | 产物不存在（HTTP 404） | 任务没有保存过这个名称的产物，或者产物还没有上传 |
  | 产物已被清理（HTTP 410） | 运行已过保留期 |
  | 连不上控制面、连接中断、控制面返回 HTTP 5xx | 重试 `retries` 次之后仍然失败 |

- 任务被取消时下载立即停止，抛出 `sfly.Cancelled`。在后台线程里下载时，在两次读取之间停止（最长等一次读取超时）。
- 产物在保存它的任务结束后才上传：只能下载前面的节点保存的产物，不能下载本任务刚保存的（本地调试时可以，因为引用就是本地文件）。
- 下载直接访问控制面，不经过保存产物的那台 Agent：任何一台 Agent 上的节点都能下载。
- 本地调试没有控制面。本地保存的产物的引用是本地文件路径，`download` 直接复制；要测试「下载上游节点给的引用」时，给这个引用指定本地内容：`run_node(downloads={引用: 内容})` 或 `sfly run --download <引用> <文件>`（见下文），节点下载它时得到这份内容，不访问网络。

## `ctx.task` 与 `ctx.procs_dir`：任务信息与后台进程目录

```python
ctx.task.run_id     # 运行 ID
ctx.task.node_id    # 场景里的节点 ID（同一个节点类型出现多次时各不相同）
ctx.task.task_id    # 任务 ID
ctx.task.attempt    # 第几次尝试，从 1 开始，重试时加 1
ctx.task.agents     # 通过「Agent」类型的输入引用的 Agent：名称 → AgentAddress

log = ctx.procs_dir / f"{ctx.task.node_id}.log"
log.parent.mkdir(parents=True, exist_ok=True)
```

- `ctx.task.agents` 列出这个任务通过「Agent」类型的输入引用的 Agent（值为空的参数不算），每台一项：`AgentAddress(name, address, port, unavailable_reason)`。`address`、`port` 是其它 Agent 连接它用的地址和端口（对外地址取安装 Agent 时显式配置的，否则取控制面看到的连接来源地址）；`unavailable_reason` 不为空时它的能力不能被其它 Agent 调用（例如端口被占用、版本过旧不监听端口），端口可能是 0。从 SDK 0.2.0 起可用；更旧的 Agent 不下发，这时为空。
- `ctx.procs_dir` 是这次运行的**后台进程目录**：节点启动的、节点结束后还要继续运行的进程，把日志等文件放在这里。它不在任务目录里，任务目录被清理或任务重试时不受影响；同一次运行的任务共用一个目录（用节点 ID 区分文件名）。目录不一定已经存在，使用前自己创建。
- 在 Agent 上是 `$SFLY_HOME/procs/<运行 ID>/`，和任务目录按同一个保留期清理（运行还有任务在 Agent 上时不动），见「安装 Agent」。0.0.4 之前的 Agent 不提供这个目录，SDK 取同样的位置，但旧 Agent 不会清理它。
- 本地调试时任务 ID 是 `local`、attempt 是 1、节点 ID 是节点名，`ctx.task.agents` 只有名称。`sfly run` 的运行 ID 是运行目录名，后台进程目录是项目下的 `.sfly/procs/<运行目录名>/`；`run_node` 的运行 ID 是 `local`，后台进程目录是工作目录下的 `procs/`。

## 取消与超时

- 用户取消运行、任务超时（默认 1 小时），或任务所在的子流程被场景里的停止子流程节点停止时，Agent 先写取消标记，再向任务的进程树发 SIGTERM。执行器把 SIGTERM 变成节点里抛出的 `sfly.Cancelled`。
- `Cancelled` 是 `BaseException` 的子类：`except Exception` 不会捕获它。清理代码写在 `finally` / `with` 里，会照常执行。
- 宽限期 10 秒，过后整棵进程树被强制杀掉。
- 后台线程里收不到异常，用 `ctx.cancelled()` 轮询任务是否已取消。
- 节点结束后还要存活的资源，由创建它的节点输出句柄，清理写成另一个节点，在场景里设为 always 节点（前面的节点失败或运行被取消时仍然执行）。

## `sfly.testing`：单元测试

```python
from pathlib import Path

from sfly.testing import run_node

from demo.example import countdown


def test_countdown(tmp_path: Path) -> None:
    result = run_node(countdown, {"name": "世界", "steps": 2, "interval": 0}, work_dir=tmp_path)

    assert result.status == "success", result.error
    assert result.outputs == {"greeting": "你好，世界", "ticks": 2}
    assert [(m.name, m.value) for m in result.metrics] == [("remaining", 1), ("remaining", 0)]


def test_countdown_cleans_up_when_cancelled(tmp_path: Path) -> None:
    result = run_node(
        countdown,
        {"name": "世界", "steps": 1000},
        cancel_when=lambda partial: bool(partial.progress),  # 第一次上报进度后取消
        work_dir=tmp_path,
    )

    assert result.status == "cancelled"
    assert "倒计时结束" in [line.message for line in result.logs]
```

`run_node(node, inputs=None, *, cancel_when=None, cancel_after=None, grace=10.0, work_dir=None, downloads=None)` 在子进程里用和 Agent 相同的执行器执行节点，等它结束后返回 `Execution`：

- `node`：`@node` 函数（模块顶层），或入口字符串 `"模块:函数"`。
- `inputs`：输入，先按类型注解校验，不通过时 `status` 为 failed、`error.kind` 为 config_error，节点不执行。
- `cancel_when(partial)`：执行中定期以到目前为止的结果调用，返回 True 时取消；`cancel_after`：开始后这么多秒取消。取消与平台相同：节点里抛出 `Cancelled`，宽限期 `grace` 秒后强制杀掉。
- `work_dir`：任务工作目录，默认新建一个临时目录（不自动删除）；测试里传 pytest 的 `tmp_path`。
- `downloads`：产物引用 → 本地内容，给 `ctx.artifacts.download` 用。内容是 bytes / str（按 UTF-8）时就是产物的内容，是路径（`Path`）时取该文件，写法与 `ctx.artifacts.save` 相同。没有列出的引用照常下载。

```python
def test_count_lines(tmp_path: Path) -> None:
    ref = "http://sfly.example/tasks/t-1/artifacts/server.log"

    result = run_node(
        count_lines, {"log_file": ref}, downloads={ref: "a\nb\n"}, work_dir=tmp_path
    )

    assert result.outputs == {"lines": 2}
```

| `Execution` 的字段 | 内容 |
|---|---|
| `status` | `success`、`failed` 或 `cancelled` |
| `outputs` | 输出（仅成功时），否则 None |
| `error` | `NodeError(kind, message, type, traceback)`；`kind` 是 `node_error`（异常）、`config_error`（输入不合法）或 `cancelled` |
| `logs` | `LogLine(ts, source, level, message)` 的列表；`source` 是 stdout、stderr 或 sdk |
| `progress` | `Progress(ts, current, total, message)` 的列表，保留每一次上报 |
| `metrics` | `MetricPoint(ts, name, kind, value, labels)` 的列表，保留每一次上报（未声明的、标签不合法的已丢弃）；`labels` 是这个点的标签（值都是字符串），不带标签时为 `{}` |
| `artifacts` | 产物名称 → 本地文件路径 |
| `artifacts_dir`、`work_dir` | 产物目录、工作目录 |

`ts` 是 Unix 毫秒时间戳。

## 命令行 `sfly`

在项目里用 `uv run sfly <命令>` 运行；每个命令的完整参数见 `uv run sfly <命令> --help`。需要控制面地址的命令按 `--server` > 环境变量 `SFLY_SERVER` > `~/.sfly/agent.env`（`SFLY_HOME`）里的 `SFLY_CONTROL_PLANE_URL` 取值，`install.sh --dev` 安装的开发机不用传 `--server`。

| 命令 | 作用 |
|---|---|
| `sfly init <目录> [--name <包名>]` | 创建节点包项目：uv 项目、控制面的镜像与 sfly 索引配置、开发依赖、示例节点和测试、节点开发 skill。包名默认是目录名 |
| `sfly run <节点> [--params '<JSON>']` | 本地调试：在当前项目环境里执行一个节点，不经过控制面和 Agent |
| `sfly dev [项目目录]` | 联调：把项目以 `<包名>@dev` 装到本机 Agent（通过本机 Agent 的本地 socket） |
| `sfly build [项目目录]` | 扫描 `@node`，构建节点包 `dist/<包名>-<版本>.sflypkg` |
| `sfly publish [项目目录或 .sflypkg]` | 发布到控制面；给项目目录时先构建 |
| `sfly skill update [--force]` | 把项目里的节点开发 skill 换成当前 SDK 版本的内容 |

### `sfly run`

```sh
uv run sfly run countdown --params '{"name": "世界", "steps": 5}'
```

- 日志实时打印到标准错误；结束后在标准输出打印输出值（`输出：` 后的 JSON）、指标汇总表和运行目录。指标汇总表每个序列一行，带标签的指标在指标名后面跟标签值，例如 `conn_latency_ms{host=db-1,port=5432}`。
- 每次运行一个新目录 `.sfly/runs/<时间>-<节点>/`（目录名也是 `ctx.task.run_id`；`ctx.procs_dir` 是 `.sfly/procs/<目录名>/`），里面有产物（`artifacts/`）、标准输出 / 标准错误的副本（`stdout.log`、`stderr.log`）；日志、进度和指标经命名管道 `events.fifo` 读取，不另存文件。
- `--download <产物引用> <文件>`：节点用 `ctx.artifacts.download` 下载这个产物引用时，得到这个本地文件的内容；可以重复给出。文件不存在时以 2 退出。例如 `uv run sfly run count_lines --params '{"log_file": "up"}' --download up ./server.log`。
- Ctrl-C 按平台的取消流程取消（节点里抛出 `Cancelled`，宽限期后强制杀掉），再按一次立即杀掉；节点结束后、打印结果期间的 Ctrl-C 被忽略。
- 退出码：成功 0，节点失败 1，参数不合法或找不到节点 2，取消 130。

### `sfly dev`

- 本机要有已连上控制面的 Agent（`install.sh --dev` 安装）。
- Agent 以可编辑方式安装本地源码，注册为 `<包名>@dev`；在场景里选这个版本和本机 Agent 运行。
- 只改函数体时，下一个任务直接用新代码；改了节点的参数、输出、指标声明、依赖或增删节点后重新运行 `sfly dev`。

### `sfly publish`

- 版本号取 `[project].version`。已发布的 `包名@版本` 不能覆盖：控制面拒绝时递增版本号再发布。

### `sfly skill update`

- 用当前安装的 SDK 带的内容整个替换 `.agents/skills/sfly-node-dev/`（`.claude/skills/sfly-node-dev` 是指向它的软链接，不存在时一并创建）。
- 目录内容和上次写入的不同时不覆盖，列出改动过的文件并以 1 退出；确认不需要这些改动后加 `--force`。自己的约定写在自己的其他 skill 里。
