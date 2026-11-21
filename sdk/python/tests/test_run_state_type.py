"""`sfly.RunState`：节点引用 `${{ run.state }}` 时拿到的运行状态的类型（#452）。

类型和 packages/schema（zod，唯一来源）导出的 `run-state.schema.json` 是同一个形状；
`sfly build` 把 `RunState` 类型的参数标成 `x-sfly-type: run_state` 的对象输入。
"""

from __future__ import annotations

import importlib
import json
import sys
import typing
import zipfile
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from run_state_shape import hint_vs_schema, value_problems

import sfly
from sfly import RunState
from sfly.cli import main
from sfly.cli.scan import ScanError, input_schema, output_schema
from sfly.nodes import NodeDeclaration
from sfly.schemas import load_schema

CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "testdata" / "run-state-cases.json").read_text(
        encoding="utf-8"
    )
)["cases"]

#: `RunState` 是带标记的类型：类型检查器看到的是它里面的 TypedDict。
RUN_STATE_DICT = typing.get_args(RunState)[0]


def test_the_run_state_type_has_the_same_shape_as_the_exported_json_schema() -> None:
    # 有人改了契约（packages/schema 的 RunState），重新导出 JSON Schema 之后这条测试会失败：
    # 照着 schema 改 sdk/python/src/sfly/run_state.py 里的 TypedDict。
    assert hint_vs_schema(RUN_STATE_DICT, load_schema("run-state")) == []


def test_every_typed_dict_is_exported_from_the_package_root() -> None:
    names = [
        "RunState",
        "RunStateCancel",
        "RunStateChain",
        "RunStateError",
        "RunStateNode",
        "RunStateScenario",
        "RunStateSelf",
    ]

    for name in names:
        assert name in sfly.__all__
        assert hasattr(sfly, name)


def test_the_typed_dict_keys_are_those_of_the_schema_at_each_level() -> None:
    schema = load_schema("run-state")
    chain = schema["properties"]["chains"]["items"]
    node = chain["properties"]["nodes"]["items"]

    def keys(typed_dict: Any) -> set[str]:
        return set(typing.get_type_hints(typed_dict))

    assert keys(RUN_STATE_DICT) == set(schema["properties"])
    assert keys(sfly.RunStateChain) == set(chain["properties"])
    assert keys(sfly.RunStateNode) == set(node["properties"])
    assert keys(sfly.RunStateError) == set(node["properties"]["error"]["anyOf"][0]["properties"])
    assert keys(sfly.RunStateCancel) == set(
        schema["properties"]["cancel"]["anyOf"][0]["properties"]
    )
    assert keys(sfly.RunStateSelf) == set(schema["properties"]["self"]["anyOf"][0]["properties"])
    assert keys(sfly.RunStateScenario) == set(schema["properties"]["scenario"]["properties"])


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_expected_state_of_every_case_passes_the_schema_and_fits_the_type(
    case: dict[str, Any],
) -> None:
    expected = case["expected"]

    errors = list(Draft202012Validator(load_schema("run-state")).iter_errors(expected))

    assert errors == []
    assert value_problems(expected, RUN_STATE_DICT) == []


def test_a_value_with_a_missing_or_extra_key_does_not_fit_the_type() -> None:
    # 形状检查本身要查得出问题，上面的测试才有意义。
    expected = json.loads(json.dumps(CASES[0]["expected"]))
    del expected["truncated"]
    expected["chains"][0]["nodes"][0]["extra"] = 1

    problems = value_problems(expected, RUN_STATE_DICT)

    assert any("缺少 ['truncated']" in p for p in problems)
    assert any("多出 ['extra']" in p for p in problems)


def read_chain_failures(run: RunState) -> list[str]:
    """节点里读 `RunState` 的写法：`run["chains"]` 一路读下去能通过类型检查。"""
    nodes = {n["node_id"]: n for chain in run["chains"] for n in chain["nodes"]}
    return [
        f"{nodes[i]['display_name'] or i}：{err['headline']}"
        for i in run["failures"]
        if (err := nodes[i]["error"]) is not None
    ]


def _type_checks_done_by_mypy(run: RunState) -> None:
    """不会被调用：类型检查（mypy）读到这里，没有的键、可能为 None 的 `self` 都要报错。

    `# type: ignore` 在没有报错的行上本身就是错误（strict 的 warn_unused_ignores），
    所以 `RunState` 要是不再是那个 TypedDict，mypy 会在这里失败。
    """
    _ = run["nope"]  # type: ignore[typeddict-item]
    _ = run["self"]["node_id"]  # type: ignore[index]
    _ = run["chains"][0]["nodes"][0]["error"]


