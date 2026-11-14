# 开发节点（SDK 参考）

节点包里的每个节点都是一个用 `@node` 声明的 Python 函数。发布后，sfly Agent 每执行一个任务就启动一个新的 Python 进程，导入节点函数，把输入作为关键字参数传进去，把返回值作为输出。

本页是 `sfly` SDK 的完整参考，也随 SDK 打进 `sfly init` 生成的项目（`.agents/skills/sfly-node-dev/reference.md`）。

## 项目结构

`sfly init` 生成的项目已经符合下面的约定：

| 位置 | 内容 |
|---|---|
| `pyproject.toml` 的 `[project]` | `name`（节点包名：小写字母、数字、`-`、`_`，以字母或数字开头）、`version`、`requires-python`（默认 `>=3.10`）、`dependencies` |
| `src/<模块>/` | 节点代码；模块名是包名把 `-` 换成 `_`。也可以是 `<模块>/` 或 `<模块>.py` |
| `pyproject.toml` 的 `[tool.sfly]` | `requires-sdk`：节点包需要的 SDK 版本，例如 `>=0.0.4`；`requires-agent`：需要的 Agent 版本，用到 Agent 能力时声明（见下文） |
| `[dependency-groups] dev` | `sfly[cli]`（锁定为控制面版本）、pytest、ruff |
| `tests/` | 单元测试（`sfly.testing`） |

- `sfly build` 导入模块及其全部子模块，收集其中的 `@node`。节点名在一个节点包里不能重复。
- 依赖只写在 `[project].dependencies`（pyproject 没有声明 dependencies 时读 `requirements.txt`）。Agent 上所有节点包共用一个 venv，只写宽松的下限。
- `sfly` 不能写进 `[project].dependencies`：Agent 自带 SDK 运行时，`sfly build` 遇到它直接报错。
- Agent 上 SDK 运行时的版本就是 Agent 的版本。`requires-sdk` 声明节点包需要的 SDK 版本，`sfly build` 把它写进节点包元信息的 `requires_sdk`；没写时用构建时 SDK 的版本作为下限（`>=<版本>`），`sfly init` 生成的项目写的是当时控制面的版本。格式是逗号分隔的比较符加数字版本号（`>=`、`>`、`<=`、`<`、`==`、`!=`、`~=`），例如 `>=0.0.4`。用到新版 SDK 才有的接口时调高它：派发到版本不满足的 Agent 时任务以 `env_error` 失败，错误信息写明需要的 SDK 版本和 Agent 的版本，提示升级 Agent。触发前检查比较的是控制面的版本（Agent 会先自更新到控制面的版本再执行任务），不满足时提示升级控制面。
- `requires-agent` 声明节点包需要的 Agent 版本，格式同 `requires-sdk`，`sfly build` 把它写进元信息的 `requires_agent`；没写时不检查。它同时约束节点所在的 Agent 和节点通过「Agent」类型的参数访问的 Agent，用到 Agent 能力（见下文「`ctx.agent()`：Agent 能力」）时声明（例如 `>=0.2.0`），见那一节的「版本」。从 SDK 0.2.0 起可用。

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
| `name` | 函数名 | 节点名，场景和 `sfly debug` 用它引用节点 |
| `title` | 节点名 | 画布上显示的名称。写成说明用途的名称（例如「HTTP 检查」「重启服务并等待就绪」），不要照抄函数名或写缩写 |
| `outputs` | 从返回类型读取 | 输出键：键名列表，或 键名 → 类型注解 的字典 |
| `metrics` | 无 | 指标声明（`Metric`），最多 50 个 |
| `charts` | 无 | 图表声明（`Chart`），最多 20 张 |
| `primary_metric` | 无 | 主指标名，必须是已声明、不带标签键的指标，显示在紧凑位置 |

### 节点类型的说明

函数的文档字符串就是节点类型的说明：`sfly build` 去掉缩进后整段写进元信息里这个节点类型的 `description`，会显示在画布上：

- 「添加节点」菜单和节点包管理页：在节点类型的标题下面显示第一段，帮人挑对节点；
- 检查器的「说明」页：按纯文本显示全文，不渲染 Markdown，空行分隔的段落原样保留。

```python
@node(title="HTTP 检查")
def http_check(ctx: Context, url: str, expect: int = 200) -> CheckOutputs:
    """请求一个地址，检查返回的状态码是否符合预期。

    只发一次 GET 请求，不跟随重定向。连接超时或状态码不符时失败，失败不会重试。
    """
```

- 第一段写这个节点做什么，一两句话；后面的段落写副作用、什么情况下失败。输入和输出的名字、类型画布上已经有，不用在这里重复。
- 最长 4000 个 Unicode 字符（emoji 算一个），超过时 `sfly build` 报错并指出是哪个节点。没有文档字符串（或只有空白）时不写这个字段，也不报错；已发布的旧版本节点包没有说明，照旧显示。
- 控制面要先升级：节点类型的 `description` 是元信息新增的字段，旧版本的控制面严格检查元信息，会以「元信息校验失败」拒绝带文档字符串的节点包。用新版 SDK 构建、发布之前，先把控制面升级到同一个版本；Agent 把元信息当作 JSON 原样转发，不受影响。

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
| `Annotated[T, ...]` | 同 `T`；例外是 `Doc`：它给这个输入写说明，见下文「输入的说明：`Doc`」 |
| `sfly.AgentName` | 「Agent」类型：Agent 名称（字符串），见下文 |
| `sfly.FeishuBot` | 「飞书机器人」类型：飞书机器人的名称（字符串），见下文 |
| 没有注解、`Any`、`object` | 任意 JSON 值，不校验 |

- 有默认值的参数是可选输入，默认值必须能序列化为 JSON；没有默认值的是必填输入。
- 派发任务前按 schema 校验：缺少必填输入、或声明了的输入类型不符时，任务以 `config_error` 失败，节点不会执行。没有声明的输入不检查。
- 不支持的注解（例如自定义类）让 `sfly build` 报错。

### 输入的说明：`Doc`

```python
from typing import Annotated

from sfly import Context, Doc, node


@node
def http_check(
    ctx: Context,
    url: Annotated[str, Doc("请求地址，带协议")],
    expect: Annotated[int, Doc("期望的状态码")] = 200,
    verify_tls: bool = True,
) -> dict:
    ...
```

用 `Annotated[类型, Doc("…")]` 给输入写说明。`sfly build` 把它写成这个输入 schema 的 `description`，画布的检查器在输入框下面显示完整的说明，节点包管理页悬停在输入的名字上也能看到，`sfly package show` 的「说明」列里也有。参数的标签仍然是参数名，说明是帮助文字。说明跟着参数走，改参数名不会丢。

- 写给搭场景的人看：这个输入是什么意思、单位是什么、怎么填。不要重复参数名和类型。
- 必须是非空字符串，首尾空白不保存，最多 500 个 Unicode 字符（不是字节）。可以换行，检查器里照样显示成多行。
- 写在参数注解的最外层，一个注解里只能有一个：可选参数写成 `Annotated[str | None, Doc("…")] = None`，不要写成 `Annotated[str, Doc("…")] | None` 或 `list[Annotated[str, Doc("…")]]`。`Annotated` 里的其他元数据照旧不起作用，`Doc` 是唯一的例外。
- 任务上下文 `ctx` 不是输入，不能写 `Doc`。
- 「Agent」类型和「飞书机器人」类型的输入也能写：`Annotated[AgentName, Doc("…")]`。
- 没写说明不报错、不警告：旧版本的节点包和没写说明的输入，在画布上照旧显示。
- `Doc` 写错时，`sfly build` 报错并指出节点和参数，例如 `节点 demo_checks.http_check 的参数 url：Doc 必须是非空字符串，收到 ''`。`sfly dev`、`sfly debug` 和 `sfly.testing.run_node` 用同一套扫描，结果一样。报错的情况：不是非空字符串、同一个注解里有两个、写在 `ctx` 上、写在 `list[...]`、`|` 等的里面、超过 500 个字符。

