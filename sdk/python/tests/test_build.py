"""`sfly build`：从 `@node` 的类型注解生成元信息，打包成 .sflypkg（元信息 + wheel）。"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
import zipfile
from email.parser import Parser
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
requires-python = ">=3.11"
dependencies = ["requests>=2.31", "pyyaml"]
"""

HTTP_MODULE = """\
from __future__ import annotations

from typing import Any, Literal, Optional, TypedDict

from sfly import Context, node


class CheckResult(TypedDict):
    status: int
    report: str


@node(title="HTTP 检查")
def http_check(
    ctx: Context,
    url: str,
    expect: int = 200,
    ratio: float = 0.5,
    verbose: bool = False,
    headers: dict[str, str] | None = None,
    tags: list[str] = [],
    method: Literal["GET", "POST"] = "GET",
    body: Optional[Any] = None,
    extra: dict = {},
) -> CheckResult:
    return {"status": expect, "report": url}


@node(name="ping", outputs=["latency_ms", "alive"])
def ping_host(ctx, host: str) -> dict[str, Any]:
    return {"latency_ms": 1, "alive": True}
"""

DB_MODULE = """\
from sfly import node


def helper(x: int) -> int:
    return x


@node(title="数据准备", outputs={"rows": int, "table": str})
def prepare(table: str, rows: int) -> dict:
    return {"rows": rows, "table": table}
"""


def write_project(root: Path, files: dict[str, str]) -> Path:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return root


def demo_project(root: Path) -> Path:
    return write_project(
        root,
        {
            "pyproject.toml": PYPROJECT,
            "src/demo_checks/__init__.py": "",
            "src/demo_checks/http.py": HTTP_MODULE,
            "src/demo_checks/db/__init__.py": "",
            "src/demo_checks/db/prepare.py": DB_MODULE,
        },
    )


def build(project: Path, capsys: pytest.CaptureFixture[str]) -> Path:
    code = main(["build", str(project)])
    out, err = capsys.readouterr()
    assert code == 0, err
    archive = project / "dist" / "demo-checks-1.2.0.sflypkg"
    assert out.strip().endswith(str(archive))
    return archive


def read_metadata(archive: Path) -> dict[str, Any]:
    with zipfile.ZipFile(archive) as zf:
        meta: dict[str, Any] = json.loads(zf.read("sfly-package.json"))
    return meta


