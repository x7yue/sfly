"""`collect_artifacts`：在真实的执行器进程里把文件收集为产物（`sfly.testing.run_node`）。"""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

import pytest

from sfly.testing import Execution, run_node
from sfly_std.collect_artifacts import collect_artifacts


def make_files(root: Path, files: dict[str, str]) -> Path:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


def run(tmp_path: Path, **inputs: Any) -> Execution:
    return run_node(collect_artifacts, inputs, work_dir=tmp_path / "task")


def test_collects_files_matching_the_wildcards_and_outputs_their_refs(tmp_path: Path) -> None:
    base = make_files(
        tmp_path / "out",
        {"app.log": "启动完成\n", "db.log": "ok\n", "report.json": "{}", "notes.txt": "无关"},
    )

    result = run(tmp_path, paths=["*.log", "report.json"], base_dir=str(base))

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert sorted(result.artifacts) == ["app.log", "db.log", "report.json"]
    assert result.artifacts["app.log"].read_text(encoding="utf-8") == "启动完成\n"
    # 本地调试时产物引用是产物的本地文件路径（Agent 上是下载地址）。
    assert result.outputs == {"refs": {name: str(path) for name, path in result.artifacts.items()}}


def test_a_matched_directory_is_collected_with_everything_inside_it(tmp_path: Path) -> None:
    base = make_files(
        tmp_path / "out",
        {"logs/a.log": "a", "logs/深/b.log": "b", "logs/.hidden": "h", "keep.txt": "k"},
    )

    result = run(tmp_path, paths=["logs"], base_dir=str(base))

    assert result.status == "success", result.error
    assert sorted(result.artifacts) == ["logs/.hidden", "logs/a.log", "logs/深/b.log"]


def test_double_star_matches_in_every_subdirectory(tmp_path: Path) -> None:
    base = make_files(
        tmp_path / "out",
        {"a.log": "1", "x/b.log": "2", "x/y/c.log": "3", "x/y/c.txt": "4"},
    )

    result = run(tmp_path, paths=["**/*.log"], base_dir=str(base))

    assert result.status == "success", result.error
    assert sorted(result.artifacts) == ["a.log", "x/b.log", "x/y/c.log"]


def test_base_dir_defaults_to_the_task_work_dir_without_collecting_its_own_artifacts(
    tmp_path: Path,
) -> None:
    # Agent 在执行前就创建了产物目录 artifacts/。
    make_files(tmp_path / "task", {"result.txt": "结果", "artifacts/earlier.txt": "已有"})

    result = run(tmp_path, paths=["*"])

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert "result.txt" in result.outputs["refs"]
    assert not [name for name in result.outputs["refs"] if name.startswith("artifacts/")]


def test_fails_naming_the_patterns_and_base_dir_when_nothing_matched(tmp_path: Path) -> None:
    base = make_files(tmp_path / "out", {"notes.txt": "无关"})

    result = run(tmp_path, paths=["*.log", "reports/"], base_dir=str(base))

    assert result.status == "failed", result.outputs
    assert result.error is not None
    assert result.error.message == (
        "sfly_std.collect_artifacts.NothingCollected: "
        f'{base} 下没有匹配 ["*.log", "reports/"] 的文件'
    )


def test_succeeds_with_no_refs_when_nothing_matched_and_not_required(tmp_path: Path) -> None:
    base = make_files(tmp_path / "out", {"notes.txt": "无关"})

    result = run(tmp_path, paths=["*.log"], base_dir=str(base), required=False)

    assert result.status == "success", result.error
    assert result.outputs == {"refs": {}}
    assert result.artifacts == {}


def test_archive_packs_the_matched_files_into_one_zip(tmp_path: Path) -> None:
    base = make_files(tmp_path / "out", {"app.log": "启动完成\n", "logs/深/b.log": "b"})

    result = run(tmp_path, paths=["*.log", "logs"], base_dir=str(base), archive=True)

    assert result.status == "success", result.error
    assert list(result.artifacts) == ["artifacts.zip"]
    assert result.outputs == {"refs": {"artifacts.zip": str(result.artifacts["artifacts.zip"])}}
    with zipfile.ZipFile(result.artifacts["artifacts.zip"]) as zf:
        assert sorted(zf.namelist()) == ["app.log", "logs/深/b.log"]
        assert zf.read("app.log").decode() == "启动完成\n"


@pytest.mark.parametrize(
    ("paths", "message"),
    [
        ([], "ValueError: paths 至少要有一个通配符"),
        (
            ["/var/log/*.log"],
            "ValueError: paths 里的通配符必须是相对 base_dir 的路径，实际为 '/var/log/*.log'",
        ),
        (["logs/../../*.log"], "ValueError: paths 里的通配符不能含 ..，实际为 'logs/../../*.log'"),
        ([""], "ValueError: paths 里的通配符不能为空"),
    ],
)
def test_rejects_wildcards_outside_base_dir(tmp_path: Path, paths: list[str], message: str) -> None:
    base = make_files(tmp_path / "out", {"app.log": "a"})

    result = run(tmp_path, paths=paths, base_dir=str(base))

    assert result.status == "failed", result.outputs
    assert result.error is not None
    assert result.error.message == message


def test_fails_when_base_dir_does_not_exist(tmp_path: Path) -> None:
    result = run(tmp_path, paths=["*.log"], base_dir=str(tmp_path / "missing"))

    assert result.status == "failed", result.outputs
    assert result.error is not None
    assert result.error.message == f"FileNotFoundError: base_dir 不存在：{tmp_path / 'missing'}"


def test_logs_what_was_collected(tmp_path: Path) -> None:
    base = make_files(tmp_path / "out", {"a.log": "12345", "b.log": "678"})

    result = run(tmp_path, paths=["*.log"], base_dir=str(base))

    assert result.status == "success", result.error
    assert [line.message for line in result.logs if line.source == "sdk"] == [
        f"从 {base} 收集了 2 个文件，共 8 字节"
    ]


def test_fails_before_saving_anything_when_refs_would_exceed_the_output_limit(
    tmp_path: Path,
) -> None:
    # 节点输出不能超过 1 MB：1200 个 250 字符的文件名，refs 约 700 KB，超过 refs 的 512 KiB 上限。
    base = make_files(tmp_path / "out", {f"{i:04d}{'x' * 246}": "" for i in range(1200)})

    result = run(tmp_path, paths=["*"], base_dir=str(base))

    assert result.status == "failed"
    assert result.error is not None
    message = result.error.message
    assert message.startswith(
        "sfly_std.collect_artifacts.TooManyRefs: 匹配到 1200 个文件，refs 共 "
    )
    assert "超过 512 KiB 的上限" in message
    assert "archive=true" in message
    assert result.artifacts == {}


def test_archive_collects_files_too_many_to_list_in_refs(tmp_path: Path) -> None:
    base = make_files(tmp_path / "out", {f"{i:04d}{'x' * 246}": "" for i in range(1200)})

    result = run(tmp_path, paths=["*"], base_dir=str(base), archive=True)

    assert result.status == "success", result.error
    assert result.outputs is not None
    assert list(result.outputs["refs"]) == ["artifacts.zip"]
    with zipfile.ZipFile(result.artifacts["artifacts.zip"]) as zf:
        assert len(zf.namelist()) == 1200
