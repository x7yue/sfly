"""任务上下文 `Context`：节点函数的首个参数。只用标准库（ADR 0002）。

日志、进度、产物、取消检查由执行器票据（#5）实现；
这里先提供类型，供节点代码注解和 `sfly build` 识别。
"""

from __future__ import annotations


class Context:
    """节点执行时由执行器传入的任务上下文。"""