def nodes_by_name(meta: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {n["name"]: n for n in meta["nodes"]}


def test_build_generates_metadata_from_type_annotations(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta = read_metadata(build(demo_project(tmp_path), capsys))

    assert meta["name"] == "demo-checks"
    assert meta["version"] == "1.2.0"
    assert meta["requires_python"] == ">=3.11"

    http = nodes_by_name(meta)["http_check"]
    assert http["title"] == "HTTP 检查"
    assert http["entry"] == "demo_checks.http:http_check"
    assert http["inputs"] == {
        "type": "object",
        "properties": {
            "url": {"type": "string"},
            "expect": {"type": "integer", "default": 200},
            "ratio": {"type": "number", "default": 0.5},
            "verbose": {"type": "boolean", "default": False},
            "headers": {
                "anyOf": [
                    {"type": "object", "additionalProperties": {"type": "string"}},
                    {"type": "null"},
                ],
                "default": None,
            },
            "tags": {"type": "array", "items": {"type": "string"}, "default": []},
            "method": {"enum": ["GET", "POST"], "default": "GET"},
            "body": {"default": None},
            "extra": {"type": "object", "default": {}},
        },
        "required": ["url"],
        # JSONB 不保留对象键顺序：参数表单按 order（函数参数顺序）排列。
        "order": [
            "url",
            "expect",
            "ratio",
            "verbose",
            "headers",
            "tags",
            "method",
            "body",
            "extra",
        ],
    }
    # 返回类型注解为 TypedDict 时，输出键和类型从中读取。
    assert http["outputs"] == {
        "type": "object",
        "properties": {"status": {"type": "integer"}, "report": {"type": "string"}},
        "required": ["status", "report"],
    }


def test_package_can_contain_multiple_node_types_with_declared_outputs(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta = read_metadata(build(demo_project(tmp_path), capsys))
    nodes = nodes_by_name(meta)

    assert sorted(nodes) == ["http_check", "ping", "prepare"]

    ping = nodes["ping"]
    # 未指定标题时使用节点名；首个参数 ctx 不算输入。
    assert ping["title"] == "ping"
    assert ping["entry"] == "demo_checks.http:ping_host"
    assert ping["inputs"] == {
        "type": "object",
        "properties": {"host": {"type": "string"}},
        "required": ["host"],
        "order": ["host"],
    }
    assert ping["outputs"] == {"type": "object", "properties": {"latency_ms": {}, "alive": {}}}

    prepare = nodes["prepare"]
    assert prepare["entry"] == "demo_checks.db.prepare:prepare"
    assert prepare["inputs"]["required"] == ["table", "rows"]
    assert prepare["outputs"] == {
        "type": "object",
        "properties": {"rows": {"type": "integer"}, "table": {"type": "string"}},
    }


def test_generated_metadata_passes_exported_json_schema(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta = read_metadata(build(demo_project(tmp_path), capsys))
    errors = list(Draft202012Validator(load_schema("package-metadata")).iter_errors(meta))
    assert errors == []


def wheel_name(archive: Path) -> str:
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
    wheels = [n for n in names if n.endswith(".whl")]
    assert sorted(names) == sorted(["sfly-package.json", *wheels])
    assert len(wheels) == 1
    return wheels[0]


def wheel_metadata(archive: Path, tmp_path: Path) -> tuple[Path, Any]:
    name = wheel_name(archive)
    with zipfile.ZipFile(archive) as zf:
        zf.extract(name, tmp_path / "unpacked")
    wheel = tmp_path / "unpacked" / name
    with zipfile.ZipFile(wheel) as wf:
        metadata = [n for n in wf.namelist() if n.endswith(".dist-info/METADATA")]
        assert len(metadata) == 1
        return wheel, Parser().parsestr(wf.read(metadata[0]).decode("utf-8"))


def test_archive_contains_wheel_with_code_and_pyproject_dependencies(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    archive = build(demo_project(tmp_path / "proj"), capsys)
    assert wheel_name(archive) == "demo_checks-1.2.0-py3-none-any.whl"

    wheel, metadata = wheel_metadata(archive, tmp_path)
    assert metadata["Name"] == "demo-checks"
    assert metadata["Version"] == "1.2.0"
    assert metadata["Requires-Python"] == ">=3.11"
    assert metadata.get_all("Requires-Dist") == ["requests>=2.31", "pyyaml"]

    # wheel 里是可导入的用户代码：入口能被找到并调用。
    probe = (
        "import sys; sys.path.insert(0, sys.argv[1]);"
        "from demo_checks.db.prepare import prepare;"
        "print(prepare(table='t', rows=3))"
    )
    out = subprocess.run(
        [sys.executable, "-c", probe, str(wheel)], check=True, capture_output=True, text=True
    ).stdout
    assert out.strip() == "{'rows': 3, 'table': 't'}"


def test_dependencies_can_come_from_requirements_txt(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    project = demo_project(tmp_path / "proj")
    (project / "pyproject.toml").write_text(
        '[project]\nname = "demo-checks"\nversion = "1.2.0"\n', encoding="utf-8"
    )
    (project / "requirements.txt").write_text(
        textwrap.dedent(
            """\
            # 运行依赖
            requests>=2.31  # HTTP

            pyyaml==6.0.2
            """
        ),
        encoding="utf-8",
    )
    archive = build(project, capsys)

    meta = read_metadata(archive)
    assert meta["requires_python"] == ">=3.10"
    _, metadata = wheel_metadata(archive, tmp_path)
    assert metadata.get_all("Requires-Dist") == ["requests>=2.31", "pyyaml==6.0.2"]


def test_flat_layout_is_supported(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    project = write_project(
        tmp_path,
        {
            "pyproject.toml": PYPROJECT,
            "demo_checks/__init__.py": DB_MODULE,
        },
    )
    meta = read_metadata(build(project, capsys))
    assert [n["entry"] for n in meta["nodes"]] == ["demo_checks:prepare"]


@pytest.mark.parametrize(
    ("module", "message"),
    [
        ("from sfly import node\n\ndef plain(x: int) -> int:\n    return x\n", "没有找到 @node"),
        (
            "from sfly import node\n\n@node\ndef bad(x: set[int]) -> dict:\n    return {}\n",
            "bad",
        ),
        (
            "from sfly import node\n\n@node\ndef bad(*args: int) -> dict:\n    return {}\n",
            "args",
        ),
        (
            "from sfly import node\n\n@node(name='a')\ndef x() -> dict:\n    return {}\n\n"
            "@node(name='a')\ndef y() -> dict:\n    return {}\n",
            "重复",
        ),
        ("raise RuntimeError('boom')\n", "boom"),
    ],
)
def test_build_reports_errors(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], module: str, message: str
) -> None:
    project = write_project(
        tmp_path, {"pyproject.toml": PYPROJECT, "src/demo_checks/__init__.py": module}
    )
    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert message in err
    assert not (project / "dist").exists()


def test_build_rejects_metadata_that_fails_schema(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    project = demo_project(tmp_path)
    (project / "pyproject.toml").write_text(
        PYPROJECT.replace('name = "demo-checks"', 'name = "Demo_Checks"'), encoding="utf-8"
    )
    assert main(["build", str(project)]) == 1
    _, err = capsys.readouterr()
    assert "name" in err
