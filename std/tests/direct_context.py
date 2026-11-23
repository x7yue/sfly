"""直接调用辅助函数的测试用的 `Context`：不经执行器，事件写进文件，测试里读回来断言。

    run = DirectRun(tmp_path)
    result = run_command(run.ctx, "echo hi")
    assert run.logs()

`run_node` 在真实的执行器进程里跑节点，适合测试节点；辅助函数有自己的参数、返回值和异常，
直接调用它们测试更直接，需要 `Context` 时用这里的。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from sfly import Context, Metric
from sfly.context import TaskInfo


class DirectRun:
    """一个临时的任务环境：工作目录、产物目录、后台进程目录和事件文件都在 `root` 下。

    `artifacts=False` 时没有产物目录（`ctx.artifacts` 的读写抛出 `RuntimeError`）。
    """

    def __init__(
        self,
        root: Path,
        *,
        metrics: Sequence[Metric] | None = None,
        node_id: str = "node",
        artifacts: bool = True,
    ) -> None:
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.events_path = root / "events.jsonl"
        self.cancel_path = root / "cancel"
        self.ctx = Context(
            events_path=self.events_path,
            cancel_path=self.cancel_path,
            artifacts_dir=root / "artifacts" if artifacts else None,
            artifacts_url="http://artifacts.invalid" if artifacts else None,
            metrics=metrics,
            task=TaskInfo(run_id="run", node_id=node_id, task_id="task", attempt=1),
            procs_dir=root / "procs",
        )

    def cancel(self) -> None:
        """写取消标记：`ctx.cancelled()` 之后为真。"""
        self.cancel_path.write_text("")

    def events(self, kind: str | None = None) -> list[dict[str, Any]]:
        if not self.events_path.exists():
            return []
        found = [json.loads(line) for line in self.events_path.read_text().splitlines()]
        return [e for e in found if kind is None or e["type"] == kind]

    def logs(self, level: str | None = None) -> list[str]:
        return [e["message"] for e in self.events("log") if level is None or e["level"] == level]

    def metric(self, name: str) -> list[float]:
        return [e["value"] for e in self.events("metric") if e["name"] == name]
