"""`wait_log_line`：等日志文件里出现匹配正则的行。

用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `wait_log_line` 一节；
逻辑在辅助函数 `sfly_std.logs.wait_for_log_line`，这里是它的节点外壳。
"""

from __future__ import annotations

from typing import Annotated, Literal, TypedDict

from sfly import Context, Doc, node
from sfly_std.logs import wait_for_log_line
from sfly_std.waiting import DEFAULT_POLL, DEFAULT_WAIT


class WaitLogLineOutputs(TypedDict):
    line: Annotated[str, Doc("第一行匹配的内容（不含换行符）")]


@node(title="等待日志行")
def wait_log_line(
    ctx: Context,
    path: Annotated[str, Doc("日志文件路径；相对路径相对于任务工作目录")],
    pattern: Annotated[
        str, Doc("Python 正则表达式，匹配行内任意位置（re.search）；要匹配整行用 ^...$")
    ],
    # 不叫 from：节点参数就是函数参数，而 from 是 Python 关键字。
    read_from: Annotated[
        Literal["end", "start"],
        Doc("从哪里开始看：end 只看节点开始之后新写入的内容，start 从文件开头看起"),
    ] = "end",
    wait: Annotated[float, Doc("最多等多少秒")] = DEFAULT_WAIT,
    poll: Annotated[float, Doc("检查间隔（秒）")] = DEFAULT_POLL,
) -> WaitLogLineOutputs:
    """等日志文件里出现匹配正则的行，用来等被测系统打出就绪日志。

    文件还不存在时等它出现；文件被轮转或截断时继续读新的内容。

    失败：wait 秒内没有出现匹配的行时失败，错误信息写明文件、正则和等了多久。
    文件一直不存在时，错误信息注明「文件不存在」。
    """
    found = wait_for_log_line(ctx, path, pattern, read_from=read_from, wait=wait, poll=poll)
    return {"line": found.line}
