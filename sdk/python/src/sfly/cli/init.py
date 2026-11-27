"""`sfly init`：创建一个开箱即用的节点包目录。

1. 校验包名（节点包的全局命名规则，与 package-metadata schema 相同），目标目录不存在或为空。
2. 从控制面读取新节点包目录的配置（`GET /sdk/project-settings`：控制面版本、sfly 简单索引、镜像）；
   镜像按本机的覆盖（与 Agent 相同的环境变量和 `agent.env` 键，sfly/cli/home.py）改写，本地优先。
3. 在目标目录旁的临时目录里 `uv init --lib --python 3.13`（src 布局、`.python-version`、
   `.gitignore`、git 仓库；已在 git 仓库里时 uv 不再建仓库），再依次执行 `STEPS`：
   写入 pyproject 的 uv 配置与开发依赖、把 uv 的示例代码换成示例节点和它的单元测试、
   写入两份给 AI 编程助手的 skill（节点开发、操作平台，sfly/cli/skill.py）。
4. 全部成功后才移到目标位置；任何一步失败都删掉临时目录，不留下半成品。

不生成 AGENTS.md、CLAUDE.md。模板在 `sfly/cli/templates/init/`（`*.tmpl`，
`{{name}}` / `{{module}}` 替换为包名 / 模块名）。
"""

from __future__ import annotations

import http.client
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
from dataclasses import dataclass, replace
from importlib import resources
from pathlib import Path

from sfly.cli.client import address_problem, scrub_userinfo
from sfly.cli.home import LocalMirrors, local_mirrors
from sfly.schemas import load_schema

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

#: 与 Agent 共享 venv 相同的 Python 版本（ADR 0012）。
PYTHON_VERSION = "3.13"
#: 开发依赖：`sfly[cli]` 锁定为控制面版本（ADR 0010：SDK 与控制面同版本），其余只写下限。
DEV_DEPENDENCIES = ("pytest>=8", "ruff>=0.6")

#: 生成的节点包目录里 ruff 的规则集（#472），按族分组（族名、写在这组前面的注释、编号）。
#: pyflakes（F）和 pycodestyle 里语句级、运行时错误的那几组（E4、E7、E9），
#: 也就是 ruff 长期以来的默认规则，逐条写出确切的编号。
#: 不写前缀：选了前缀，ruff 以后在这个前缀下转正的新规则会自动生效，同一份代码换个 ruff 版本
#: 就多出新的报告；新版 ruff 的默认规则集也比这大得多。
#: 这些编号在 ruff 0.6 以前就都有了，`ruff>=0.6` 的哪个版本都认得。
#: docs/guide/init-project.md 里有同样的一段给已有节点包目录抄
#: （tests/test_init_ruff.py 核对两者一致）。
RUFF_GROUPS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("F", "pyflakes（F）：没用到的 import 和变量、未定义的名字、格式字符串写错……", (
        "F401", "F402", "F403", "F404", "F405", "F406", "F407",
        "F501", "F502", "F503", "F504", "F505", "F506", "F507", "F508", "F509",
        "F521", "F522", "F523", "F524", "F525", "F541",
        "F601", "F602", "F621", "F622", "F631", "F632", "F633", "F634",
        "F701", "F702", "F704", "F706", "F707", "F722",
        "F811", "F821", "F822", "F823", "F841", "F842",
        "F901",
    )),
    ("E4", "pycodestyle（E4）：import 写在一行里、不在文件开头", ("E401", "E402")),
    ("E7", "pycodestyle（E7）：一行几条语句、和 None/True 用 == 比较、裸 except、含糊的名字……", (
        "E701", "E702", "E703", "E711", "E712", "E713", "E714", "E721", "E722", "E731",
        "E741", "E742", "E743",
    )),
    ("E9", "pycodestyle（E9）：读不了源文件", ("E902",)),
)  # fmt: skip
#: 上面各组的编号连起来，就是 select 的全部规则。
RUFF_SELECT = tuple(code for _, _, codes in RUFF_GROUPS for code in codes)


class InitError(Exception):
    """失败原因；`usage` 为 True 表示参数问题（包名、目录），退出码 2。"""

    def __init__(self, message: str, *, usage: bool = False) -> None:
        super().__init__(message)
        self.usage = usage


@dataclass(frozen=True)
class PackageDirSettings:
    """控制面给新节点包目录的配置（`GET /sdk/project-settings`：路径沿用旧名，旧版命令行在用）。"""

    version: str
    sfly_index_url: str
    pypi_mirror: str | None
    python_install_mirror: str | None


@dataclass(frozen=True)
class NewProject:
    """正在生成的节点包目录：`root` 是临时目录（成功后才移到目标位置）。"""

    root: Path
    name: str
    module: str
    settings: PackageDirSettings


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