这个写法从 SDK 0.4.0 起可用。用到它的节点包把 `requires-sdk` 调到 `>=0.4.0`：节点运行时要从 `sfly` 导入 `Doc`，更旧的 Agent 上没有它，声明之后任务在派发前就以 `env_error` 失败并提示升级，不会运行到一半才报错。

### 「Agent」类型的输入

```python
from sfly import AgentName, Context, node


@node(outputs=["files"])
def clean(ctx: Context, source: AgentName, backup: AgentName | None = None) -> dict:
    """source 是日志所在的 Agent，节点在另一台 Agent 上清洗它的日志。"""
    logs = list(ctx.agent(source).files.list("/var/log/app", "app.log.*"))
    ctx.log.info("Agent %s 上有 %d 个轮转出来的日志", source, len(logs))
    ...
```

把输入参数标成 `AgentName`，表示节点会访问这台 Agent。`AgentName` 在运行时就是 `str`：节点收到的值是 Agent 名称。可以写成 `AgentName | None`（可选参数）；不能用在列表、字典或输出里，`sfly build` 会报错。

这个类型从 SDK 0.2.0 起可用。用到它的节点包把 `requires-sdk` 调到 `>=0.2.0`：更旧的 Agent 上没有这个类型，声明之后任务在派发前就以 `env_error` 失败并提示升级，不会运行到一半才报错。

- `sfly build` 在输入 schema 里标记它：`{"type": "string", "x-sfly-type": "agent"}`。
- 画布的检查器里它是 Agent 下拉框，列出已注册的 Agent 及在线状态；也可以点右侧的 `{}`（插入引用）改为引用入口参数。
- 选的 Agent 必须已注册（不要求在线）：常量不是已注册的 Agent 时保存给出警告、触发前的预检阻断，并指出是哪个节点的哪个参数；引用入口参数时按触发时传入的实际值检查；值来自前面节点的输出时在派发时检查，没有注册过时任务以 `config_error` 失败。目标 Agent 不在线不阻断：节点运行时连不上它，访问它的那一步才会失败。
- 派发任务时，控制面把这些 Agent 的地址和端口随任务下发给节点所在的 Agent。节点用 `ctx.agent(名称)` 访问它们（见下文「`ctx.agent()`：Agent 能力」），不用自己处理地址。地址在派发时解析：Agent 重新注册换了地址后，之后派发的任务用新地址。
- 本地调试（`sfly debug`、`sfly.testing.run_node`）照常接受这种参数，值就是 Agent 名称，不检查它是否注册过；要访问它时把它映射到本地目录（见下文「本地调试、测试与联调」）。

### 「飞书机器人」类型的输入

```python
from sfly import Context, FeishuBot, node


@node(outputs=["passed"])
def stress(ctx: Context, qps: int, alert_bot: FeishuBot | None = None) -> dict:
    """alert_bot 是出问题时要通知的飞书机器人，在检查器里从已登记的机器人中选。"""
    ...
```

把输入参数标成 `FeishuBot`，表示节点会通过这个飞书机器人发通知，不用把机器人的名称写死在代码里。`FeishuBot` 在运行时就是 `str`：节点收到的值是机器人的名称。可以写成 `FeishuBot | None`（可选参数）；不能用在列表、字典或输出里，`sfly build` 会报错。

这个类型从 SDK 0.3.0 起可用。用到它的节点包把 `requires-sdk` 调到 `>=0.3.0`：更旧的 Agent 上没有这个类型，声明之后任务在派发前就以 `env_error` 失败并提示升级，不会运行到一半才报错。

- `sfly build` 在输入 schema 里标记它：`{"type": "string", "x-sfly-type": "feishu_bot"}`。
- 画布的检查器里它是飞书机器人下拉框，列出「飞书机器人」页登记的机器人；也可以点右侧的 `{}`（插入引用）改为引用入口参数，触发时再决定发到哪个群。
- 选的机器人必须已登记：常量不是已登记的机器人时保存给出警告、触发前的预检阻断，并指出是哪个节点的哪个参数；引用入口参数时按触发时传入的实际值检查。值来自前面节点的输出时派发时不检查：机器人没有登记也照常派发，通知不会成为任务失败的原因。
- 派发任务时，控制面把任务通过这种参数引用的机器人名单（不重复）随任务下发。节点只能向名单里的机器人发通知（见下文「`ctx.notify`：飞书通知」）。
- 删除机器人之前，「飞书机器人」页列出引用它的场景，包含这种参数的常量值。
- 本地调试（`sfly debug`、`sfly.testing.run_node`）照常接受这种参数，值就是机器人名称，不检查它是否登记过。

## 输出

- 用 TypedDict 返回类型声明输出键和类型；或用 `@node(outputs=...)` 声明。
- 返回值必须是 dict，序列化为 JSON 后不超过 1 MB；返回 `None` 视为空对象。不满足时任务失败。
- 后续节点可以引用输出里的值；大块数据存成产物，输出里放产物引用。
- 输出里的 NUL 字符（`\x00`）保存时换成 U+FFFD（�），后续节点引用到的是替换后的值；错误信息、进度说明和指标标签也是这样（docs/SEMANTICS.md §2.5）。二进制内容存成产物。

### 输出的说明：`Doc`

```python
from typing import Annotated, TypedDict

from sfly import Doc


class CheckOutputs(TypedDict):
    status: Annotated[int, Doc("HTTP 状态码")]
    body_file: Annotated[str | None, Doc("响应体保存的文件；响应没有正文时为 None")]
    elapsed_ms: float
```

输出字段也用 `Annotated[类型, Doc("…")]` 写说明，规则和输入的 `Doc` 一样（见上文「输入的说明：`Doc`」）：写在字段注解的最外层，一个注解里只能有一个，必须是非空字符串，首尾空白不保存，最多 500 个 Unicode 字符，没写不报错。`sfly build` 把它写成这个输出 schema 的 `description`。

搭场景的人在四个地方看到它：检查器「说明」标签页里的「输出 | 说明」表、引用补全里这个输出的后面、节点包管理页悬停在输出的名字上，以及 `sfly package show` 输出表的「说明」列。没写说明的输出，这些地方照旧只显示名字和类型。

- 写给要引用这个输出的人看：它装的是什么、单位是什么、什么情况下是空。不要重复字段名和类型。
- `NotRequired[...]`、`Required[...]` 包在 `Annotated` 外面或里面都行：`NotRequired[Annotated[int, Doc("…")]]`。
- 用 `@node(outputs={...})` 声明输出时，字典的值也能这样写：`outputs={"rows": Annotated[int, Doc("写入的行数")]}`。键名列表的写法没有地方写说明。
- `Doc` 写错时 `sfly build` 报错并指出节点和输出，例如 `节点 demo_checks.http_check 的输出 status：Doc 必须是非空字符串，收到 ''`。`sfly dev`、`sfly debug` 用同一套扫描，结果一样（`sfly.testing.run_node` 只检查输入，不检查输出）。

