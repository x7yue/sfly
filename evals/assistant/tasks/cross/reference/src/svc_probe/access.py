"""统计另一台机器上的访问日志。"""

import math
from typing import Annotated, TypedDict

from sfly import AgentFileNotFound, AgentName, Context, Doc, node


class AccessStats(TypedDict):
    total: Annotated[int, Doc("请求数（非空行数）")]
    status_counts: Annotated[dict[str, int], Doc("状态码到次数")]
    p95_ms: Annotated[float, Doc("耗时的 95 分位，毫秒；取第 ⌈0.95 × 请求数⌉ 小的值")]


@node(title="统计访问日志")
def access_stats(
    ctx: Context,
    source: Annotated[AgentName, Doc("日志所在的 Agent")],
    path: Annotated[str, Doc("日志在 source 机器上的绝对路径")],
) -> AccessStats:
    """读另一台 Agent 上被测服务的访问日志，统计请求数、各状态码的次数和耗时的 95 分位。

    每行的格式是「时间 级别 方法 路径 状态码 耗时」，耗时写成 `12.5ms`。

    失败：日志不存在，或有行不合格式。
    """
    data = b""
    with ctx.action("读取访问日志", 机器=source, 路径=path):
        try:
            for chunk in ctx.agent(source).files.read(path):
                data += chunk
        except AgentFileNotFound:
            raise FileNotFoundError(f"{source} 上没有日志 {path}") from None
    counts: dict[str, int] = {}
    latencies: list[float] = []
    for line in data.decode("utf-8", errors="replace").splitlines():
        fields = line.split()
        if not fields:
            continue
        if len(fields) < 6 or not fields[5].endswith("ms"):
            raise ValueError(f"日志行格式不对：{line!r}")
        counts[fields[4]] = counts.get(fields[4], 0) + 1
        latencies.append(float(fields[5].removesuffix("ms")))
    latencies.sort()
    p95 = latencies[math.ceil(0.95 * len(latencies)) - 1] if latencies else 0.0
    ctx.log.info("%s:%s 共 %d 个请求，p95 %.1f ms", source, path, len(latencies), p95)
    return {"total": len(latencies), "status_counts": counts, "p95_ms": p95}
