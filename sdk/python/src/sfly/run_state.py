"""`sfly.RunState`：节点引用 `${{ run.state }}` 时拿到的「这次运行此刻的状态」的类型。
只用标准库（ADR 0002）。

控制面在派发节点的那一刻把整个运行状态解析成一个 JSON 对象，写进节点的这个输入，节点拿到的是一个
普通的 `dict`；这里的 `TypedDict` 只是给类型检查器和编辑器看的，运行时不做任何转换：

    from sfly import Context, RunState, node

    @node(title="运行汇总")
    def run_summary(ctx: Context, run: RunState) -> None:
        nodes = {n["node_id"]: n for chain in run["chains"] for n in chain["nodes"]}
        failed = [nodes[i]["error"]["headline"] for i in run["failures"] if nodes[i]["error"]]

字段只有一份定义：packages/schema 的 `RunState`（zod），导出的 JSON Schema 是
`sfly/schemas/run-state.schema.json`；这里的 `TypedDict` 和它逐键、逐层对应
（sdk/python/tests/test_run_state_type.py 对着它测，契约改了测试会失败）。所有键都总是存在，
没有值时是空值（`None`、空列表）；以后只会增加键，读它的代码对多出来的键忽略。
不含任何节点的输入、输出、进度、日志、动作。
"""

from __future__ import annotations

from typing import Annotated, Literal, TypedDict

from sfly.nodes import RUN_STATE_MARKER

#: 运行的状态。运行还没结束时是 `running`。
RunStatus = Literal["running", "success", "failed", "cancelled"]

#: 节点最近一次尝试的状态：`pending` 还没有尝试，`queued` 排队中，`dispatched` 已派发给 Agent
#: 还在准备（界面写「准备中」），`running` 执行中，`waiting` 停止子流程节点在等被停止的子流程结束，
#: `success`、`failed`、`skipped`（被跳过）、
#: `cancelled`（没开始就被取消）、`stopped`（所在子流程被停止，不算失败）。
NodeStatus = Literal[
    "queued",
    "dispatched",
    "running",
    "waiting",
    "success",
    "failed",
    "skipped",
    "cancelled",
    "stopped",
    "pending",
]


class RunStateError(TypedDict):
    """一个失败节点的错误（最近一次尝试的）。错误信息已按这次运行的保密参数的值打码。"""

    #: 错误类型：`node_error`（节点代码抛出异常）、`timeout`、`agent_lost`、`env_error`、
    #: `config_error`；没有记录错误类型时是 `unknown`。读它的代码遇到不认识的取值当作别的类型。
    kind: str
    #: 失败原因的一行（和运行监控页头同一个取法）：错误信息里第一行有内容的文字，
    #: 去掉行首的异常模块路径；没有错误信息时是空串。
    headline: str
    #: 异常信息本身，不含堆栈。超过长度上限时截到上限、末尾是「…」，`message_truncated` 为 `True`。
    message: str
    #: `message` 被截断了（超过长度上限，或整份状态超过大小上限被去掉）。
    message_truncated: bool
    #: 出错位置（一行文字：`模块.函数 第 N 行`，节点代码里抛出的那一行）；节点自己没有出错
    #: （超时、Agent 掉线等）时为 `None`。
    location: str | None


class RunStateNode(TypedDict):
    """一个链实例上的一个节点。"""

    node_id: str
    #: 节点的显示名称（子流程入口节点是子流程名称）；没有时为 `None`。
    display_name: str | None
    #: 节点的种类，场景里节点的 `kind`：`package`、`entry`、`subflow_entry`、`async`、
    #: `stop_subflow` ……；遇到不认识的取值当作「别的种类」。
    kind: str
    #: 最近一次尝试的状态；还没有尝试时为 `pending`，被跳过时为 `skipped`，没开始就被取消时为
    #: `cancelled`（这两种都没有尝试）。
    status: NodeStatus
    #: 尝试次数（不含被跳过、没开始就被取消或停止的占位）。
    attempts: int
    #: 最近一次尝试开始执行、结束的时间（ISO 8601，控制面时间）；还没开始、还没结束时为 `None`。
    started_at: str | None
    ended_at: str | None
    #: 只在 `status` 是 `failed` 时有：最近一次尝试的错误。被取消、被停止、被跳过的节点没有；
    #: 超时的节点是 `failed`、错误的 `kind` 是 `timeout`。
    error: RunStateError | None