def test_the_type_checker_reads_the_run_state_as_a_typed_dict() -> None:
    # 上面函数里的检查由 mypy 做；这里确认节点里的读法在运行时也对。
    state: Any = json.loads(json.dumps(CASES[1]["expected"]))

    assert read_chain_failures(state) == ["a：ValueError: 余额不对"]


def test_package_show_names_the_run_state_type() -> None:
    from sfly.cli.package import type_label

    marked = {"type": "object", "x-sfly-type": "run_state"}

    assert type_label(marked) == "运行状态"
    assert type_label({"anyOf": [marked, {"type": "null"}]}) == "运行状态 | null"


PYPROJECT = """\
[project]
name = "demo-checks"
version = "1.2.0"
requires-python = ">=3.11"
dependencies = []
"""

RUN_STATE_MODULE = """\
from __future__ import annotations

from typing import Annotated

from sfly import Context, Doc, RunState, node


@node
def summary(
    ctx: Context,
    run: RunState,
    previous: RunState | None = None,
    note: Annotated[RunState | None, Doc("上一次的状态")] = None,
    text: str = "",
) -> dict:
    return {}
"""


def write_project(root: Path, module: str) -> Path:
    for rel, content in {
        "pyproject.toml": PYPROJECT,
        "src/demo_checks/__init__.py": module,
    }.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return root


def test_build_marks_run_state_inputs_as_run_state_objects(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    project = write_project(tmp_path, RUN_STATE_MODULE)

    assert main(["build", str(project)]) == 0, capsys.readouterr().err
    archive = project / "dist" / "demo-checks-1.2.0.sflypkg"
    with zipfile.ZipFile(archive) as zf:
        meta = json.loads(zf.read("sfly-package.json"))

    run_state_object = {"type": "object", "x-sfly-type": "run_state"}
    assert meta["nodes"][0]["inputs"] == {
        "type": "object",
        "properties": {
            "run": run_state_object,
            "previous": {"anyOf": [run_state_object, {"type": "null"}], "default": None},
            "note": {
                "anyOf": [run_state_object, {"type": "null"}],
                "default": None,
                "description": "上一次的状态",
            },
            "text": {"type": "string", "default": ""},
        },
        "required": ["run"],
        "order": ["run", "previous", "note", "text"],
    }
    errors = list(Draft202012Validator(load_schema("package-metadata")).iter_errors(meta))
    assert errors == []


def test_run_state_needs_no_future_import_to_be_a_param_type(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 注解不写成字符串（没有 from __future__ import annotations）时，`RunState | None` 照样能认出。
    (tmp_path / "plain_run_state_node.py").write_text(
        "from sfly import RunState\n\n\n"
        "def plain(run: RunState, backup: RunState | None = None) -> None: ...\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        module = importlib.import_module("plain_run_state_node")
        schema = input_schema(module.plain, "节点 plain")
    finally:
        sys.modules.pop("plain_run_state_node", None)

    marked = {"type": "object", "x-sfly-type": "run_state"}
    assert schema["properties"]["run"] == marked
    assert schema["properties"]["backup"] == {
        "anyOf": [marked, {"type": "null"}],
        "default": None,
    }


@pytest.mark.parametrize(
    "annotation",
    [
        "list[RunState]",
        "dict[str, RunState]",
        "RunState | int",
        "RunState | AgentName",
        "RunState | FeishuBot",
    ],
)
def test_run_state_is_only_allowed_as_the_type_of_a_node_parameter(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], annotation: str
) -> None:
    module = (
        "from __future__ import annotations\n\n"
        "from sfly import AgentName, FeishuBot, RunState, node\n\n"
        f"@node\ndef summary(runs: {annotation}) -> dict:\n    return {{}}\n"
    )
    project = write_project(tmp_path, module)

    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert "参数 runs" in err and "RunState 只能直接用作节点参数的类型" in err


def test_run_state_is_not_allowed_in_the_output_type(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        "from __future__ import annotations\n\nfrom sfly import RunState, node\n\n"
        '@node(outputs={"run": RunState})\ndef summary() -> dict:\n    return {}\n'
    )
    project = write_project(tmp_path, module)

    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert "RunState 只能直接用作节点参数的类型" in err


class ResultWithRunState(typing.TypedDict):
    run: RunState


def returns_run_state() -> ResultWithRunState:
    raise NotImplementedError


def test_scan_rejects_run_state_inside_a_typed_dict_field() -> None:
    declaration = NodeDeclaration(name=None, title=None, outputs=None)

    with pytest.raises(ScanError, match="RunState 只能直接用作节点参数的类型"):
        output_schema(returns_run_state, declaration, "节点 returns_run_state")