和输入的 `Doc` 同一个版本（SDK 0.4.0）起可用，`requires-sdk` 的要求也一样。

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
- 每行日志带两种时间：Agent 时间（执行任务的那台机器的系统时间，方便和被测系统自己的日志对照）和控制面时间。运行监控页的日志时间列默认显示 Agent 时间，可以切换成控制面时间；点一行在时间线上定位、框选时间范围筛选日志，用的都是控制面时间。下载的日志每行两种时间都有：`agent_time` 和 `time`（控制面时间）。升级之前写入的日志只有 Agent 时间，`time` 为空，这些行不能在时间线上定位。同一个任务内，一行折算出的控制面时间比上一行早不到 2 秒时（断线重连后偶尔会早几毫秒，量级是一次网络往返）记成与上一行相同；早得更多说明折算出了错，保留折算出的时间。在运行监控页的时间线上没选中节点时，日志页签把多个节点的日志合并显示：图表工作区设置了节点筛选时是筛选出的节点，没有设置时是整次运行全部节点。日志按控制面时间排列（同一个任务内保持输出的先后顺序），每行标出来源节点：「子流程名 / 节点 ID #尝试序号」，主链上的节点省略子流程名，只有一次尝试的节点省略尝试序号；点来源节点名会选中这个节点，切到它的单节点日志。可以按日志级别筛选；向上滚动可以一直加载到运行开始。运行执行中时新输出实时出现，之后才开始的节点、重试和子流程也包括在内；某台 Agent 断线重连后补发的行按控制面时间插到它应在的位置，不会都堆在最下面。合并视图下的下载按钮把当前范围内整次运行的日志下载成一个合并好的 JSONL 文件（文件名 `run-<运行 ID>.log.jsonl`），行的顺序与合并视图相同，不受级别筛选影响，只包含点击下载那一刻已写入的内容。每行是一个 JSON 对象：`seq`（任务内的序号）、`time`（控制面时间）、`agent_time`（Agent 时间）、`source`、`level`、`text`，加上这一行的来源：`task_id`、`subflow`（子流程名，主链上的节点为 `null`）、`node_id`、`attempt`（第几次尝试，从 1 开始）。升级之前写入的日志没有控制面时间，`time` 为 `null`。

## `ctx.progress`：进度

```python
ctx.progress(current, total=None, message="")
ctx.progress(3, 10, "第 3 批")
```

`current` 是当前值，`total` 是总数（未知时省略），`message` 是说明。可以频繁调用，Agent 按秒合并后上报。

## `ctx.notify`：飞书通知

```python
import sfly
from sfly import Context, FeishuBot, node


@node(outputs=["passed"])
def stress(ctx: Context, qps: int, alert_bot: FeishuBot) -> dict:
    ...
    if p99 > 500:
        ctx.notify(alert_bot, f"p99 {p99} ms，超过 500 ms", at_all=True)
        ctx.notify(
            alert_bot,
            message=sfly.feishu.card("压测告警", f"**p99** {p99} ms，超过 500 ms", "red"),
        )
    ...
```

```python
ctx.notify(bot, text, *, at_all=False)   # 发文本
ctx.notify(bot, message=...)             # 发原始消息：完整的飞书请求体
sfly.feishu.card(title, markdown, color="blue")   # Markdown 卡片的请求体
```

`ctx.notify` 给飞书机器人 `bot` 发一条消息，调用后立即返回。`text` 和 `message` 二选一，对应飞书通知节点的三种格式（见 [飞书通知](feishu-notify.md)）：

| 写法 | 发出的请求体 |
|---|---|
| `ctx.notify(bot, text)` | 文本：`{"msg_type": "text", "content": {"text": ...}}`。`at_all=True` 时在正文末尾加上「@所有人」；正文里自己写的 `<at user_id="ou_xxx">名字</at>` 原样发出。请求体超过 20 KB 时截断正文，末尾加上「…（已截断）」，「@所有人」仍在最后 |
| `ctx.notify(bot, message=sfly.feishu.card(...))` | Markdown 卡片：和画布上飞书通知节点的「Markdown 卡片」格式一样 |
| `ctx.notify(bot, message={...})` | 原始消息：你给的请求体，原样发出，不改写、不补字段。富文本（`post`）、自己设计的卡片、模板卡片都走这一种 |

- **投递失败永远不会抛出异常**：消息由控制面发出（ADR 0020），`ctx.notify` 只把它交给 Agent，不访问网络、不等结果。飞书不可达、返回错误、机器人已被删除时，节点照常执行，不会因为通知失败或变慢。只有调用的写法不对时抛出 `TypeError`：`bot` 不是字符串，`text` 和 `message` 同时给或都不给，`text` 不是字符串，`at_all` 不是布尔值，发原始消息时还给了 `at_all`（它只对文本有意义，要 @所有人就写在消息里）。
- `bot` 必须是通过「飞书机器人」类型的参数（`sfly.FeishuBot`，见上文）传给节点的机器人名称。其他名称（写死在代码里的、普通字符串参数传进来的）不发送，任务日志里写一条 warning，提示把它声明成 `FeishuBot` 参数；机器人没有登记时同样。
- **原始消息的校验**与飞书通知节点的原始消息相同：只检查它是一个对象（JSON 对象，写成 `dict`）、`msg_type` 是 `text`、`post`、`image`、`share_chat`、`interactive` 之一、整个请求体不超过 20 KB（紧凑 JSON 按 UTF-8 编码的字节数）。不合格的**不发送、不截断**（截断会弄坏结构），任务日志里写一条 warning 说明原因（来源是 system，例如「ctx.notify 的消息没有发送：原始消息的 msg_type 必须是 text、post、image、share_chat、interactive 之一」），`ctx.notify` 不抛异常。图片消息只能用自己已有的 `image_key`，平台不上传图片。
- **`sfly.feishu.card(title, markdown, color="blue")`** 返回 Markdown 卡片的请求体（`msg_type: interactive`，卡片 JSON 2.0：header 是标题加颜色，正文是一个 Markdown 元素），拿去给 `message=` 就能发。`color` 是 `blue`（默认）、`green`、`orange`、`red`、`grey` 之一。标题和正文照原样放进去，不做 Markdown 转义，空字符串也照常组装；请求体超过 20 KB 时截断 Markdown 正文，末尾加上「…（已截断）」。它和控制面使用同一套组装规则和同一组用例，保证代码里发的卡片和画布上的 Markdown 卡片一样。`title`、`markdown` 不是字符串抛出 `TypeError`，`color` 不是上面五种之一、或者标题长到连截断后的正文都放不下时抛出 `ValueError`：这些是写法上的错误，开发时就会看到。
- 投递结果写进这个任务的日志，来源是 system：送达是 info，失败（写明原因和下一步）或被丢弃是 warning。同一个机器人的消息按调用的先后串行发出、限速（ADR 0020）。
- Agent 和控制面断开期间，通知和日志一样在 Agent 上排队，重连后发出。
- 本地调试不真的发送：`sfly debug` 把要发给哪个机器人、请求体是什么打印出来；`sfly.testing.run_node` 的结果里有 `notifications`，原始消息和卡片的请求体都在里面（见下文）。和平台一样，不是通过「飞书机器人」参数传入的机器人、不合格的原始消息不记录，日志里写一条 warning。

这个接口（包括 `message=` 和 `sfly.feishu.card`）从 SDK 0.3.0 起可用。用到它的节点包把 `requires-sdk` 和 `requires-agent` 都调到 `>=0.3.0`：更旧的 Agent 上没有这个接口，也不会转发通知；声明之后任务在派发前就以 `env_error` 失败并提示升级，不会运行到一半才报错。

## `ctx.metric`：指标

```python
Metric(name, unit="", kind="gauge", description=None, labels=())
Chart(title, type="line", metrics=())
ctx.metric("latency_ms", 12.5)
ctx.metric("conn_latency_ms", 8.2, labels={"host": "db-1", "port": 5432})
```

