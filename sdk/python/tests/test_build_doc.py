"""`Annotated[T, Doc("…")]`：输入的说明写进元信息，写错时 build、dev、debug 都报错。"""

from __future__ import annotations

from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from test_build import PYPROJECT, build, nodes_by_name, read_metadata, write_project

from sfly.cli import main
from sfly.schemas import load_schema

HEADER = "from __future__ import annotations\n\nfrom typing import Annotated\n\n"


def project_with(root: Path, module: str) -> Path:
    return write_project(
        root, {"pyproject.toml": PYPROJECT, "src/demo_checks/__init__.py": HEADER + module}
    )


DOCUMENTED = """\
from sfly import AgentName, Context, Doc, node


@node
def http_check(
    ctx: Context,
    url: Annotated[str, Doc("请求地址，带协议")],
    expect: Annotated[int, Doc("期望的状态码")] = 200,
    note: Annotated[str | None, Doc("  备注，首尾空白不保存  ")] = None,
    target: Annotated[AgentName, Doc("在哪台 Agent 上检查")] = "",
    plain: str = "没写说明",
) -> dict:
    return {}
"""


def test_input_docs_become_the_description_of_the_input_schema(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta = read_metadata(build(project_with(tmp_path, DOCUMENTED), capsys))

    assert nodes_by_name(meta)["http_check"]["inputs"] == {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "请求地址，带协议"},
            "expect": {"type": "integer", "description": "期望的状态码", "default": 200},
            "note": {
                "anyOf": [{"type": "string"}, {"type": "null"}],
                "description": "备注，首尾空白不保存",
                "default": None,
            },
            "target": {
                "type": "string",
                "x-sfly-type": "agent",
                "description": "在哪台 Agent 上检查",
                "default": "",
            },
            "plain": {"type": "string", "default": "没写说明"},
        },
        "required": ["url"],
        "order": ["url", "expect", "note", "target", "plain"],
    }
    errors = list(Draft202012Validator(load_schema("package-metadata")).iter_errors(meta))
    assert errors == []


def test_docs_work_without_postponed_annotations(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        "from typing import Annotated\n\nfrom sfly import Doc, node\n\n"
        '@node\ndef ping(host: Annotated[str, Doc("目标主机")]) -> dict:\n    return {}\n'
    )
    project = write_project(
        tmp_path, {"pyproject.toml": PYPROJECT, "src/demo_checks/__init__.py": module}
    )

    meta = read_metadata(build(project, capsys))

    assert nodes_by_name(meta)["ping"]["inputs"]["properties"] == {
        "host": {"type": "string", "description": "目标主机"}
    }


def test_inputs_without_docs_have_no_description_and_build_says_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        "from sfly import Context, node\n\n"
        "@node\ndef ping(ctx: Context, host: str, retries: int = 3) -> dict:\n    return {}\n"
    )
    project = project_with(tmp_path, module)

    assert main(["build", str(project)]) == 0
    out, err = capsys.readouterr()
    meta = read_metadata(next((project / "dist").glob("*.sflypkg")))

    assert nodes_by_name(meta)["ping"]["inputs"]["properties"] == {
        "host": {"type": "string"},
        "retries": {"type": "integer", "default": 3},
    }
    assert "description" not in out and err == ""


def doc_of_length(count: int, char: str = "字") -> str:
    return f'Annotated[str, Doc("{char * count}")]'


def errors_for(tmp_path: Path, capsys: pytest.CaptureFixture[str], parameter: str) -> str:
    module = (
        "from sfly import Context, Doc, node\n\n"
        f"@node\ndef ping(ctx: Context, {parameter}) -> dict:\n    return {{}}\n"
    )
    project = project_with(tmp_path, module)
    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert not (project / "dist").exists()
    return err


@pytest.mark.parametrize(
    ("parameter", "problem"),
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
        ('host: Annotated[str, Doc("主机")] | None = None', "Doc 只能写在注解的最外层"),
    ],
)
def test_wrong_docs_are_build_errors_naming_the_node_and_the_parameter(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], parameter: str, problem: str
) -> None:
    err = errors_for(tmp_path, capsys, parameter)

    assert "节点 demo_checks.ping 的参数 host：" + problem in err


def test_a_doc_on_ctx_is_a_build_error_naming_the_node(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        "from sfly import Context, Doc, node\n\n"
        '@node\ndef ping(ctx: Annotated[Context, Doc("任务上下文")], host: str) -> dict:\n'
        "    return {}\n"
    )
    project = project_with(tmp_path, module)

    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert "节点 demo_checks.ping 的参数 ctx：任务上下文不是输入，不能写 Doc" in err
    assert not (project / "dist").exists()


@pytest.mark.parametrize("char", ["字", "😀"])
def test_a_doc_of_exactly_500_characters_is_accepted(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], char: str
) -> None:
    # 长度按 Unicode 字符计，不是按字节或 UTF-16 单元：500 个 emoji 也刚好够。
    module = (
        "from sfly import Doc, node\n\n"
        f"@node\ndef ping(host: {doc_of_length(500, char)}) -> dict:\n    return {{}}\n"
    )
    meta = read_metadata(build(project_with(tmp_path, module), capsys))

    description = nodes_by_name(meta)["ping"]["inputs"]["properties"]["host"]["description"]
    assert description == char * 500


def test_sfly_debug_and_sfly_dev_report_the_same_error_as_build(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    module = (
        "from sfly import Doc, node\n\n"
        '@node\ndef ping(host: Annotated[str, Doc("")]) -> dict:\n    return {}\n'
    )
    project = project_with(tmp_path, module)
    problem = "节点 demo_checks.ping 的参数 host：Doc 必须是非空字符串"

    assert main(["build", str(project)]) == 1
    assert problem in capsys.readouterr().err
    assert main(["debug", "ping", "--project", str(project), "--params", '{"host": "a"}']) == 1
    assert problem in capsys.readouterr().err
    assert main(["dev", str(project), "--socket", str(tmp_path / "no-agent.sock")]) == 1
    assert problem in capsys.readouterr().err
