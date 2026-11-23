"""`docs/guide/sdk-reference.md`「大小上限：大文件怎么办」里的例子照着执行（#477）。

团队的约定是用户文档里的每个例子都有一条照着执行的测试，不只是 ruff 检查。这里不另抄一份：
直接从文档里取出这一节的代码块，原样写成模块、导入、调用，用 `Context(artifact_limit_bytes=...)`
跑它的两条分支——放得下返回产物引用，放不下返回本机路径；文档改了例子，这个测试跟着跑改过的代码。
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import ModuleType

import pytest

from sfly import Context
from sfly.context import TaskInfo
from sfly.nodes import NODE_ATTR

GUIDE = Path(__file__).resolve().parents[3] / "docs" / "guide" / "sdk-reference.md"
HEADING = "### 大小上限：大文件怎么办"


def example_source() -> str:
    text = GUIDE.read_text(encoding="utf-8")
    start = text.index(HEADING)
    end = text.index("\n### ", start + len(HEADING))
    block = re.search(r"```python\n(.*?)```", text[start:end], re.S)
    assert block, f"{HEADING} 这一节里没有 python 代码块"
    return block.group(1)


@pytest.fixture
def example(tmp_path: Path) -> ModuleType:
    module_file = tmp_path / "limit_example.py"
    module_file.write_text(example_source(), encoding="utf-8")
    spec = importlib.util.spec_from_file_location("limit_example", module_file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def context(tmp_path: Path, limit: int | None) -> Context:
    return Context(
        events_path=None,
        cancel_path=None,
        artifacts_dir=tmp_path / "artifacts",
        artifacts_url="http://cp/tasks/t-1/artifacts/",
        artifact_limit_bytes=limit,
    )


def test_the_example_is_a_node_that_declares_both_outputs(example: ModuleType) -> None:
    declaration = getattr(example.export_data, NODE_ATTR)

    assert list(declaration.outputs) == ["export", "export_path"]


def test_when_it_fits_the_file_is_saved_as_an_artifact_and_the_path_is_none(
    example: ModuleType, tmp_path: Path
) -> None:
    keep = tmp_path / "keep"

    outputs = example.export_data(context(tmp_path, 10_000), rows=10, keep_dir=str(keep))

    assert outputs == {
        "export": "http://cp/tasks/t-1/artifacts/export.csv",
        "export_path": None,
    }
    assert (
        (tmp_path / "artifacts" / "export.csv").read_text(encoding="utf-8").startswith("0,0\n1,1\n")
    )


def test_when_it_does_not_fit_the_file_stays_on_the_machine_and_the_artifact_is_none(
    example: ModuleType, tmp_path: Path
) -> None:
    keep = tmp_path / "keep"

    outputs = example.export_data(context(tmp_path, 20), rows=100, keep_dir=str(keep))

    assert outputs == {"export": None, "export_path": str(keep / "export-local.csv")}
    assert (keep / "export-local.csv").is_file()
    assert not (tmp_path / "artifacts" / "export.csv").exists()


def test_without_a_limit_it_is_always_saved(example: ModuleType, tmp_path: Path) -> None:
    outputs = example.export_data(context(tmp_path, None), rows=5000, keep_dir=str(tmp_path / "k"))

    assert outputs["export"] is not None and outputs["export_path"] is None


def test_both_branches_return_exactly_the_declared_keys(
    example: ModuleType, tmp_path: Path
) -> None:
    declared = set(getattr(example.export_data, NODE_ATTR).outputs)

    fits = example.export_data(
        context(tmp_path / "a", 10_000), rows=1, keep_dir=str(tmp_path / "ka")
    )
    stays = example.export_data(context(tmp_path / "b", 1), rows=1, keep_dir=str(tmp_path / "kb"))

    assert set(fits) == declared
    assert set(stays) == declared


def test_two_tasks_on_the_same_machine_do_not_overwrite_each_others_file(
    example: ModuleType, tmp_path: Path
) -> None:
    """留在本机的文件名带任务 ID：并发的任务、下一次运行，都不会覆盖输出里给出的那个文件。"""
    keep = tmp_path / "keep"

    def context_of(task_id: str) -> Context:
        return Context(
            events_path=None,
            cancel_path=None,
            artifacts_dir=tmp_path / task_id / "artifacts",
            artifacts_url="http://cp/tasks/t/artifacts/",
            artifact_limit_bytes=20,
            task=TaskInfo(task_id=task_id),
        )

    first = example.export_data(context_of("task-1"), rows=100, keep_dir=str(keep))
    second = example.export_data(context_of("task-2"), rows=50, keep_dir=str(keep))

    assert first["export_path"] != second["export_path"]
    assert Path(first["export_path"]).read_text(encoding="utf-8").count("\n") == 100
    assert Path(second["export_path"]).read_text(encoding="utf-8").count("\n") == 50