- 指标要先在 `@node(metrics=...)` 里声明再上报。指标名是标识符（字母、数字、下划线，不以数字开头），不能重复。
- `description`：一句话写这个指标量的是什么、怎么统计（例如「每秒成交的笔数，只算成功的订单」），单位另有 `unit`，不用重复。它显示在节点包管理页「声明的指标」列的悬停提示里，以及检查器「说明与指标」页的指标列表里；没写不报错。
- `kind`：`gauge` 是瞬时值（例如延迟、队列长度），`counter` 是累计值（例如已发送的请求数，上报当前累计值）。
- `Chart.type`：`line`、`area`、`bar`、`stat`；`metrics` 列出至少一个已声明的指标。没有被任何图表引用的指标由平台生成默认图表：瞬时值画折线，累计值画数值卡，带标签的指标一律画折线。
- `labels`：标签键，用来在一个节点里同时上报多个对象的同一个指标（例如每个连接、每个进程）。最多 3 个键，命名规则同指标名，不能重复；`sfly build` 检查这些规则。
- 上报时 `labels` 给出这个点的标签值。一个指标在一组确定的标签值下的全部点是一个**序列**，运行监控页的折线和面积图里每个序列画一条线，图例用标签值以「 · 」连接（按声明的标签键顺序），图表引用多个指标时前面再加上指标名。不带标签的指标仍然只有一个序列。平台不对多个序列求和或求平均，需要合计时另报一个不带标签的指标。
- 带标签的指标只能画在 `line`、`area` 图表里，同一张图表可以混用带标签和不带标签的指标（例如把「合计」和「各进程」画在一起）；`stat`（数值卡）和 `bar`（柱状图）不能引用带标签的指标，带标签的指标也不能作为 `primary_metric`，需要时另报一个不带标签的合计指标作为主指标。`sfly build` 和控制面发布时都检查这些约束。
- 在运行监控页上点图例项可以显示或隐藏对应的线；序列超过 10 个时，默认只显示当前时间范围内平均值最高的 10 个，其余在图例里置灰。悬停时提示列出每条显示中的线在那一刻的值，以及这个点的控制面时间和 Agent 时间（图表的横轴是控制面时间；Agent 时间是节点所在机器当时的时间，机器的时间被改过时两者不同）。
- 声明了标签键的指标，每个点都要给全这些键；没声明标签键的指标不能带标签。标签值是不超过 128 个字符的非空字符串，数字自动转成字符串。
- `ctx.metric` 可以随意频繁调用：Agent 按「序列 × 秒」合并，每秒最多上报一次（`gauge` 取这一秒最后一个值并带最小、最大值，`counter` 取这一秒结束时的值）。
- 以下点被丢弃，并写一条 warn 日志（每个指标名、每种原因只写一次）：未声明的指标名、非有限数值（NaN、无穷大）、缺少声明过的标签键、带了未声明的标签键、给没声明标签键的指标带标签、标签值为空或超过 128 个字符。
- **序列上限**：每个任务所有指标合计最多 1000 个序列，不带标签的指标各算 1 个（预先占好名额，总是能上报）。这个数固定，不能配置。超出后不再建立新序列：新序列的点被丢弃，每个指标写一条 warn 日志；已经有的序列照常上报。控制面也按同一上限兜底，被拒的点计入任务的丢弃数，运行监控页显示「序列超限」。本地调试（`sfly debug`、`sfly.testing`）的行为相同。标签值用来区分少量对象（进程、网卡、连接），不要用请求 ID、时间戳这类取值很多的值。序列上限和单任务约 50 MB 的点数上限互不影响。

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
- 本地调试没有控制面。本地保存的产物的引用是本地文件路径，`download` 直接复制；要测试「下载上游节点给的引用」时，给这个引用指定本地内容：`run_node(downloads={引用: 内容})` 或 `sfly debug --download <引用> <文件>`（见下文），节点下载它时得到这份内容，不访问网络。

## `ctx.task` 与 `ctx.procs_dir`：任务信息与后台进程目录

```python
ctx.task.run_id     # 运行 ID
ctx.task.node_id    # 场景里的节点 ID（同一个节点类型出现多次时各不相同）
ctx.task.task_id    # 任务 ID
ctx.task.attempt    # 第几次尝试，从 1 开始，重试时加 1

log = ctx.procs_dir / f"{ctx.task.node_id}.log"
log.parent.mkdir(parents=True, exist_ok=True)
```

- `ctx.procs_dir` 是这次运行的**后台进程目录**：节点启动的、节点结束后还要继续运行的进程，把日志等文件放在这里。它不在任务目录里，任务目录被清理或任务重试时不受影响；同一次运行的任务共用一个目录（用节点 ID 区分文件名）。目录不一定已经存在，使用前自己创建。
- 在 Agent 上是 `$SFLY_HOME/procs/<运行 ID>/`，和任务目录按同一个保留期清理（运行还有任务在 Agent 上时不动），见「安装 Agent」。0.0.4 之前的 Agent 不提供这个目录，SDK 取同样的位置，但旧 Agent 不会清理它。
- 本地调试时任务 ID 是 `local`、attempt 是 1、节点 ID 是节点名。`sfly debug` 的运行 ID 是运行目录名，后台进程目录是项目下的 `.sfly/procs/<运行目录名>/`；`run_node` 的运行 ID 是 `local`，后台进程目录是工作目录下的 `procs/`。

## `ctx.agent()`：Agent 能力

```python
from sfly import AgentFileNotFound, AgentName, Context, node


@node(outputs=["logs", "current_size"])
def find_logs(ctx: Context, source: AgentName, directory: str = "/var/log/app") -> dict:
    """source 是日志所在的 Agent；这个节点派到另一台 Agent 上运行。"""
    logs = [
        {"path": f.path, "size": f.size, "inode": f.id.inode}
        for f in ctx.agent(source).files.list(directory, "app.log*", recursive=True)
    ]
    try:
        current = ctx.agent(source).files.stat(f"{directory}/app.log", timeout=10)
    except AgentFileNotFound:
        current = None
    return {"logs": logs, "current_size": current.size if current else None}
```

Agent 能力是 Agent 自身提供、节点在执行中调用的一组操作。`ctx.agent()` 是节点自己所在的 Agent，`ctx.agent(名称)` 是另一台 Agent，两者是同一种对象（`sfly.Agent`），方法和写法相同：同一段代码不管文件在本机还是在别的机器上都能用。

这一组接口从 SDK 0.2.0 起可用。用到它的节点包把 `requires-sdk` 和 `requires-agent` 都调到 `>=0.2.0`（见下文「版本」）。

- 名称是「Agent」类型的参数的值（见上文「「Agent」类型的输入」）。节点只能访问这样拿到的 Agent 和自己所在的 Agent：访问其它名称时调用抛出 `sfly.AgentNotReferenced`，要把那台 Agent 声明成节点的 `AgentName` 参数。`ctx.agent(None)` 等于 `ctx.agent()`：可选的 `AgentName | None` 参数没有选时就是自己所在的 Agent。
- 调用另一台 Agent 时，SDK 把调用交给自己所在的 Agent，由它直接连到那台 Agent（用控制面随任务下发的地址和端口，就是 Agent 页面上显示的），数据不经过控制面。两台 Agent 之间要能连通（防火墙放行那台 Agent 的端口，默认 50052）。这些接口没有认证，只应在内网使用。
- 路径都是那台 Agent 所在机器上的绝对路径，相对路径抛出 `ValueError`。权限就是那台 Agent 进程的权限，不做沙箱。
- 调用另一台 Agent 比调用本机慢，而且会失败（连不通、对方版本太旧）：处理可能的异常，按需重试。
- 完整的例子（在 B 上持续清洗 A 上轮转出来的日志：监听、下载、删除，场景怎么编排，怎样判断文件不再续写）见 [跨 Agent 处理文件](cross-agent-files.md)。

### 文件：`files`

