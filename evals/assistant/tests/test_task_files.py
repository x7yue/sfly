"""题目用到的文件都被 git 跟踪：被 .gitignore 挡掉的文件在干净的检出里不存在，题目就起不来。"""

import subprocess
from pathlib import Path

import pytest
from aeval.tasks import TASKS_DIR, Task, UndeclaredFile
from aeval.tasks.registry import TASKS
from aeval.toolcheck import ToolCheck

REPO = TASKS_DIR.parent.parent.parent


def tracked(path: Path) -> set[str]:
    out = subprocess.run(
        ["git", "ls-files", "--", str(path)], cwd=REPO, capture_output=True, text=True, check=True
    )
    return {line for line in out.stdout.splitlines() if line}


def on_disk(path: Path) -> set[str]:
    if path.is_file():
        return {str(path.relative_to(REPO))}
    return {
        str(f.relative_to(REPO))
        for f in path.rglob("*")
        if f.is_file() and "__pycache__" not in f.parts and ".ruff_cache" not in f.parts
    }


@pytest.mark.parametrize("task", [*TASKS.values(), ToolCheck()], ids=lambda t: t.id)
def test_declared_files_are_tracked(task: Task) -> None:
    for relative in (*task.files, f"{task.id}/prompt.md"):
        path = TASKS_DIR / relative
        if task.id == "toolcheck" and relative.endswith("prompt.md"):
            continue  # 工具自检的提示写在代码里
        files = tracked(path)
        assert files, f"{relative} 没有被 git 跟踪"
        assert on_disk(path) <= files, (
            f"{relative} 下有没被 git 跟踪的文件：{on_disk(path) - files}"
        )


def test_undeclared_file_is_refused() -> None:
    with pytest.raises(UndeclaredFile):
        TASKS["write"].data("hidden", "other.py")


def test_offline_pack_copies_only_tracked_files(tmp_path: Path) -> None:
    from aeval.offline import copy_tracked

    files = copy_tracked(tmp_path)
    assert "tasks/write/fixtures/app.log" in files
    assert not any("__pycache__" in f for f in files)
    assert {str(p.relative_to(tmp_path)) for p in tmp_path.rglob("*") if p.is_file()} == set(files)
