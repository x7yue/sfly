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
- Agent 上 SDK 运行时的版本就是 Agent 的版本。`requires-sdk` 声明节点包需要的 SDK 版本，`sfly build` 把它写进节点包元信息的 `requires_sdk`；没写时用构建时 SDK 的版本作为下限（`>=<版本>`），`sfly init` 生成的项目写的是当时控制面的版本。格式是逗号分隔的比较符加数字版本号（`>=`、`>`、`<=`、`<`、`==`、`!=`、`~=`），例如 `>=0.0.4`。用到新版 SDK 才有的接口时调高它：派发到版本不满足的 Agent 时任务以 `env_error` 失败，错误信息写明需要的 SDK 版本和 Agent 的版本，提示升级 Agent；触发前检查也会给出同样的提示。

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
| `primary_metric` | 无 | 主指标名，必须是已声明的指标，显示在紧凑位置 |

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
| 没有注解、`Any`、`object` | 任意 JSON 值，不校验 |

- 有默认值的参数是可选输入，默认值必须能序列化为 JSON；没有默认值的是必填输入。
- 派发任务前按 schema 校验：缺少必填输入、或声明了的输入类型不符时，任务以 `config_error` 失败，节点不会执行。没有声明的输入不检查。
- 不支持的注解（例如自定义类）让 `sfly build` 报错。

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

## `ctx.progress`：进度

```python
ctx.progress(current, total=None, message="")
ctx.progress(3, 10, "第 3 批")
```

`current` 是当前值，`total` 是总数（未知时省略），`message` 是说明。可以频繁调用，Agent 按秒合并后上报。

## `ctx.metric`：指标

```python
Metric(name, unit="", kind="gauge", description=None)
Chart(title, type="line", metrics=())
ctx.metric("latency_ms", 12.5)
```

- 指标要先在 `@node(metrics=...)` 里声明再上报。指标名是标识符（字母、数字、下划线，不以数字开头），不能重复。
- `kind`：`gauge` 是瞬时值（例如延迟、队列长度），`counter` 是累计值（例如已发送的请求数，上报当前累计值）。
- `Chart.type`：`line`、`area`、`bar`、`stat`；`metrics` 列出至少一个已声明的指标。没有被任何图表引用的指标由平台生成默认图表。
- `ctx.metric` 可以随意频繁调用：Agent 按「指标 × 秒」合并，每秒最多上报一次（`gauge` 取这一秒最后一个值并带最小、最大值，`counter` 取这一秒结束时的值）。
- 未声明的指标名和非有限数值（NaN、无穷大）被丢弃，并写一条 warn 日志（每个指标名、每种原因只写一次）。

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
- **产物引用**：在 Agent 上是产物的下载地址，写进输出交给后续节点，后续节点可以直接下载（例如 `urllib.request.urlopen(ref)`）；本地调试时是本地文件路径。

## 取消与超时

- 用户取消运行或任务超时（默认 1 小时）时，Agent 先写取消标记，再向任务的进程树发 SIGTERM。执行器把 SIGTERM 变成节点里抛出的 `sfly.Cancelled`。
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

`run_node(node, inputs=None, *, cancel_when=None, cancel_after=None, grace=10.0, work_dir=None)` 在子进程里用和 Agent 相同的执行器执行节点，等它结束后返回 `Execution`：

- `node`：`@node` 函数（模块顶层），或入口字符串 `"模块:函数"`。
- `inputs`：输入，先按类型注解校验，不通过时 `status` 为 failed、`error.kind` 为 config_error，节点不执行。
- `cancel_when(partial)`：执行中定期以到目前为止的结果调用，返回 True 时取消；`cancel_after`：开始后这么多秒取消。取消与平台相同：节点里抛出 `Cancelled`，宽限期 `grace` 秒后强制杀掉。
- `work_dir`：任务工作目录，默认新建一个临时目录（不自动删除）；测试里传 pytest 的 `tmp_path`。

| `Execution` 的字段 | 内容 |
|---|---|
| `status` | `success`、`failed` 或 `cancelled` |
| `outputs` | 输出（仅成功时），否则 None |
| `error` | `NodeError(kind, message, type, traceback)`；`kind` 是 `node_error`（异常）、`config_error`（输入不合法）或 `cancelled` |
| `logs` | `LogLine(ts, source, level, message)` 的列表；`source` 是 stdout、stderr 或 sdk |
| `progress` | `Progress(ts, current, total, message)` 的列表，保留每一次上报 |
| `metrics` | `MetricPoint(ts, name, kind, value)` 的列表，保留每一次上报（未声明的已丢弃） |
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

- 日志实时打印到标准错误；结束后在标准输出打印输出值（`输出：` 后的 JSON）、指标汇总表和运行目录。
- 每次运行一个新目录 `.sfly/runs/<时间>-<节点>/`，里面有产物（`artifacts/`）、标准输出 / 标准错误的副本（`stdout.log`、`stderr.log`）；日志、进度和指标经命名管道 `events.fifo` 读取，不另存文件。
- Ctrl-C 按平台的取消流程取消（节点里抛出 `Cancelled`，宽限期后强制杀掉），再按一次立即杀掉。
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