def fetch_settings(server: str) -> PackageDirSettings:
    if (problem := address_problem(server)) is not None:
        raise InitError(problem)
    url = f"{server.rstrip('/')}/sdk/project-settings"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise InitError(f"读取控制面配置失败（{url}：HTTP {error.code}）") from None
    except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
        reason = scrub_userinfo(str(getattr(error, "reason", error)))
        raise InitError(
            f"无法连接控制面 {server}：{reason}（用 --server 指定控制面地址）"
        ) from None
    except ValueError:
        raise InitError(f"读取控制面配置失败（{url}：响应不是 JSON）") from None
    return PackageDirSettings(
        version=body["version"],
        sfly_index_url=body["sfly_index_url"],
        pypi_mirror=body.get("pypi_mirror") or None,
        python_install_mirror=body.get("python_install_mirror") or None,
    )


def with_local_mirrors(settings: PackageDirSettings, local: LocalMirrors) -> PackageDirSettings:
    """本机覆盖优先（与 Agent 相同）：PyPI 镜像用 `SFLY_INDEX_URL`；Python 下载镜像用
    `SFLY_PYTHON_INSTALL_MIRROR`，否则从本机的 `SFLY_GITHUB_RELEASE_MIRROR` 推导，
    都没有时用控制面的。"""
    python_install = local.python_install
    if not python_install and local.github_release:
        base = local.github_release.rstrip("/")
        python_install = f"{base}/astral-sh/python-build-standalone/"
    return replace(
        settings,
        pypi_mirror=local.pypi or settings.pypi_mirror,
        python_install_mirror=python_install or settings.python_install_mirror,
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
        "# 镜像与控制面的包索引来自控制面（sfly init 生成；本机覆盖了镜像时用覆盖的值）。",
        "# sfly（SDK）和 sfly-std（标准节点包的辅助函数）不在 PyPI 上：它们只从控制面的包索引解析",
        "# （explicit，不会装到 PyPI 上同名的其他包），其余依赖照常走 PyPI 镜像。",
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
        'sfly-std = { index = "sfly" }',
        "",
        "# 节点包需要的最低 SDK 版本（即 Agent 版本）：更旧的 Agent 上任务会以 env_error 失败。",
        "# 用到新版 SDK 的接口时调高它。",
        "[tool.sfly]",
        f"requires-sdk = {_toml('>=' + s.version)}",
        "",
        "# skill 由 sfly skill update 管理：ruff 不格式化其中 Markdown 的代码块。",
        "[tool.ruff]",
        'extend-exclude = [".agents", ".claude"]',
        "",
        "# 固定的规则集：ruff 出新版本时，同一份代码不会多出新的报告",
        "# （ruff 的默认规则会随版本变）。写的是确切的规则编号，不是前缀（F、E4……）：",
        "# 前缀会把 ruff 以后在这些族里新转正的规则也带进来。",
        "# 要更严的检查时在这里加规则编号。",
        *ruff_select_lines(),
        "",
    ]
    path = project.root / "pyproject.toml"
    text = path.read_text(encoding="utf-8").rstrip("\n") + "\n" + "\n".join(lines)
    tomllib.loads(text)  # uv 生成的内容变化导致表重复等问题时尽早失败。
    path.write_text(text, encoding="utf-8")


def ruff_select_lines(per_line: int = 10) -> list[str]:
    """`[tool.ruff.lint]` 的 select：一族一组，组前一行注释，编号每行最多 per_line 个。"""
    lines = ["[tool.ruff.lint]", "select = ["]
    for _, comment, codes in RUFF_GROUPS:
        lines.append(f"    # {comment}")
        lines += [
            "    " + " ".join(f'"{c}",' for c in codes[i : i + per_line])
            for i in range(0, len(codes), per_line)
        ]
    return [*lines, "]"]


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
    """写入节点开发和操作平台两份 skill（sfly.cli.skill.install）。"""
    from sfly.cli.skill import install

    install(project.root)


#: `uv init` 之后依次执行的步骤，每一步在 `project.root`（临时目录）里写文件。
STEPS: tuple[Callable[[NewProject], None], ...] = (configure_pyproject, write_example, write_skill)


def _uv() -> str:
    uv = os.environ.get("UV") or shutil.which("uv")
    if not uv:
        raise InitError(
            "找不到 uv：sfly init 用 uv 创建节点包目录，先安装 uv（install.sh --dev 会装好）"
        )
    return uv


def init(target: Path, name: str | None, server: str) -> Path:
    """在 target 创建节点包目录，返回它的路径。"""
    target = Path(os.path.abspath(target))
    name = name or target.name
    module = validate_name(name)
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise InitError(f"{target} 已存在且不是空目录", usage=True)
    if not target.parent.is_dir():
        raise InitError(f"上级目录 {target.parent} 不存在", usage=True)
    settings = with_local_mirrors(fetch_settings(server), local_mirrors())
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
