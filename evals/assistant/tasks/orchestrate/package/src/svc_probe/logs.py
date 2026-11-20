"""读另一台机器上的日志。"""

import re
from typing import Annotated, TypedDict

from sfly import AgentFileNotFound, AgentName, Context, Doc, node


class ScanOutputs(TypedDict):
    lines: Annotated[int, Doc("日志的总行数")]
    matches: Annotated[int, Doc("匹配 pattern 的行数")]
    samples: Annotated[list[str], Doc("最后几条匹配的行，最多 sample 条")]


@node(title="扫描远端日志")
def scan_remote_log(
    ctx: Context,
    source: Annotated[AgentName, Doc("日志所在的 Agent")],
    path: Annotated[str, Doc("日志文件在 source 机器上的绝对路径")],
    pattern: Annotated[str, Doc("要统计的正则表达式，按行匹配")] = "ERROR",
    sample: Annotated[int, Doc("带回的样本行数")] = 5,
) -> ScanOutputs:
    """流式读取另一台 Agent 上的一个日志文件，统计匹配正则的行数。

    只读，不修改也不删除日志。

    失败：日志文件不存在，或正则写错。
    """
    regex = re.compile(pattern)
    lines = matches = 0
    samples: list[str] = []
    pending = b""

    def count(raw: bytes) -> None:
        nonlocal lines, matches, samples
        lines += 1
        text = raw.decode("utf-8", errors="replace")
        if regex.search(text):
            matches += 1
            samples = [*samples, text][-sample:] if sample > 0 else []

    with ctx.action("读取远端日志", 机器=source, 路径=path):
        try:
            for chunk in ctx.agent(source).files.read(path):
                pending += chunk
                *complete, pending = pending.split(b"\n")
                for raw in complete:
                    count(raw)
        except AgentFileNotFound:
            raise FileNotFoundError(f"{source} 上没有日志文件 {path}") from None
        if pending:
            count(pending)
    ctx.log.info("%s:%s 共 %d 行，匹配 %r 的有 %d 行", source, path, lines, pattern, matches)
    return {"lines": lines, "matches": matches, "samples": samples}