| 方法 | 说明 |
|---|---|
| `files.list(directory, pattern="*", *, recursive=False, timeout=30.0)` | 列出目录下文件名匹配通配符的普通文件，返回 `FileInfo` 的迭代器 |
| `files.stat(path, *, timeout=30.0)` | 查看一个文件（或目录）的属性，返回 `FileInfo`；跟随符号链接 |
| `files.read(path, offset=0, length=None, *, timeout=30.0)` | 从 `offset` 起流式读取文件内容，返回 `bytes` 的迭代器，见下文「读取与下载」 |
| `files.download(path, local_path, *, timeout=30.0, progress=None)` | 把文件下载到节点所在机器上的 `local_path`，返回源文件的 `FileInfo`，见下文「读取与下载」 |
| `files.watch(directory, pattern="*", *, recursive=False, timeout=30.0)` | 监听目录：先给出当前文件的快照，再持续给出事件（迭代器），见下文「监听目录」 |

`files.list`：

- `pattern` 只匹配文件名（不含目录），规则与 Python 的 `fnmatch.fnmatchcase` 相同：`*` 任意字符串、`?` 任意一个字符、`[a-z]` / `[!0-9]` 字符集合，区分大小写，`*` 也匹配以 `.` 开头的名字。
- 只列出普通文件（指向普通文件的符号链接也算，判断时跟随符号链接）。`recursive=True` 时进入子目录，不进入指向目录的符号链接。
- 顺序固定：同一个目录里的文件按名称排序，先给出这个目录里的文件，再按名称依次进入子目录。
- 列出期间被删除的文件、没有权限进入的子目录跳过；`directory` 本身不存在、不是目录或没有权限时抛出异常。
- 迭代时才发起调用（参数不合法时调用 `list` 就抛出 `ValueError`）；中途停止迭代时调用随之放弃。

`FileInfo` 的字段：

| 字段 | 内容 |
|---|---|
| `path` | 那台 Agent 所在机器上的绝对路径 |
| `size` | 字节数 |
| `mtime_ns`、`mtime` | 修改时间：Unix 纳秒（int）、Unix 秒（float） |
| `id` | 文件标识 `FileId(device, inode)`：设备号 + inode。文件被改名（日志轮转）后不变，删除后重建会变，用来判断「还是不是同一个文件」，可以作为字典的键 |

修改时间是那台机器的 Agent 时间，原样给出，不换算：两台机器的时钟不一定一致，判断「多久没有修改」时不要直接和本机的 `time.time()` 比较，比较同一台 Agent 上前后两次 `stat` 的结果。

### 读取与下载：`files.read`、`files.download`

```python
import hashlib

from sfly import AgentName, Context, node


@node(outputs=["sha256", "local"])
def pull_log(ctx: Context, source: AgentName, path: str = "/var/log/app/app.log.1") -> dict:
    source_files = ctx.agent(source).files
    # 流式读取：只读开头 1 MB，不用先整个下载。
    digest = hashlib.sha256()
    for chunk in source_files.read(path, length=1024 * 1024):
        digest.update(chunk)
    # 下载到本地（相对路径相对于任务目录），连接中断时自动续传。
    info = source_files.download(path, "logs/app.log.1", timeout=60)
    return {"sha256": digest.hexdigest(), "local": {"path": "logs/app.log.1", "size": info.size}}
```

从 SDK 0.2.0 起可用，需要那台 Agent 支持能力 `files.read`（同一版本的 Agent 都有；更旧的抛出 `AgentUnsupported`）。

`files.read`：

- 从第 `offset` 个字节开始，逐块（每块最多 256 KiB）给出内容，读到 `length` 字节或文件末尾为止；`length=None` 读到末尾。`offset` 超过文件末尾时没有内容，不报错。
- 读的是迭代到那一刻文件里已有的内容：文件还在被写入时，读到当时写下的部分。只读新增的部分时，记下上次读到的位置作为下一次的 `offset`（配合 `FileInfo.id` 确认还是同一个文件）。
- 迭代时才发起调用（参数不合法时调用 `read` 就抛出 `ValueError`）；文件不存在、是目录或没有权限时迭代时抛出异常。中途停止迭代时调用随之放弃。
- 内容经节点所在的 Agent 交给节点进程，适合边读边处理；要把整个大文件放到本地时用 `files.download`。

`files.download`：

- 数据由节点所在的 Agent 从那台 Agent 读出后直接写到 `local_path`，不经过节点进程（`ctx.agent()` 时是本机上的复制）。节点进程只收到进度和结果，大文件的传输不受 Python 的速度影响。
- `local_path` 是节点所在机器上的路径，相对路径相对于节点的工作目录（任务目录）。所在的目录不存在时一并创建；那里已有的文件被替换。
- 先写同一目录里的临时文件（`.<文件名>.sfly-<随机>.tmp`，与 `files.write` 相同），完成、核对并落盘后才改名为 `local_path`：`local_path` 上不会出现半截文件，那里已有的文件替换后保留权限位。下载失败、任务被取消时临时文件被删除。处理本地目录的节点要跳过以 `.` 开头的文件。
- 下载的是开始时打开的那个文件、开始时的大小，内容都从打开的文件读。下载期间它被改名（例如日志按序号轮转，`app.log.1` 改名为 `app.log.2`）不影响下载。
- 完成时按这个文件核对，本地文件与它的大小一致才算完成：它在下载期间被删除时抛出 `AgentFileNotFound`；被截短、大小变了（还在写入）时抛出 `AgentError`，消息写明是哪一种。只下载已经不再写入的文件：判断文件是否写完是节点自己的事，平台不提供。
- 两台 Agent 之间的连接中断（网络断开、那台 Agent 重启）时自动重连，从已经写下的位置继续读同一个文件，不从头开始；连续多次重连都没有进展时抛出异常（通常是 `AgentUnreachable`）。重连时它已经不在 `path` 上：在同一目录里改了名的，接着读新路径上的它；路径上换成了另一个文件、在同一目录里也找不到它（被移到了别的目录）时抛出 `AgentFileMoved`，路径上没有文件时抛出 `AgentFileNotFound`。知道它去了哪里时（例如 `files.watch` 的 `moved` 事件），用新路径重新下载。
- 这几种「源文件变了」的情况各有 `kind`：被删除是 `not_found`，被截短、大小变了是 `failed`，续传时被移走是 `moved`：可以据此把这个文件留到之后再下载（例如等它不再写入，或等 `files.watch` 告诉你它的新路径），其它失败按下文「超时、取消与错误」的表区分。
- 返回下载完成时源文件的 `FileInfo`：`size` 就是本地文件的字节数，`path` 是它现在的路径（下载期间在同一目录里改了名时是新路径；移到了别的目录时仍是 `path`），`id` 可以用来判断以后是不是同一个文件（例如只下载一次）。
- `progress(downloaded, size)`：下载期间不时被调用（在 Agent 上大约每秒一次，本地调试时每块一次），参数是已经下载的字节数和要下载的字节数，可以用来上报进度或速率；它在调用 `download` 的线程里执行。
- `timeout` 是相邻两次进展之间最多等多久，不是整个下载的时长：几个 GB 的文件用默认的 30 秒也可以。

### 写入、上传与删除

```python
from sfly import AgentFileNotFound, AgentName, Context, node


@node(outputs=["marker"])
def clean_log(ctx: Context, source: AgentName, path: str) -> dict:
    """把 source 上的日志下载到本机清洗后，把结果放回去、删掉源文件。"""
    ...  # 清洗，得到本机上的 cleaned.log
    ctx.agent(source).files.upload("cleaned.log", f"{path}.cleaned")
    marker = ctx.agent(source).files.write(f"{path}.done", b"cleaned\n")
    try:
        ctx.agent(source).files.delete(path)
    except AgentFileNotFound:
        pass  # 已经被别人删掉了
    return {"marker": marker.path}
```

| 方法 | 说明 |
|---|---|
| `files.write(path, data, *, timeout=30.0)` | 把 `data` 写成那台 Agent 上的文件 `path`，返回写好的文件的 `FileInfo` |
| `files.upload(local_path, path, *, timeout=30.0)` | 把节点所在机器上的文件 `local_path` 上传成那台 Agent 上的 `path`，返回 `FileInfo` |
| `files.delete(path, *, timeout=30.0)` | 删除那台 Agent 上的文件 `path` |

