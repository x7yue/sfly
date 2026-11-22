"""`follow_log`：把日志文件新增的行实时转为任务日志，出现 `fail_on` 匹配的行时失败。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `follow_log` 一节；
逻辑在辅助函数 `sfly_std.logs.follow_log_file`，这里是它的节点外壳。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Literal, TypedDict

from sfly import Context, Doc, node
from sfly_std.logs import FOLLOW_METRICS, follow_log_file
from sfly_std.logs import FailOnMatched as _FailOnMatched


class FailOnMatched(_FailOnMatched):
    """日志里出现了匹配 `fail_on` 的行。错误类型名与 0.3.0 一致。"""


class FollowLogOutputs(TypedDict):
    lines: Annotated[int, Doc("转发的总行数（duration 到期时才有输出）")]


@node(title="跟随日志", metrics=FOLLOW_METRICS, primary_metric="lines_per_s")
def follow_log(
    ctx: Context,
    path: Annotated[str, Doc("日志文件路径；相对路径相对于任务工作目录")],
    # 不叫 from：节点参数就是函数参数，而 from 是 Python 关键字。
    read_from: Annotated[
        Literal["end", "start"],
        Doc("从哪里开始跟随：end 从节点开始时的文件末尾，start 先转发文件里已有的内容"),
    ] = "end",
    fail_on: Annotated[
        Sequence[str], Doc("正则表达式列表（re.search）：有一行匹配其中任意一个时节点失败")
    ] = (),
    duration: Annotated[
        float | None,
        Doc("跟随多少秒后成功结束；不设置时一直跟随，直到被停止子流程节点停止或运行被取消"),
    ] = None,
) -> FollowLogOutputs:
    """把日志文件新增的行实时转为任务日志，出现匹配的错误行时失败。

    文件还不存在时等它出现；文件被轮转或截断时继续跟随新的内容。
    不设置 duration 时一直跟随，直到被停止子流程节点停止或运行被取消。
    被停止时不算失败，已经转发的行都留在任务日志里。

    失败：有一行匹配 fail_on 里的任意一个正则时立即失败，错误信息附上第一行匹配的内容和匹配的正则。
    """
    try:
        lines = follow_log_file(ctx, path, read_from=read_from, fail_on=fail_on, duration=duration)
    except _FailOnMatched as error:
        raise FailOnMatched(*error.args) from None
    return {"lines": lines}
