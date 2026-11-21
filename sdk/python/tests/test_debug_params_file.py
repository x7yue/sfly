"""`sfly debug --params @文件`：节点的输入从文件读（`@-` 从标准输入读），
和 `sfly api --body @文件` 一致。

目标场景：把一次真实运行的运行状态存成文件，放进 `{"run": ...}`，
在本地用它调试读 `sfly.RunState` 的节点。
CLI 作为子进程运行，项目是桩节点包的副本。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]
STUB = ROOT / "testdata" / "stub-package"
SFLY = str(Path(sys.executable).parent / "sfly")
CASES = json.loads((ROOT / "testdata" / "run-state-cases.json").read_text(encoding="utf-8"))[
    "cases"
]

RUN_STATE_NODE = """
from sfly import Context, RunState, node


@node
def summary(ctx: Context, run: RunState, previous: RunState | None = None, label: str = "") -> dict:
    return {
        "run": run,
        "run_is_a_dict": type(run) is dict,
        "previous": previous,
        "failures": run["failures"],
        "label": label,
    }
"""


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "stub"
    shutil.copytree(STUB, root, ignore=shutil.ignore_patterns("__pycache__", "dist"))
    (root / "src" / "sfly_stub" / "run_states.py").write_text(RUN_STATE_NODE, encoding="utf-8")
    return root


def sfly_debug(
    project: Path, *args: str, stdin: str | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [SFLY, "debug", *args],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=60,
        input=stdin,
    )


def outputs_of(stdout: str) -> Any:
    """标准输出里「输出：」后面的 JSON。"""
    value, _ = json.JSONDecoder().raw_decode(stdout.split("输出：\n", 1)[1])
    return value


def failed_case() -> dict[str, Any]:
    case = next(c for c in CASES if c["name"].startswith("有节点失败"))
    expected: dict[str, Any] = case["expected"]
    return expected


def test_params_are_read_from_a_file_and_the_node_gets_the_run_state_as_a_dict(
    project: Path,
) -> None:
    state = failed_case()
    (project / "params.json").write_text(
        json.dumps({"run": state, "label": "夜间"}, ensure_ascii=False), encoding="utf-8"
    )

    run = sfly_debug(project, "summary", "--params", "@params.json")

    assert run.returncode == 0, run.stderr
    outputs = outputs_of(run.stdout)
    assert outputs["run_is_a_dict"] is True
    assert outputs["run"] == state
    assert outputs["failures"] == ["a"]
    assert outputs["label"] == "夜间"
    assert outputs["previous"] is None


def test_params_are_read_from_standard_input_with_at_dash(project: Path) -> None:
    text = json.dumps({"run": failed_case(), "previous": failed_case()}, ensure_ascii=False)

    run = sfly_debug(project, "summary", "--params", "@-", stdin=text)

    assert run.returncode == 0, run.stderr
    outputs = outputs_of(run.stdout)
    assert outputs["run"] == outputs["previous"] == failed_case()


def test_a_file_path_is_relative_to_the_current_directory_not_the_project(
    project: Path, tmp_path: Path
) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "p.json").write_text(json.dumps({"run": failed_case()}), encoding="utf-8")

    run = subprocess.run(
        [SFLY, "debug", "summary", "--project", str(project), "--params", "@p.json"],
        cwd=elsewhere,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert run.returncode == 0, run.stderr
    assert outputs_of(run.stdout)["failures"] == ["a"]


def test_json_text_is_still_accepted_for_a_run_state_input(project: Path) -> None:
    run = sfly_debug(project, "summary", "--params", '{"run": ' + json.dumps(failed_case()) + "}")

    assert run.returncode == 0, run.stderr


@pytest.mark.parametrize("value", [1, "text", [1], None])
def test_a_run_state_input_must_be_an_object(project: Path, value: object) -> None:
    (project / "p.json").write_text(json.dumps({"run": value}), encoding="utf-8")

    run = sfly_debug(project, "summary", "--params", "@p.json")

    assert run.returncode == 2
    assert "输入 run 应为 object" in run.stderr


def test_a_run_state_input_is_required_and_the_optional_one_may_be_null(project: Path) -> None:
    (project / "p.json").write_text(json.dumps({"previous": None}), encoding="utf-8")

    run = sfly_debug(project, "summary", "--params", "@p.json")

    assert run.returncode == 2
    assert "缺少必填输入 run" in run.stderr


def test_a_missing_file_is_named_in_the_error_and_the_node_does_not_run(project: Path) -> None:
    run = sfly_debug(project, "summary", "--params", "@nope.json")

    assert run.returncode == 2
    assert run.stdout == ""
    assert "参数不合法" in run.stderr and "nope.json" in run.stderr and "不存在" in run.stderr
    assert not (project / ".sfly").exists()


def test_a_directory_is_not_a_params_file(project: Path) -> None:
    (project / "dir.json").mkdir()

    run = sfly_debug(project, "summary", "--params", "@dir.json")

    assert run.returncode == 2
    assert "dir.json" in run.stderr and "是目录" in run.stderr


def test_a_file_that_is_not_utf8_cannot_be_read(project: Path) -> None:
    (project / "bad.json").write_bytes(b'{"run": "\xff\xfe"}')

    run = sfly_debug(project, "summary", "--params", "@bad.json")

    assert run.returncode == 2
    assert "读不了 --params 的文件 bad.json" in run.stderr


@pytest.mark.parametrize("text", ["", "{", "{'run': 1}", "not json"])
def test_a_file_that_is_not_json_is_rejected_with_its_path(project: Path, text: str) -> None:
    (project / "p.json").write_text(text, encoding="utf-8")

    run = sfly_debug(project, "summary", "--params", "@p.json")

    assert run.returncode == 2
    assert "参数不合法" in run.stderr
    assert "p.json" in run.stderr and "不是合法的 JSON" in run.stderr


@pytest.mark.parametrize("text", ["[1, 2]", '"x"', "3", "null"])
def test_a_file_that_is_not_a_json_object_is_rejected_with_its_path(
    project: Path, text: str
) -> None:
    (project / "p.json").write_text(text, encoding="utf-8")

    run = sfly_debug(project, "summary", "--params", "@p.json")

    assert run.returncode == 2
    assert "p.json" in run.stderr and "必须是 JSON 对象" in run.stderr


def test_standard_input_that_is_not_json_is_rejected(project: Path) -> None:
    run = sfly_debug(project, "summary", "--params", "@-", stdin="{")

    assert run.returncode == 2
    assert "标准输入" in run.stderr and "不是合法的 JSON" in run.stderr


def test_json_text_that_is_not_json_still_says_so_and_points_to_files(project: Path) -> None:
    run = sfly_debug(project, "summary", "--params", "{")

    assert run.returncode == 2
    assert "--params 不是合法的 JSON" in run.stderr
    assert "@文件" in run.stderr


def test_the_help_describes_params_files() -> None:
    run = subprocess.run([SFLY, "debug", "--help"], capture_output=True, text=True, timeout=60)

    assert run.returncode == 0
    assert "@文件" in run.stdout and "@-" in run.stdout
