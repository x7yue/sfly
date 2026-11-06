"""`sfly init`：创建一个开箱即用的节点包项目。

1. 校验包名（节点包的全局命名规则，与 package-metadata schema 相同），目标目录不存在或为空。
2. 从控制面读取新项目的配置（`GET /sdk/project-settings`：控制面版本、sfly 简单索引、镜像）。
3. 在目标目录旁的临时目录里 `uv init --lib --python 3.13`（src 布局、`.python-version`、
   `.gitignore`、git 仓库；已在 git 仓库里时 uv 不再建仓库），再依次执行 `STEPS`：
   写入 pyproject 的 uv 配置与开发依赖、把 uv 的示例代码换成示例节点和它的单元测试、
   写入节点开发 skill（sfly/cli/skill.py）。
4. 全部成功后才移到目标位置；任何一步失败都删掉临时目录，不留下半成品。

不生成 AGENTS.md、CLAUDE.md。模板在 `sfly/cli/templates/init/`（`*.tmpl`，
`{{name}}` / `{{module}}` 替换为包名 / 模块名）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from importlib import resources
from pathlib import Path

from sfly.schemas import load_schema

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

#: 与 Agent 共享 venv 相同的 Python 版本（ADR 0012）。
PYTHON_VERSION = "3.13"
#: 开发依赖：`sfly[cli]` 锁定为控制面版本（ADR 0010：SDK 与控制面同版本），其余只写下限。
DEV_DEPENDENCIES = ("pytest>=8", "ruff>=0.6")


class InitError(Exception):
    """失败原因；`usage` 为 True 表示参数问题（包名、目录），退出码 2。"""

    def __init__(self, message: str, *, usage: bool = False) -> None:
        super().__init__(message)
        self.usage = usage


@dataclass(frozen=True)
class ProjectSettings:
    """控制面给新项目的配置（`GET /sdk/project-settings`）。"""

    version: str
    sfly_index_url: str
    pypi_mirror: str | None
    python_install_mirror: str | None


@dataclass(frozen=True)
class NewProject:
    """正在生成的项目：`root` 是临时目录（成功后才移到目标位置）。"""

    root: Path
    name: str
    module: str
    settings: ProjectSettings


def validate_name(name: str) -> str:
    """包名必须符合节点包的命名规则，且能作为 Python 模块名；返回模块名。"""
    pattern = load_schema("package-metadata")["properties"]["name"]["pattern"]
    if not re.fullmatch(pattern, name):
        raise InitError(
            f"包名 {name!r} 不合法：只能包含小写字母、数字、- 和 _，以字母或数字开头"
            "（用 --name 指定包名，默认为目录名）",
            usage=True,
        )
    module = name.replace("-", "_")
    if not module.isidentifier():
        raise InitError(
            f"包名 {name!r} 不合法：模块名 {module} 不是合法的 Python 标识符", usage=True
        )
    if name == "sfly":
        raise InitError("包名不能是 sfly（与 SDK 同名）", usage=True)
    return module


def fetch_settings(server: str) -> ProjectSettings:
    url = f"{server.rstrip('/')}/sdk/project-settings"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise InitError(f"读取控制面配置失败（{url}：HTTP {error.code}）") from None
    except (urllib.error.URLError, OSError) as error:
        reason = getattr(error, "reason", error)
        raise InitError(
            f"无法连接控制面 {server}：{reason}（用 --server 指定控制面地址）"
        ) from None
    except ValueError:
        raise InitError(f"读取控制面配置失败（{url}：响应不是 JSON）") from None
    return ProjectSettings(
        version=body["version"],
        sfly_index_url=body["sfly_index_url"],
        pypi_mirror=body.get("pypi_mirror") or None,
        python_install_mirror=body.get("python_install_mirror") or None,
    )


def _toml(value: str) -> str:
    # JSON 字符串也是合法的 TOML 基本字符串。
    return json.dumps(value, ensure_ascii=False)


def configure_pyproject(project: NewProject) -> None:
    """在 uv 生成的 pyproject.toml 末尾追加开发依赖与 uv 配置（镜像、显式的 sfly 索引）。"""
    s = project.settings
    dev = [f"sfly[cli]=={s.version}", *DEV_DEPENDENCIES]
    lines = ["", "[dependency-groups]", "dev = ["]
    lines += [f"    {_toml(d)}," for d in dev]
    lines += ["]", ""]
    lines += [
        "# 镜像与 sfly 索引来自控制面（sfly init 生成）。sfly 不在 PyPI 上：",
        "# 它只从控制面的 sfly 索引解析（explicit，不会装到 PyPI 上同名的其他包），",
        "# 其余依赖照常走 PyPI 镜像。",
        "[tool.uv]",
    ]
    if s.python_install_mirror:
        lines.append(f"python-install-mirror = {_toml(s.python_install_mirror)}")
    if s.pypi_mirror:
        lines += [
            "",
            "[[tool.uv.index]]",
            'name = "pypi-mirror"',
            f"url = {_toml(s.pypi_mirror)}",
            "default = true",
        ]
    lines += [
        "",
        "[[tool.uv.index]]",
        'name = "sfly"',
        f"url = {_toml(s.sfly_index_url)}",
        "explicit = true",
        "",
        "[tool.uv.sources]",
        'sfly = { index = "sfly" }',
        "",
        "# 节点开发 skill 由 sfly skill update 管理：ruff 不格式化其中 Markdown 的代码块。",
        "[tool.ruff]",
        'extend-exclude = [".agents", ".claude"]',
        "",
    ]
    path = project.root / "pyproject.toml"
    text = path.read_text(encoding="utf-8").rstrip("\n") + "\n" + "\n".join(lines)
    tomllib.loads(text)  # uv 生成的内容变化导致表重复等问题时尽早失败。
    path.write_text(text, encoding="utf-8")


def _template(name: str, project: NewProject) -> str:
    text = (resources.files("sfly.cli") / "templates" / "init" / name).read_text(encoding="utf-8")
    return text.replace("{{name}}", project.name).replace("{{module}}", project.module)


def write_example(project: NewProject) -> None:
    """把 uv 生成的示例代码换成示例节点和它的单元测试。"""
    package = project.root / "src" / project.module
    (package / "__init__.py").write_text(_template("__init__.py.tmpl", project), encoding="utf-8")
    (package / "example.py").write_text(_template("example.py.tmpl", project), encoding="utf-8")
    tests = project.root / "tests"
    tests.mkdir()
    (tests / "test_example.py").write_text(
        _template("test_example.py.tmpl", project), encoding="utf-8"
    )


def write_skill(project: NewProject) -> None:
    """写入节点开发 skill（sfly.cli.skill.install）。"""
    from sfly.cli.skill import install

    install(project.root)


#: `uv init` 之后依次执行的步骤，每一步在 `project.root`（临时目录）里写文件。
STEPS: tuple[Callable[[NewProject], None], ...] = (configure_pyproject, write_example, write_skill)


def _uv() -> str:
    uv = os.environ.get("UV") or shutil.which("uv")
    if not uv:
        raise InitError("找不到 uv：sfly init 用 uv 创建项目，先安装 uv（install.sh --dev 会装好）")
    return uv


def init(target: Path, name: str | None, server: str) -> Path:
    """在 target 创建节点包项目，返回项目目录。"""
    target = Path(os.path.abspath(target))
    name = name or target.name
    module = validate_name(name)
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise InitError(f"{target} 已存在且不是空目录", usage=True)
    if not target.parent.is_dir():
        raise InitError(f"上级目录 {target.parent} 不存在", usage=True)
    settings = fetch_settings(server)
    uv = _uv()

    # 在目标目录旁边生成（同一文件系统，最后 rename；也让 uv 看到目标位置所在的 git 仓库）。
    tmp = Path(tempfile.mkdtemp(prefix=f".{name}.sfly-init-", dir=target.parent))
    try:
        result = subprocess.run(
            [uv, "init", "--lib", "--python", PYTHON_VERSION, "--vcs", "git"]
            + ["--no-workspace", "--name", name, str(tmp)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise InitError(f"uv init 失败：\n{(result.stdout + result.stderr).rstrip()}")
        project = NewProject(root=tmp, name=name, module=module, settings=settings)
        for step in STEPS:
            step(project)
        if target.exists():
            for child in tmp.iterdir():
                child.rename(target / child.name)
            tmp.rmdir()
        else:
            tmp.rename(target)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return target
