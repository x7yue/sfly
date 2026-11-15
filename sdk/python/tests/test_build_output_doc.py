"""输出 TypedDict 字段注解里的 `Doc("…")`：写进输出 schema 的 description，写错的规则和输入一样。"""

from __future__ import annotations

from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from test_build import PYPROJECT, build, nodes_by_name, read_metadata, write_project

from sfly.cli import main
from sfly.schemas import load_schema

HEADER = (
    "from __future__ import annotations\n\n"
    "from typing import Annotated, TypedDict\n\n"
    "from sfly import Doc, node\n\n"
)


def project_with(root: Path, module: str, header: str = HEADER) -> Path:
    return write_project(
        root, {"pyproject.toml": PYPROJECT, "src/demo_checks/__init__.py": header + module}
    )


DOCUMENTED = """\
class Location(TypedDict):
    host: Annotated[str, Doc("机器的主机名")]
    port: int


class CheckOutputs(TypedDict):
    status: Annotated[int, Doc("HTTP 状态码")]
    body_file: Annotated[str | None, Doc("  响应体保存的文件，首尾空白不保存  ")]
    elapsed_ms: Annotated[float, Doc("总耗时，单位毫秒")]
    plain: str
    where: Annotated[Location, Doc("请求打到的位置")]


@node
def http_check(url: str) -> CheckOutputs:
    return {}
"""


def test_output_docs_become_the_description_of_the_output_schema(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta = read_metadata(build(project_with(tmp_path, DOCUMENTED), capsys))

    assert nodes_by_name(meta)["http_check"]["outputs"] == {
        "type": "object",
        "properties": {
            "status": {"type": "integer", "description": "HTTP 状态码"},
            "body_file": {
                "anyOf": [{"type": "string"}, {"type": "null"}],
                "description": "响应体保存的文件，首尾空白不保存",
            },
            "elapsed_ms": {"type": "number", "description": "总耗时，单位毫秒"},
            "plain": {"type": "string"},
            "where": {
                "type": "object",
                "properties": {
                    "host": {"type": "string", "description": "机器的主机名"},
                    "port": {"type": "integer"},
                },
                "required": ["host", "port"],
                "description": "请求打到的位置",
            },
        },
        "required": ["status", "body_file", "elapsed_ms", "plain", "where"],
    }
    errors = list(Draft202012Validator(load_schema("package-metadata")).iter_errors(meta))
    assert errors == []


def test_output_docs_work_without_postponed_annotations(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        "from typing import Annotated, TypedDict\n\nfrom sfly import Doc, node\n\n\n"
        "class Outputs(TypedDict):\n"
        '    status: Annotated[int, Doc("HTTP 状态码")]\n\n\n'
        "@node\ndef ping() -> Outputs:\n    return {}\n"
    )

    meta = read_metadata(build(project_with(tmp_path, module, header=""), capsys))

    assert nodes_by_name(meta)["ping"]["outputs"]["properties"] == {
        "status": {"type": "integer", "description": "HTTP 状态码"}
    }


def test_not_required_outputs_keep_working_and_take_docs_inside_or_outside_the_qualifier(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        "from typing import Annotated, NotRequired, Required, TypedDict\n\n"
        "from sfly import Doc, node\n\n\n"
        "class Outputs(TypedDict, total=False):\n"
        '    inside: NotRequired[Annotated[int, Doc("限定符在外面")]]\n'
        '    outside: Annotated[NotRequired[int], Doc("限定符在里面")]\n'
        "    bare: NotRequired[int]\n"
        '    must: Required[Annotated[str, Doc("total=False 里的必有项")]]\n\n\n'
        "@node\ndef ping() -> Outputs:\n    return {}\n"
    )

    meta = read_metadata(build(project_with(tmp_path, module, header=""), capsys))

    assert nodes_by_name(meta)["ping"]["outputs"] == {
        "type": "object",
        "properties": {
            "inside": {"type": "integer", "description": "限定符在外面"},
            "outside": {"type": "integer", "description": "限定符在里面"},
            "bare": {"type": "integer"},
            "must": {"type": "string", "description": "total=False 里的必有项"},
        },
        "required": ["must"],
    }


def test_the_dict_form_of_outputs_takes_docs_too(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        '@node(outputs={"rows": Annotated[int, Doc("写入的行数")], "table": str})\n'
        "def prepare() -> dict:\n    return {}\n"
    )

    meta = read_metadata(build(project_with(tmp_path, module), capsys))

    assert nodes_by_name(meta)["prepare"]["outputs"]["properties"] == {
        "rows": {"type": "integer", "description": "写入的行数"},
        "table": {"type": "string"},
    }


def test_outputs_without_docs_have_no_description_and_build_says_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        "class Outputs(TypedDict):\n    status: int\n    note: str\n\n\n"
        "@node\ndef ping() -> Outputs:\n    return {}\n"
    )
    project = project_with(tmp_path, module)

    assert main(["build", str(project)]) == 0
    out, err = capsys.readouterr()
    meta = read_metadata(next((project / "dist").glob("*.sflypkg")))

    assert nodes_by_name(meta)["ping"]["outputs"] == {
        "type": "object",
        "properties": {"status": {"type": "integer"}, "note": {"type": "string"}},
        "required": ["status", "note"],
    }
    assert "description" not in out and err == ""


