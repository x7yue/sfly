"""持续运行的节点（`system_monitor`、`process_monitor`、`follow_log`）共用的参数校验与速率计算。"""

from __future__ import annotations


def validate_interval(interval: float) -> None:
    """采样间隔必须大于 0（为 0 时采样循环会忙等）。"""
    if interval <= 0:
        raise ValueError(f"interval 必须大于 0，实际为 {interval:g}")


def validate_duration(duration: float | None) -> None:
    """`duration` 不设置时一直运行；设置时必须大于 0（为 0 时一次都不采样就结束，没有意义）。"""
    if duration is not None and duration <= 0:
        raise ValueError(f"duration 必须大于 0，实际为 {duration:g}")


def rate(current: float, previous: float, elapsed: float) -> float:
    """两次读数之间每秒的增量；计数器被重置（例如网卡重新插拔、进程换了）时不报负数。"""
    return max(current - previous, 0) / elapsed
