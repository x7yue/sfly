"""节点类型的说明：函数的文档字符串写进元信息的 `description`，`sfly build` 限制长度。"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from sfly.cli import main
from sfly.schemas import load_schema

PYPROJECT = """\
[project]
name = "demo-checks"
version = "1.2.0"
"""

DOCUMENTED = '''\
from __future__ import annotations

from sfly import Context, node


@node(title="HTTP 检查")
def http_check(ctx: Context, url: str) -> dict:
    """请求一个地址并检查状态码。

    失败时重试 3 次，
    每次间隔 1 秒。

        缩进更深的行保留相对缩进。
    """
    return {}


@node
def one_liner() -> dict:
    """只有一行的说明。"""
    return {}


@node
def undocumented() -> dict:
    return {}


@node
def blank_docstring() -> dict:
    """

    """
    return {}
'''


def write_module(root: Path, source: str) -> Path:
    (root / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")
    package = root / "src" / "demo_checks"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(source, encoding="utf-8")
    return root


def build_metadata(root: Path, capsys: pytest.CaptureFixture[str]) -> dict[str, Any]:
    code = main(["build", str(root)])
    _, err = capsys.readouterr()
    assert code == 0, err
    with zipfile.ZipFile(root / "dist" / "demo-checks-1.2.0.sflypkg") as zf:
        meta: dict[str, Any] = json.loads(zf.read("sfly-package.json"))
    return meta


def nodes_by_name(meta: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {n["name"]: n for n in meta["nodes"]}


def test_docstring_is_written_whole_as_the_node_type_description(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta = build_metadata(write_module(tmp_path, DOCUMENTED), capsys)
    nodes = nodes_by_name(meta)

    # 去掉缩进后整段写入：所有段落都在，空行保留，更深的缩进只保留相对的部分。
    assert nodes["http_check"]["description"] == (
        "请求一个地址并检查状态码。\n\n"
        "失败时重试 3 次，\n"
        "每次间隔 1 秒。\n\n"
        "    缩进更深的行保留相对缩进。"
    )
    assert nodes["one_liner"]["description"] == "只有一行的说明。"

    errors = list(Draft202012Validator(load_schema("package-metadata")).iter_errors(meta))
    assert errors == []


@pytest.mark.parametrize("name", ["undocumented", "blank_docstring"])
def test_no_description_without_a_docstring(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], name: str
) -> None:
    meta = build_metadata(write_module(tmp_path, DOCUMENTED), capsys)

    # 没有文档字符串（或只有空白）不写这个字段，也不报错、不警告。
    assert "description" not in nodes_by_name(meta)[name]


def documented_with(text: str) -> str:
    return (
        "from sfly import node\n\n\n@node\ndef probe() -> dict:\n"
        f'    """{text}"""\n    return {{}}\n'
    )


@pytest.mark.parametrize("text", ["x" * 4000, "😀" * 4000, "字" * 3999 + "\n"])
def test_docstring_up_to_4000_characters_is_accepted(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], text: str
) -> None:
    """长度按 Unicode 字符计：4000 个 emoji 是 4000 个字符，不是 8000 个。"""
    meta = build_metadata(write_module(tmp_path, documented_with(text)), capsys)

    assert nodes_by_name(meta)["probe"]["description"] == text.strip()
    errors = list(Draft202012Validator(load_schema("package-metadata")).iter_errors(meta))
    assert errors == []


@pytest.mark.parametrize("text", ["x" * 4001, "😀" * 4001])
def test_docstring_over_4000_characters_fails_the_build_and_names_the_node(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], text: str
) -> None:
    project = write_module(tmp_path, documented_with(text))

    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert "demo_checks.probe" in err
    assert "4000" in err
    assert not (project / "dist").exists()


def node_metadata(**overrides: Any) -> dict[str, Any]:
    node: dict[str, Any] = {
        "name": "http_check",
        "title": "HTTP 检查",
        "entry": "demo_checks:http_check",
        "inputs": {"type": "object", "properties": {}},
        "outputs": {"type": "object", "properties": {}},
        **overrides,
    }
    return {
        "name": "demo-checks",
        "version": "1.2.0",
        "requires_python": ">=3.10",
        "nodes": [node],
    }


@pytest.mark.parametrize(
    ("description", "valid"),
    [
        ("一行", True),
        ("第一段\n\n第二段", True),
        ("x" * 4000, True),
        ("😀" * 4000, True),
        ("x" * 4001, False),
        ("😀" * 4001, False),
    ],
)
def test_exported_schema_limits_the_node_description_to_4000_unicode_characters(
    description: str, valid: bool
) -> None:
    """导出的 JSON Schema 与控制面（zod）一致：按码点计，多行可以。"""
    validator = Draft202012Validator(load_schema("package-metadata"))

    assert validator.is_valid(node_metadata(description=description)) is valid


def test_exported_schema_still_accepts_nodes_without_a_description() -> None:
    assert Draft202012Validator(load_schema("package-metadata")).is_valid(node_metadata())