class RunStateChain(TypedDict):
    """一个链实例：主链，或由异步任务节点触发的子流程实例。"""

    id: str
    #: 链起点节点 ID（主链是入口节点，子流程是子流程入口节点）。
    chain_id: str
    #: 子流程名称（名称为空时是空字符串）；主链为 `None`。
    name: str | None
    #: 层数：主链是 0，主链触发的子流程是 1。
    depth: int
    #: 触发它的异步任务节点所在的链实例；主链为 `None`。
    parent_chain_instance_id: str | None
    #: 触发它的异步任务节点；主链为 `None`。异步任务节点成功只表示子流程实例已创建，
    #: 子流程的结果看这个链实例自己的 `status`。
    async_node_id: str | None
    status: RunStatus
    started_at: str
    ended_at: str | None
    #: 这条链上的全部节点，按链上的顺序。
    nodes: list[RunStateNode]


class RunStateScenario(TypedDict):
    """运行的场景。"""

    id: str
    #: 场景此刻的名称（名称不跟版本走）。
    name: str
    #: 运行绑定的场景版本号。
    version: int


class RunStateCancel(TypedDict):
    """取消请求。"""

    requested_by: str
    #: 经哪个 AI 编程助手取消；没有时为 `None`。
    requested_via: str | None
    requested_at: str
    #: 清理期间再次取消（强制取消）的时间；没有时为 `None`。
    forced_at: str | None


class RunStateSelf(TypedDict):
    """引用这份状态的节点。"""

    chain_instance_id: str
    node_id: str


class _RunState(TypedDict):
    """一次运行在某一刻的整体状态，`sfly.RunState` 就是它（带上让 `sfly build` 认出的标记）。"""

    run_id: str
    scenario: RunStateScenario
    #: 运行此刻的状态。运行还没结束时是 `running`：引用它的节点自己还没结束，所以节点里看到的
    #: 总是 `running`，不能用它判断结果，看 `result_so_far`。
    status: RunStatus
    #: 到此刻为止的结果：已请求取消是 `cancelled`，否则有节点（或链）最终失败是 `failed`，
    #: 否则是 `success`；运行已经结束时它就是 `status`。
    result_so_far: Literal["success", "failed", "cancelled"]
    #: 触发人的昵称。
    triggered_by: str
    #: 经哪个 AI 编程助手触发；没有时为 `None`。
    triggered_via: str | None
    started_at: str
    ended_at: str | None
    #: 取消请求；没有被请求取消时为 `None`。
    cancel: RunStateCancel | None
    #: 最终失败的节点的 ID，按失败的先后：第一项就是第一个失败的节点。一次运行里节点 ID
    #: 不重复，用它去链实例的 `nodes` 里找。
    failures: list[str]
    #: 引用这份状态的节点（`${{ run.state }}` 写在哪个节点的输入里）。
    self: RunStateSelf | None
    #: 整份状态超过大小上限时，从 `failures` 的末尾开始去掉 `error.message`
    #: （那几个节点的 `message_truncated` 为 `True`），直到放得下；去掉过时为 `True`。
    truncated: bool
    #: 运行里已经创建的全部链实例，按层数、开始时间排序；还没被触发的子流程不在里面，
    #: 看触发它的异步任务节点的状态。
    chains: list[RunStateChain]


#: 「运行状态」类型的输入：值是 `${{ run.state }}` 解析出的运行状态，运行时就是普通的 `dict`
#: （字段见 `_RunState`、`RunStateChain`、`RunStateNode`、`RunStateError`）。检查器里不用填值，
#: 在场景里写 `${{ run.state }}` 引用；本地调试用 `sfly debug --params @文件` 给一份，
#: 单测里用 `sfly.testing.run_state(...)` 造一份。只能直接用作节点参数的类型，
#: 可以写成 `RunState | None`。
RunState = Annotated[_RunState, RUN_STATE_MARKER]
