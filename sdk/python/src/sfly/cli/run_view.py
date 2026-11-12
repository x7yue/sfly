"""运行相关命令共用的显示规则：状态用词、链和节点的写法、时间与时长、日志行、节点类型名。

用词与界面一致：运行和链的状态是 apps/web/src/lib/copy.ts 的 RUN_STATUS_LABEL，节点和任务的状态是
apps/web/src/lib/node-status.ts；名称为空的子流程写「未命名子流程」（packages/orchestration 的
chain-label.ts）。命令行里的 `链:节点` 都由这里写出、也由这里认回去，所以 `scenario show`、
`run show`、`run logs --node`、进度行里的写法互相对得上。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sfly.cli.client import ApiError, Client, segment
from sfly.cli.errors import CliError

# ---------------------------------------------------------------- 状态

# 运行和链的状态。「running」在运行上写运行中，在节点上写执行中，界面也是这样分的，所以是两张表。
RUN_STATUS_LABEL = {"running": "运行中", "success": "成功", "failed": "失败", "cancelled": "已取消"}

# 节点和任务（节点的一次尝试）的状态。
NODE_STATUS_LABEL = {
    "pending": "待执行",
    "queued": "排队中",
    "dispatched": "准备中",
    "running": "执行中",
    "waiting": "等待中",
    "success": "成功",
    "failed": "失败",
    "skipped": "已跳过",
    "cancelled": "已取消",
    "stopped": "已停止",
}


def run_status_label(status: str, *, cancelling: bool = False, forced: bool = False) -> str:
    """运行（或链）的状态；已请求取消、还没结束的写取消中（强制取消后是强制终止中），不写运行中。"""
    if status == "running" and cancelling:
        return "强制终止中" if forced else "取消中"
    return RUN_STATUS_LABEL.get(status, status)


def node_status_label(status: str) -> str:
    return NODE_STATUS_LABEL.get(status, status)


# ---------------------------------------------------------------- 链和节点

MAIN_CHAIN = "main"
UNNAMED_SUBFLOW = "未命名子流程"


def subflow_label(name: str) -> str:
    """子流程的显示名称。`name` 是去掉首尾空白的名称（没有名称字段的旧版本是入口节点 id），
    填了空名称时写「未命名子流程」。"""
    return name or UNNAMED_SUBFLOW


def chain_name(subflow: str | None) -> str:
    """链在命令行里的名字：主链（`subflow` 为 None）是 `main`，子流程是它的显示名称。"""
    return MAIN_CHAIN if subflow is None else subflow_label(subflow)


def chain_label(chain: Mapping[str, Any]) -> str:
    """运行里的一条链的名字（`name` 是控制面给的子流程名称，主链没有）。"""
    return chain_name(chain.get("name"))


@dataclass(frozen=True)
class NodeRef:
    """命令行里的节点，或节点的某一次尝试：`链:节点`，指定尝试时 `链:节点#尝试`。"""

    chain: str
    node: str
    attempt: int | None = None

    @property
    def label(self) -> str:
        """`链:节点`，不带尝试。"""
        return f"{self.chain}:{self.node}"

    def format(self, *, retried: bool = False) -> str:
        """指定了尝试，并且节点重试过（`retried`）或不是第 1 次尝试时，写成 `链:节点#尝试`；
        第一次就成功的节点不带 `#`。"""
        if self.attempt is not None and (retried or self.attempt > 1):
            return f"{self.label}#{self.attempt}"
        return self.label

    def match(self, text: str) -> bool:
        """用户写的 `text` 是不是在说这个节点（`链:节点`，所有尝试）或这次尝试（`链:节点#尝试`）。
        拿写出来的文字比较，不拆分：链名和节点 id 里都可能有 `:`、`#`。"""
        return text == self.label or (
            self.attempt is not None and text == f"{self.label}#{self.attempt}"
        )


def last_attempt(node: Mapping[str, Any]) -> dict[str, Any] | None:
    attempts = node["attempts"]
    return max(attempts, key=lambda a: a["attempt"]) if attempts else None


# ---------------------------------------------------------------- 时间和时长


def parse_time(text: str) -> datetime:
    """控制面的时间戳（ISO 8601，以 Z 结尾）。"""
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def duration_ms(start: str | None, end: str | None) -> int | None:
    """两个控制面时间之间的毫秒数；缺任何一个时为 None。"""
    if not start or not end:
        return None
    return max(round((parse_time(end) - parse_time(start)).total_seconds() * 1000), 0)


def format_duration(ms: int | None) -> str:
    """`0.4s`、`12s`、`3m05s`、`1h02m`：不到 10 秒保留一位小数；没有时为 `-`。"""
    if ms is None:
        return "-"
    if ms < 10_000:
        return f"{ms / 1000:.1f}s"
    seconds = round(ms / 1000)
    if seconds < 60:
        return f"{seconds}s"
    minutes, rest = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m{rest:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"


# ---------------------------------------------------------------- 日志行


def line_time(line: Mapping[str, Any]) -> str:
    """控制面时间；升级之前写入的行没有，退回当时记的 Agent 时间。"""
    return str(line["time"] or line.get("agent_time") or "-")


def format_log_line(line: Mapping[str, Any], label: str | None = None, *, indent: str = "") -> str:
    """`时间 级别 [链:节点] 内容`；内容有多行时，后面的行比第一行多缩进四格。
    `indent` 是整段日志缩进的格数（摘要里的日志缩在失败的任务下面）。"""
    first, *rest = str(line["text"]).rstrip("\n").split("\n")
    parts = [line_time(line), f"{line['level']:<5}", *([label] if label else []), first]
    return "\n".join([indent + " ".join(parts), *(f"{indent}    {more}".rstrip() for more in rest)])


# ---------------------------------------------------------------- 节点类型

# 内置节点在「节点类型」里的名称；包节点显示 `包名/节点名`。
_BUILTIN_TYPES = {
    "entry": "入口",
    "subflow_entry": "子流程入口",
    "async": "异步任务",
    "timer": "定时",
    "sleep": "Sleep",
    "stop_subflow": "停止子流程",
    "feishu_notify": "飞书通知",
}


def node_type_label(node: Mapping[str, Any]) -> str:
    """节点类型的名称：包节点是 `包名/节点名`，内置节点是中文名。`node` 是场景文档里的节点；
    只知道 `kind` 时（读不到场景版本）包节点写 `package`。"""
    kind = str(node["kind"])
    if kind == "package" and "package" in node:
        return f"{node['package']}/{node['node']}"
    return _BUILTIN_TYPES.get(kind, kind)


# ---------------------------------------------------------------- 取运行


def run_not_found(run_id: str) -> CliError:
    return CliError("run_not_found", f"没有 id 是 {run_id} 的运行", next="sfly run list")


def fetch_run(client: Client, run_id: str) -> dict[str, Any]:
    """运行详情；运行不存在时抛 `run_not_found`。"""
    try:
        run: dict[str, Any] = client.get(f"/runs/{segment(run_id)}")
    except ApiError as error:
        if error.status != 404:
            raise
        raise run_not_found(run_id) from None
    return run