从 SDK 0.2.0 起可用，需要那台 Agent 支持能力 `files.write`（0.2.0 及以上的 Agent）。

- `data` 是字节（`bytes`、`bytearray`、`memoryview`），或逐段给出字节的可迭代对象（例如生成器）：边取边发，不用先把整个文件放进内存。文本先 `encode()`；传 `str` 抛出 `TypeError`。
- 写入和上传都先写到 `path` 所在目录里的临时文件（`.<文件名>.sfly-<随机>.tmp`），全部写完才改名为 `path`。所以 `path` 上要么是原来的文件，要么是完整的新文件，读它的人不会读到半截：
  - `path` 已存在时整个替换，保留它的权限位；`path` 是符号链接时替换链接本身；
  - 写到一半出错（包括生成 `data` 的代码抛出异常）、任务被取消或节点进程退出时，删除临时文件，`path` 不受影响。只有那台 Agent 自己在写的过程中退出时，临时文件才会留下来；
  - `path` 所在的目录必须已经存在（不存在时抛出 `AgentFileNotFound`，消息写明是哪个目录），`path` 不能是目录。
- `files.upload` 由自己所在的 Agent 读 `local_path`，直接传给那台 Agent，数据不经过节点进程，适合大文件。`local_path` 是节点所在机器上的路径，相对路径相对于节点的当前目录（任务目录）；它不存在时抛出 `AgentFileNotFound`，消息里是自己所在的 Agent。对 `ctx.agent()` 上传就是本机复制。
- `files.delete` 只删除文件，不删除目录（目录抛出 `AgentError`，`kind` 为 `invalid`）；`path` 是符号链接时删除链接本身。文件不存在时抛出 `AgentFileNotFound`。
- 目录没有写权限时，写入、上传、删除都抛出 `AgentPermissionDenied`。
- `timeout`：`files.write`、`files.upload` 是对方接收每一段、写完后给出结果各自最多等多久；`files.write` 等 `data` 给出下一段不计时。`files.delete` 是整个调用。
- 本地调试时规则相同：写到映射的目录里，`local_path` 是本机上的路径。

### 监听目录：`files.watch`

```python
from sfly import AgentName, Context, FileId, WatchSnapshot, node


@node(outputs=["rotated"])
def wait_rotation(ctx: Context, source: AgentName, directory: str = "/var/log/app") -> dict:
    """等 source 上的 app.log 轮转一次，输出被改名后的路径。"""
    current: FileId | None = None
    for item in ctx.agent(source).files.watch(directory, "app.log*"):
        if isinstance(item, WatchSnapshot):
            # 以快照为准：重连、事件太多来不及发出之后会再给一份（item.missed 为 True）。
            by_path = {f.path: f.id for f in item.files}
            current = by_path.get(f"{directory}/app.log", current)
        elif item.kind == "moved" and item.id == current:
            return {"rotated": item.path}
    raise RuntimeError("监听意外结束")
```

`files.watch` 监听目录下文件名匹配 `pattern` 的普通文件，返回一个一直进行下去的迭代器：先给出一份 `WatchSnapshot`（当前的文件），之后逐个给出 `FileEvent`。停止迭代（`break`、`return`、`close()`）时监听随之结束。从 SDK 0.2.0 起可用，需要那台 Agent 支持能力 `files.watch`（0.2.0 及以上的 Agent）。

- `pattern` 的规则与 `files.list` 相同。`recursive=True` 时监听子目录，包括监听期间新建（或移进来）的子目录：新子目录里已有的文件作为 `created` 给出。
- `WatchSnapshot(files, missed)`：`files` 是当时匹配的全部文件（`FileInfo` 的元组，顺序与 `files.list` 相同）。快照之后的变化不会漏掉，但可能和快照重复。
- `missed` 为 True 表示**可能有遗漏**：两台 Agent 之间的连接中断后自动重连、或者事件太多来不及发出（节点读得太慢，事件队列溢出）时，重新给一份快照，之前的一些事件没有送到。这时以这份快照为准，按文件标识去重，不要假设每个变化都有事件。开头的第一份快照为 False。
- `FileEvent(kind, file, old_path)`：`file` 是事件之后这个文件的属性（`FileInfo`，`path`、`id` 也可以直接从事件上取），`old_path` 只有 `moved` 有。`kind`：

| `kind` | 含义 |
|---|---|
| `created` | 新建，包括从监听范围之外移进来 |
| `moved` | 在监听范围内改名（日志轮转），文件标识不变；`old_path` 是原来的路径 |
| `closed` | 以写方式打开的文件被关闭（inotify 的 `IN_CLOSE_WRITE`）。不代表不会再被写：同一个文件可以再次打开续写 |
| `modified` | 内容被修改。还没送到的连续几次修改合并成一个事件 |
| `deleted` | 被删除，包括移出监听范围；`file` 是最后一次看到的属性 |

- 事件描述的是「匹配 `pattern` 的文件」这个集合的变化：改名后不再匹配是 `deleted`，改名后才匹配是 `created`。
- **平台不判断文件是否写完。** 一个日志文件算不算「不会再续写」取决于被测系统怎样轮转日志（改名后还写不写、关闭后会不会再打开），由节点自己判断，例如「已经被改名」「至少 N 秒没有 `modified`」，或者两者都要。
- 用 inotify 实现，**只在 Linux 的本地文件系统上可靠**：NFS 等网络文件系统上看不到别的机器做的修改。
- 递归时每个子目录占一个 inotify watch，一个用户的 watch 总数受系统上限 `/proc/sys/fs/inotify/max_user_watches` 限制，同时进行的监听数受 `max_user_instances` 限制；超过时抛出 `sfly.AgentError`，消息里写明是哪个上限。目录很多时调大上限，或者监听更深一层的目录、不递归。
- `timeout`：开始监听时最多等这么久。之后那台 Agent 会定期发心跳，超过 `timeout` 秒（None 时 30 秒）没有任何回应就认为连接中断并自动重连，重连 `timeout` 秒还没成功时抛出 `sfly.AgentUnreachable`；`timeout=None` 时一直重连。事件之间隔多久都不算超时。
- 迭代时才开始监听：目录不存在、不是目录或没有权限时抛出异常（`AgentFileNotFound` 等）。监听期间目录本身被删除或改名时，先给出里面文件的 `deleted`，再抛出 `sfly.AgentFileNotFound`。
- 本地调试时同样用 inotify 监听本机的目录（只支持 Linux），映射到本地目录的 Agent 也一样；没有连接，所以没有重连，节点读得太慢、内核的 inotify 队列溢出时同样重新给 `missed=True` 的快照。

### 执行命令：`exec`

```python
from sfly import AgentName, Context, node


@node(outputs=["compressed"])
def compress_rotated_logs(ctx: Context, source: AgentName, directory: str = "/var/log/app") -> dict:
    """在 source 上压缩已经轮转出去的日志（app.log.1、app.log.2…），gzip 的输出进入这个任务的日志。"""
    agent = ctx.agent(source)
    rotated = [
        f.path for f in agent.files.list(directory, "app.log.[0-9]*") if not f.path.endswith(".gz")
    ]
    for path in rotated:
        code = agent.exec.run(["gzip", "-9", "--verbose", path], timeout=600)
        if code != 0:
            raise RuntimeError(f"压缩 {path} 失败，gzip 退出码 {code}")
    return {"compressed": [f"{path}.gz" for path in rotated]}
```

| 方法 | 说明 |
|---|---|
| `exec.run(command, *, timeout, cwd=None, env=None)` | 在那台 Agent 上执行一条命令，等它结束，返回退出码（`int`） |

从 SDK 0.2.0 起可用，需要那台 Agent 支持能力 `exec`（0.2.0 及以上的 Agent）。

