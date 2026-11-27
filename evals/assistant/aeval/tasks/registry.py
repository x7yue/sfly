"""全部题目，按 id 查找。加题：在 aeval/tasks/ 下写一个 Task 子类，在这里登记。"""

from __future__ import annotations

from aeval.tasks import Task
from aeval.tasks.cross import Cross
from aeval.tasks.daemon import Daemon
from aeval.tasks.fix import Fix
from aeval.tasks.orchestrate import Orchestrate
from aeval.tasks.write import Write

TASKS: dict[str, Task] = {t.id: t for t in (Write(), Fix(), Orchestrate(), Cross(), Daemon())}