def doc_of_length(count: int, char: str = "字") -> str:
    return f'Annotated[str, Doc("{char * count}")]'


def errors_for(tmp_path: Path, capsys: pytest.CaptureFixture[str], field: str) -> str:
    module = (
        f"class Outputs(TypedDict):\n    status: int\n    {field}\n\n\n"
        "@node\ndef ping() -> Outputs:\n    return {}\n"
    )
    project = project_with(tmp_path, module)
    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert not (project / "dist").exists()
    return err


@pytest.mark.parametrize(
    ("field", "problem"),
    [
        ('host: Annotated[str, Doc("")]', "Doc 必须是非空字符串"),
        ('host: Annotated[str, Doc("  \\n ")]', "Doc 必须是非空字符串"),
        ("host: Annotated[str, Doc(42)]", "Doc 必须是非空字符串"),
        ("host: Annotated[str, Doc(None)]", "Doc 必须是非空字符串"),
        ('host: Annotated[str, Doc("甲"), Doc("乙")]', "同一个注解里有 2 个 Doc"),
        ('host: Annotated[Annotated[str, Doc("甲")], Doc("乙")]', "同一个注解里有 2 个 Doc"),
        (f"host: {doc_of_length(501)}", "说明超过 500 个字符（501 个）"),
        (f"host: {doc_of_length(501, '😀')}", "说明超过 500 个字符（501 个）"),
        ('host: list[Annotated[str, Doc("每个主机")]]', "Doc 只能写在注解的最外层"),
        ('host: Annotated[str, Doc("主机")] | None', "Doc 只能写在注解的最外层"),
    ],
)
def test_wrong_output_docs_are_build_errors_naming_the_node_and_the_output(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], field: str, problem: str
) -> None:
    err = errors_for(tmp_path, capsys, field)

    assert "节点 demo_checks.ping 的输出 host：" + problem in err


def test_a_wrong_doc_in_the_dict_form_of_outputs_is_a_build_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        '@node(outputs={"rows": Annotated[int, Doc("")]})\ndef prepare() -> dict:\n    return {}\n'
    )
    project = project_with(tmp_path, module)

    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert "节点 demo_checks.prepare 的输出 rows：Doc 必须是非空字符串" in err


def test_a_wrong_doc_inside_a_nested_typeddict_names_the_nested_field(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        'class Inner(TypedDict):\n    host: Annotated[str, Doc("")]\n\n\n'
        "class Outputs(TypedDict):\n    where: Inner\n\n\n"
        "@node\ndef ping() -> Outputs:\n    return {}\n"
    )
    project = project_with(tmp_path, module)

    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert "节点 demo_checks.ping 的输出 where：字段 host：Doc 必须是非空字符串" in err


@pytest.mark.parametrize("char", ["字", "😀"])
def test_an_output_doc_of_exactly_500_characters_is_accepted(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], char: str
) -> None:
    module = (
        f"class Outputs(TypedDict):\n    host: {doc_of_length(500, char)}\n\n\n"
        "@node\ndef ping() -> Outputs:\n    return {}\n"
    )
    meta = read_metadata(build(project_with(tmp_path, module), capsys))

    description = nodes_by_name(meta)["ping"]["outputs"]["properties"]["host"]["description"]
    assert description == char * 500


def test_sfly_debug_and_sfly_dev_report_the_same_output_error_as_build(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        'class Outputs(TypedDict):\n    host: Annotated[str, Doc("")]\n\n\n'
        "@node\ndef ping() -> Outputs:\n    return {}\n"
    )
    project = project_with(tmp_path, module)
    problem = "节点 demo_checks.ping 的输出 host：Doc 必须是非空字符串"

    assert main(["build", str(project)]) == 1
    assert problem in capsys.readouterr().err
    assert main(["debug", "ping", "--project", str(project), "--params", "{}"]) == 1
    assert problem in capsys.readouterr().err
    assert main(["dev", str(project), "--socket", str(tmp_path / "no-agent.sock")]) == 1
    assert problem in capsys.readouterr().err