- `command` 是字符串时用 `/bin/sh -c` 执行；是字符串列表时第一项是程序（不含 `/` 时在那台 Agent 的 `PATH` 里找），其余是参数，不经过 shell。
- 命令在那台机器上以那台 Agent 进程的身份运行。`cwd` 是工作目录（那台机器上的绝对路径），默认 `/`；`env` 是在那台 Agent 进程的环境变量之上追加的环境变量。
- 返回退出码；被信号终止时为 128 + 信号值。退出码不是 0 不算失败，由节点自己检查。找不到程序、工作目录不存在时抛出 `AgentFileNotFound`，没有权限执行时抛出 `AgentPermissionDenied`。
- 命令的标准输出、标准错误逐行进入**这个任务**的日志（标准输出为 info，标准错误为 error），每行前面标上来自哪台 Agent，例如 `[Agent a-01] /var/log/app/app.log.1: 91.2% -- replaced with /var/log/app/app.log.1.gz`。返回值里没有输出：要拿结果时让命令把它写进文件，再用 `files` 读出来。
- 命令归属于调用它的任务：不占那台 Agent 的槽位，不在那台 Agent 上产生任务，运行页面上也不出现新的节点。
- `timeout`（秒）必须给，没有默认值，不能传 `None`：它是命令最多运行多久。超过时命令连同它启动的子进程（同一个进程组里的进程）一起被结束（先 SIGTERM，那台 Agent 的宽限期过后 SIGKILL），抛出 `AgentTimeout`；超时之前的输出照常在日志里。
- 这个任务被取消、被停止子流程节点停止、失败或正常结束时（包括在后台线程里调用、节点没等它就返回了），还在运行的命令连同子进程一起被结束；两台 Agent 之间的连接断开时也一样，调用抛出 `AgentUnreachable`。
- 命令退出后，它留在后台的子进程也被结束，所以不能用它启动常驻进程（被测服务等）：那样的进程用标准节点 `start_process` 启动，把这个节点派到那台机器上（见[标准节点](standard-nodes.md)）。自己用 `setsid` 离开进程组的进程不在这个范围里，不要这样做。
- 本地调试时在本机执行：`ctx.agent()` 和映射到本地目录的 Agent 都在本机运行命令，后者的工作目录落在映射的目录里（`cwd="/srv"` 是 `<目录>/srv`），命令里写的路径不换算。日志里的行标上 `[本机]` 或 `[Agent 名称]`。

### 超时、取消与错误

- `timeout` 是等对方回应的上限（秒），默认 30，`None` 表示不限，必须大于 0。`files.stat` 是整个调用；`files.list` 是到第一项、以及相邻两项之间各自最多等多久。超时抛出 `sfly.AgentTimeout`。
- `files.read` 是到第一块、以及相邻两块之间各自最多等多久；`files.download` 是相邻两次进展之间（重连的每一步各自）最多等多久。
- `exec.run` 例外：`timeout` 必须给，是命令最多运行多久（见上文「执行命令」）。
- 任务被取消（或超时、被停止子流程节点停止）时，正在进行的调用立即结束并抛出 `sfly.Cancelled`，在后台线程里调用也一样。节点进程退出时调用随之放弃。
- 失败时抛出 `sfly.AgentError` 的子类，`kind` 区分原因，`agent` 是目标 Agent 的名称，消息写明是哪台 Agent。它们同时是对应的内置异常的子类，`except FileNotFoundError` 这样的写法也能捕获：

| 异常 | `kind` | 原因 |
|---|---|---|
| `AgentUnreachable`（`ConnectionError`） | `unreachable` | 连不通：两台 Agent 之间连不上，或那台 Agent 的端口没在监听（例如端口被占用）；也包括连不上自己所在的 Agent |
| `AgentUnsupported` | `unsupported` | 对方不支持：那台 Agent 的版本太旧，没有这项能力，要升级它 |
| `AgentFileNotFound`（`FileNotFoundError`） | `not_found` | 文件或目录不存在；`exec.run` 找不到程序、工作目录不存在 |
| `AgentFileMoved` | `moved` | `files.download` 重连续传时，源文件已经不在原来的路径上，在同一目录里也找不到（移到了别的目录） |
| `AgentPermissionDenied`（`PermissionError`） | `permission_denied` | 那台 Agent 进程没有权限 |
| `AgentTimeout`（`TimeoutError`） | `timeout` | 超过 `timeout` 秒没有回应；`exec.run` 的命令超过 `timeout` 秒没有结束 |
| `AgentNotReferenced` | `not_referenced` | 那台 Agent 不是通过「Agent」类型的参数拿到的 |
| `AgentError` | `invalid` | 参数不合法：例如要列出的路径不是目录，要读取、删除的是目录，要写入的路径是目录，`exec.run` 的工作目录不是目录 |
| `AgentError` | `failed` | 其它失败：例如下载期间源文件变了（见上文「读取与下载」）、那台 Agent 访问文件时出了其它错误 |

`kind` 的取值是固定的字符串，可以在代码里比较，例如 `error.kind == "failed"`。更新的 Agent 可能报出表里没有的 `kind`，抛出的也是 `AgentError`，按其它失败处理。

连不通的消息写明从哪台到哪台、地址和端口，例如 `从 Agent b-01 连不上 Agent a-01（地址 10.0.0.5，端口 50052）：…`，据此去查两台机器之间的防火墙。那台 Agent 已知不能被调用时（端口被占用、版本过旧不监听端口，Agent 页面上有提示），不去连接，直接抛出 `AgentUnreachable`（版本过旧时是 `AgentUnsupported`），消息写明原因。节点不捕获这些异常时，任务以 `node_error` 失败，消息就是异常的消息。

### 版本

- 节点所在的 Agent 和它访问的 Agent 都要是 0.2.0 及以上：更早的 Agent 不监听供其它 Agent 连接的端口，访问它时抛出 `AgentUnsupported`。
- 节点包在 `[tool.sfly]` 里声明 `requires-agent`（例如 `>=0.2.0`），平台在触发前就检查，不会运行到一半才失败：节点所在的 Agent 按控制面的版本检查（它会先自更新到控制面的版本），「Agent」类型的参数选的 Agent 按它最近一次注册时的版本检查；不满足时预检阻断，写明是哪台 Agent、需要哪个版本。参数引用入口参数时在触发时按实际值检查，值来自前面节点的输出时在派发时检查，不满足时任务以 `env_error` 失败。
- 某个能力在比你声明的版本更新的 Agent 上才有时，调高 `requires-agent`。

### 本地调试、测试与联调

- 本地调试（`sfly debug`、`sfly.testing.run_node`）没有 Agent：`ctx.agent()` 直接操作本机的文件系统。
- 另一台 Agent 由测试工具映射到本地目录：`run_node(..., agents={"a-01": tmp_path / "a"})` 或 `sfly debug <节点> --agent a-01=./a`。那台 Agent 上的绝对路径落在这个目录里：`/var/log/app.log` 是 `<目录>/var/log/app.log`，`FileInfo.path` 仍是那台 Agent 上的写法 `/var/log/app.log`。名称要通过「Agent」类型的参数传给节点，规则和在 Agent 上一样：参数里没有的名称抛出 `AgentNotReferenced`，参数里有但没有映射的抛出 `AgentUnreachable`（消息里写明怎样映射）。
- 本地调试时 `files.download` 的 `local_path` 就是本机上的路径，不经过映射：`download("/var/log/app.log", "out/app.log")` 把 `<目录>/var/log/app.log` 复制到工作目录下的 `out/app.log`。
- 联调（`sfly dev`）时开发版本在本机 Agent 上运行，`ctx.agent(名称)` 照常经本机 Agent 访问其它 Agent。

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

