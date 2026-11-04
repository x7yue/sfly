"""`sfly build`：扫描 `@node` 生成元信息，构建 wheel，打包成 `<包名>-<版本>.sflypkg`。

节点包归档（zip）：
    sfly-package.json   元信息（通过 packages/schema 导出的 JSON Schema 校验）
    <dist>-<ver>-py3-none-any.whl

项目约定：
- `pyproject.toml` 的 `[project]` 提供 name、version、requires-python（默认 `>=3.10`）。
- 依赖取 `[project].dependencies`；pyproject 未声明 dependencies 时读 `requirements.txt`。
- 代码位于 `src/<模块>/`、`<模块>/` 或 `<模块>.py`，模块名为包名规范化（`-` → `_`）。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from sfly.cli.wheel import build_wheel, dist_name
from sfly.schemas import load_schema

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

METADATA_FILE = "sfly-package.json"
ARCHIVE_SUFFIX = ".sflypkg"
DEFAULT_REQUIRES_PYTHON = ">=3.10"


class BuildError(Exception):
    pass


@dataclass(frozen=True)
class Project:
    root: Path
    name: str
    version: str
    requires_python: str
    dependencies: list[str]
    module: str
    source_root: Path
    source: Path


def _read_requirements(path: Path) -> list[str]:
    deps = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split(" #", 1)[0].strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-"):
            raise BuildError(f"{path.name} 不支持选项行：{line}")
        deps.append(line)
    return deps


def load_project(root: Path) -> Project:
    pyproject = root / "pyproject.toml"
    if not pyproject.is_file():
        raise BuildError(f"找不到 {pyproject}")
    with pyproject.open("rb") as f:
        data = tomllib.load(f)
    project: dict[str, Any] = data.get("project", {})
    name, version = project.get("name"), project.get("version")
    if not isinstance(name, str) or not isinstance(version, str):
        raise BuildError("pyproject.toml 的 [project] 必须声明 name 和 version")

    if "dependencies" in project:
        dependencies = list(project["dependencies"])
    elif (root / "requirements.txt").is_file():
        dependencies = _read_requirements(root / "requirements.txt")
    else:
        dependencies = []

    module = dist_name(name)
    for source_root in (root / "src", root):
        for source in (source_root / module, source_root / f"{module}.py"):
            if (source.is_dir() and (source / "__init__.py").is_file()) or source.is_file():
                return Project(
                    root=root,
                    name=name,
                    version=version,
                    requires_python=project.get("requires-python", DEFAULT_REQUIRES_PYTHON),
                    dependencies=dependencies,
                    module=module,
                    source_root=source_root,
                    source=source,
                )
    raise BuildError(f"找不到模块 {module}（应位于 src/{module}/、{module}/ 或 {module}.py）")


def scan_nodes(project: Project) -> list[dict[str, Any]]:
    """在子进程中导入用户代码，收集 `@node` 元信息。"""
    result = subprocess.run(
        [sys.executable, "-m", "sfly.cli.scan", str(project.source_root), project.module],
        cwd=project.root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise BuildError(result.stderr.strip() or f"扫描节点失败（退出码 {result.returncode}）")
    nodes: list[dict[str, Any]] = json.loads(result.stdout)
    if not nodes:
        raise BuildError(f"没有找到 @node 声明的节点类型（模块 {project.module}）")
    return nodes


def validate_metadata(metadata: dict[str, Any]) -> None:
    validator = Draft202012Validator(load_schema("package-metadata"))
    errors = sorted(validator.iter_errors(metadata), key=lambda e: list(e.absolute_path))
    if errors:
        lines = [f"  {'/'.join(map(str, e.absolute_path)) or '(根)'}: {e.message}" for e in errors]
        raise BuildError("元信息未通过 schema 校验：\n" + "\n".join(lines))


def build(root: Path, out_dir: Path | None = None) -> Path:
    """构建节点包，返回归档路径。"""
    project = load_project(root)
    metadata = {
        "name": project.name,
        "version": project.version,
        "requires_python": project.requires_python,
        "nodes": scan_nodes(project),
    }
    validate_metadata(metadata)

    out_dir = out_dir or root / "dist"
    text = json.dumps(metadata, ensure_ascii=False, indent=2) + "\n"
    with tempfile.TemporaryDirectory() as tmp:
        wheel = build_wheel(
            name=project.name,
            version=project.version,
            requires_python=project.requires_python,
            dependencies=project.dependencies,
            source=project.source,
            out_dir=Path(tmp),
            # 元信息也放进 wheel 的 dist-info：安装到共享 venv 后，执行器据此找到节点入口。
            extra_metadata={METADATA_FILE: text.encode("utf-8")},
        )
        out_dir.mkdir(parents=True, exist_ok=True)
        archive = out_dir / f"{project.name}-{project.version}{ARCHIVE_SUFFIX}"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for arc, data in (
                (METADATA_FILE, text.encode("utf-8")),
                (wheel.name, wheel.read_bytes()),
            ):
                info = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zf.writestr(info, data)
    return archive
