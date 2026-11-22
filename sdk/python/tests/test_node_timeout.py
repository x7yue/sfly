"""节点类型声明自己的默认超时（#476）：`@node(timeout=秒)` 写进元信息里节点类型的 `timeout`，
`sfly build` 只接受正整数，报错指出是哪个节点；没有声明的节点类型元信息不带这个字段。"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from sfly import node
from sfly.cli import main
from sfly.cli.scan import ScanError, node_metadata
from sfly.nodes import NODE_ATTR
from sfly.schemas import load_schema

PYPROJECT = """\
[project]
name = "demo-checks"
version = "1.2.0"
"""

MODULE = """\
from __future__ import annotations

from sfly import Context, node


@node(timeout=43200)
def keep_alive(ctx: Context) -> dict:
    return {}


@node(title="发一次请求")
def ping() -> dict:
    return {}
"""


def write_project(root: Path, source: str) -> Path:
    (root / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")
    package = root / "src" / "demo_checks"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text(source, encoding="utf-8")
    return root


def build(root: Path, capsys: pytest.CaptureFixture[str]) -> tuple[int, dict[str, Any] | None, str]:
    code = main(["build", str(root)])
    _, err = capsys.readouterr()
    archive = root / "dist" / "demo-checks-1.2.0.sflypkg"
    if code != 0:
        return code, None, err
    with zipfile.ZipFile(archive) as zf:
        meta: dict[str, Any] = json.loads(zf.read("sfly-package.json"))
    return code, meta, err


def test_the_declared_timeout_is_written_into_the_node_type_metadata(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code, meta, err = build(write_project(tmp_path, MODULE), capsys)

    assert code == 0, err
    assert meta is not None
    nodes = {n["name"]: n for n in meta["nodes"]}
    assert nodes["keep_alive"]["timeout"] == 43200


def test_a_node_type_without_a_declared_timeout_has_no_timeout_key(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # 没声明的节点类型元信息和以前逐字相同：旧版本的控制面照常接受。
    _, meta, _ = build(write_project(tmp_path, MODULE), capsys)

    assert meta is not None
    nodes = {n["name"]: n for n in meta["nodes"]}
    assert "timeout" not in nodes["ping"]


def test_the_metadata_with_a_timeout_passes_the_exported_json_schema(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _, meta, _ = build(write_project(tmp_path, MODULE), capsys)

    assert meta is not None
    Draft202012Validator(load_schema("package-metadata")).validate(meta)


@pytest.mark.parametrize(
    "value",
    ["0", "-5", "1.5", "'3600'", "True", "float('inf')", "10 ** 400", "4294967296"],
)
def test_build_rejects_a_timeout_that_is_not_a_positive_integer_and_names_the_node(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], value: str
) -> None:
    source = (
        f"from sfly import node\n\n@node(timeout={value})\ndef slow() -> dict:\n    return {{}}\n"
    )

    code, _, err = build(write_project(tmp_path, source), capsys)

    assert code == 1
    assert "demo_checks.slow" in err
    assert "timeout" in err
    assert "正整数" in err
    assert not (tmp_path / "dist").exists()


@node(timeout=-5)
def declared_minus_five() -> dict[str, Any]:
    return {}


@node(timeout=90)
def declared_ninety() -> dict[str, Any]:
    return {}


def metadata_of(fn: Any) -> dict[str, Any]:
    return node_metadata(fn, getattr(fn, NODE_ATTR))


def test_the_error_says_what_was_given() -> None:
    with pytest.raises(ScanError) as raised:
        metadata_of(declared_minus_five)

    assert "实际是 -5" in str(raised.value)


def test_the_unit_is_seconds_like_the_timeout_written_in_a_scenario() -> None:
    assert metadata_of(declared_ninety)["timeout"] == 90