`run_node(node, inputs=None, *, cancel_when=None, cancel_after=None, grace=10.0, work_dir=None, downloads=None, agents=None)` 在子进程里用和 Agent 相同的执行器执行节点，等它结束后返回 `Execution`：

- `node`：`@node` 函数（模块顶层），或入口字符串 `"模块:函数"`。
- `inputs`：输入，先按类型注解校验，不通过时 `status` 为 failed、`error.kind` 为 config_error，节点不执行。
- `cancel_when(partial)`：执行中定期以到目前为止的结果调用，返回 True 时取消；`cancel_after`：开始后这么多秒取消。取消与平台相同：节点里抛出 `Cancelled`，宽限期 `grace` 秒后强制杀掉。
- `work_dir`：任务工作目录，默认新建一个临时目录（不自动删除）；测试里传 pytest 的 `tmp_path`。
- `downloads`：产物引用 → 本地内容，给 `ctx.artifacts.download` 用。内容是 bytes / str（按 UTF-8）时就是产物的内容，是路径（`Path`）时取该文件，写法与 `ctx.artifacts.save` 相同。没有列出的引用照常下载。
- `agents`：Agent 名称 → 本地目录，给 `ctx.agent(名称)` 用（见「Agent 能力」的「本地调试、测试与联调」）。从 SDK 0.2.0 起可用。

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
| `logs` | `LogLine(ts, source, level, message)` 的列表；`source` 是 stdout、stderr、sdk，或 system（平台写的提示，例如 `ctx.notify` 发给了不在名单里的机器人） |
| `progress` | `Progress(ts, current, total, message)` 的列表，保留每一次上报 |
| `metrics` | `MetricPoint(ts, name, kind, value, labels)` 的列表，保留每一次上报（未声明的、标签不合法的已丢弃）；`labels` 是这个点的标签（值都是字符串），不带标签时为 `{}` |
| `notifications` | `Notification(ts, bot, body)` 的列表：每次 `ctx.notify` 发给的飞书机器人名称和完整的请求体（文本、`sfly.feishu.card` 组装的卡片和原始消息都在里面，可以直接断言），没有真的发送（不是通过「飞书机器人」参数传入的机器人、不合格的原始消息不在里面，日志里有 warning）。从 SDK 0.3.0 起可用 |
| `artifacts` | 产物名称 → 本地文件路径 |
| `artifacts_dir`、`work_dir` | 产物目录、工作目录 |

`ts` 是 Unix 毫秒时间戳。

断言节点要发的通知：`notifications` 里每一项是机器人名称和完整的请求体，不用起任何服务。

```python
import sfly
from sfly.testing import run_node

from demo.example import stress


def test_stress_alerts_the_bot_with_a_red_card(tmp_path: Path) -> None:
    result = run_node(stress, {"qps": 100, "alert_bot": "ops"}, work_dir=tmp_path)

    assert result.status == "success", result.error
    [notification] = result.notifications
    assert notification.bot == "ops"
    assert notification.body == sfly.feishu.card("压测告警", "**p99** 612 ms，超过 500 ms", "red")
```

## 命令行 `sfly`

在项目里用 `uv run sfly <命令>` 运行；每个命令的完整参数见 `uv run sfly <命令> --help`。需要控制面地址的命令按 `--server` > 环境变量 `SFLY_SERVER` > `~/.sfly/agent.env`（`SFLY_HOME`）里的 `SFLY_CONTROL_PLANE_URL` 取值，`install.sh --dev` 安装的开发机不用传 `--server`。

| 命令 | 作用 |
|---|---|
| `sfly init <目录> [--name <包名>]` | 创建节点包项目：uv 项目、控制面的镜像与 sfly 索引配置、开发依赖、示例节点和测试、两份给 AI 编程助手的 skill（节点开发、操作平台）。包名默认是目录名 |
| `sfly debug <节点> [--params '<JSON>']` | 本地调试：在当前项目环境里执行一个节点，不经过控制面和 Agent |
| `sfly dev [项目目录]` | 联调：把项目以 `<包名>@dev` 装到本机 Agent（通过本机 Agent 的本地 socket） |
| `sfly build [项目目录]` | 扫描 `@node`，构建节点包 `dist/<包名>-<版本>.sflypkg` |
| `sfly publish [项目目录或 .sflypkg]` | 发布到控制面；给项目目录时先构建 |
| `sfly skill update [--force]` | 把项目里的两份 skill（节点开发、操作平台）换成当前 SDK 版本的内容 |
| `sfly scenario`、`sfly run`、`sfly agent`、`sfly package`、`sfly api` | 操作平台：查看场景、运行、Agent、节点包，触发、等待、取消运行，读日志，pull / push 编辑场景，直接调用接口。见 [用命令行操作平台](platform-cli.md) |

### `sfly debug`

```sh
uv run sfly debug countdown --params '{"name": "世界", "steps": 5}'
```

- 日志实时打印到标准错误；结束后在标准输出打印输出值（`输出：` 后的 JSON）、指标汇总表和运行目录。指标汇总表每个序列一行，带标签的指标在指标名后面跟标签值，例如 `conn_latency_ms{host=db-1,port=5432}`。
- 每次运行一个新目录 `.sfly/runs/<时间>-<节点>/`（目录名也是 `ctx.task.run_id`；`ctx.procs_dir` 是 `.sfly/procs/<目录名>/`），里面有产物（`artifacts/`）、标准输出 / 标准错误的副本（`stdout.log`、`stderr.log`）；日志、进度和指标经命名管道 `events.fifo` 读取，不另存文件。
- `--download <产物引用> <文件>`：节点用 `ctx.artifacts.download` 下载这个产物引用时，得到这个本地文件的内容；可以重复给出。文件不存在时以 2 退出。例如 `uv run sfly debug count_lines --params '{"log_file": "up"}' --download up ./server.log`。
- `--agent <名称>=<目录>`：把一台 Agent 映射到本地目录，节点用 `ctx.agent(名称)` 访问它时，那台 Agent 上的绝对路径落在这个目录里；可以重复给出。目录不存在时以 2 退出。例如 `uv run sfly debug find_logs --params '{"source": "a-01"}' --agent a-01=./fixtures/a-01`。从 SDK 0.2.0 起可用。
- `ctx.notify` 不真的发送：和日志一起实时打印一行 `通知  发给飞书机器人「<名称>」（本地调试不发送）：<请求体 JSON>`。从 SDK 0.3.0 起可用。
- Ctrl-C 按平台的取消流程取消（节点里抛出 `Cancelled`，宽限期后强制杀掉），再按一次立即杀掉；节点结束后、打印结果期间的 Ctrl-C 被忽略。
- 退出码：成功 0，节点失败 1，参数不合法或找不到节点 2，取消 130。

### `sfly dev`

- 本机要有已连上控制面的 Agent（`install.sh --dev` 安装）。
- Agent 以可编辑方式安装本地源码，注册为 `<包名>@dev`；在场景里选这个版本和本机 Agent 运行（浏览器里选，或者用命令行复制场景、改成开发版本再 `sfly run start --wait`，见 `sfly-platform` skill）。
- 只改函数体时，下一个任务直接用新代码；改了节点的参数、输出、指标声明、依赖或增删节点后重新运行 `sfly dev`。

### `sfly publish`

- 版本号取 `[project].version`。已发布的 `包名@版本` 不能覆盖：控制面拒绝时递增版本号再发布。

### `sfly skill update`

- 用当前安装的 SDK 带的内容整个替换 `.agents/skills/sfly-node-dev/` 和 `.agents/skills/sfly-platform/`（`.claude/skills/` 下同名的软链接不存在时一并创建；项目里还没有的 skill 直接写入）。
- 每份 skill 单独检查：目录内容和上次写入的不同时不覆盖这一份，列出改动过的文件，最后以 1 退出，另一份照常更新；确认不需要这些改动后加 `--force`。自己的约定写在自己的其他 skill 里。
