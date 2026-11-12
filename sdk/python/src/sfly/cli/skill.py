"""给 AI 编程助手的两份 skill：`sfly init` 写进项目，`sfly skill update` 换成当前 SDK 的版本。

- `sfly-node-dev`：开发节点包。
- `sfly-platform`：用命令行操作平台（联调、触发和等待运行、读日志、编辑场景）。
- 内容在包里的 `sfly/cli/skills/<名称>/`，随 wheel 发布。仓库里这些文件是指向用户文档的软链接
  （ADR 0013：只有一份源文件）：`SKILL.md` → docs/guide/skills/<名称>/SKILL.md，`reference.md` →
  对应的文档页（sfly-node-dev 是 SDK 参考 docs/guide/sdk-reference.md，sfly-platform 是
  docs/guide/platform-cli.md）；uv_build 构建 wheel 时跟随软链接。
- 写到项目的 `.agents/skills/<名称>/`（Codex 读取），`.claude/skills/<名称>`
  是指向它的相对软链接（Claude Code 读取）。
- 每次写入同时写 `.sfly-skill.json`（SDK 版本和每个文件的 sha256）。目录内容和它记录的不同，
  说明被改过，`sfly skill update` 不加 `--force` 就不覆盖；两份 skill 各自检查，互不影响。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path

from sfly import __version__

#: 随 SDK 发布、`sfly init` 写进项目的 skill（目录名）。
SKILL_NAMES = ("sfly-node-dev", "sfly-platform")
#: 上次写入的内容记录（不算 skill 的内容）。
MANIFEST = ".sfly-skill.json"


class SkillError(Exception):
    """失败原因；`usage` 为 True 表示参数问题（不是项目目录），退出码 2。"""

    def __init__(self, message: str, *, usage: bool = False) -> None:
        super().__init__(message)
        self.usage = usage


@dataclass(frozen=True)
class Changes:
    """skill 目录相对上次写入的改动（相对路径）。"""

    modified: list[str] = field(default_factory=list)
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return bool(self.modified or self.added or self.removed)


@dataclass(frozen=True)
class UpdateResult:
    """`sfly skill update` 的结果：换成新内容的 skill 目录，和改动过而没有更新的 skill 的说明。"""

    updated: list[Path] = field(default_factory=list)
    refused: list[str] = field(default_factory=list)


def skill_dir(project: Path, name: str) -> Path:
    return project / ".agents" / "skills" / name


def _bundled(name: str) -> dict[str, bytes]:
    """当前 SDK 版本带的 skill 文件：相对路径 → 内容。"""
    root = resources.files("sfly.cli") / "skills" / name
    return {f.name: f.read_bytes() for f in root.iterdir() if f.is_file()}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _on_disk(directory: Path) -> dict[str, str]:
    """目录里的文件（不含记录文件）：相对路径 → sha256。"""
    files = {}
    for path in sorted(directory.rglob("*")):
        name = path.relative_to(directory).as_posix()
        if name != MANIFEST and (path.is_file() or path.is_symlink()):
            files[name] = _sha256(path.read_bytes()) if path.is_file() else "symlink"
    return files


def changes(directory: Path) -> Changes:
    """目录内容相对上次写入的改动；没有写入记录时，目录里的每个文件都算新增。"""
    try:
        written: dict[str, str] = json.loads((directory / MANIFEST).read_text("utf-8"))["files"]
    except (OSError, ValueError, KeyError, TypeError):
        written = {}
    current = _on_disk(directory)
    return Changes(
        modified=[n for n in current if n in written and current[n] != written[n]],
        added=[n for n in current if n not in written],
        removed=[n for n in written if n not in current],
    )


def install_skill(project: Path, name: str) -> Path:
    """把当前 SDK 版本的一份 skill 整个写进项目（替换已有的 skill 目录），返回 skill 目录。"""
    target = skill_dir(project, name)
    target.parent.mkdir(parents=True, exist_ok=True)
    files = _bundled(name)
    # 在旁边写好再换进去：中途失败不会留下一半新一半旧的目录。
    fresh = Path(tempfile.mkdtemp(prefix=f".{name}.", dir=target.parent))
    try:
        for file, data in files.items():
            (fresh / file).write_bytes(data)
        manifest = {"sfly_version": __version__, "files": {n: _sha256(d) for n, d in files.items()}}
        (fresh / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        fresh.chmod(0o755)
        if target.exists() or target.is_symlink():
            old = Path(tempfile.mkdtemp(prefix=f".{name}.old.", dir=target.parent))
            target.rename(old / name)
            fresh.rename(target)
            shutil.rmtree(old, ignore_errors=True)
        else:
            fresh.rename(target)
    finally:
        shutil.rmtree(fresh, ignore_errors=True)

    link = project / ".claude" / "skills" / name
    if not os.path.lexists(link):
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(os.path.relpath(target, link.parent), target_is_directory=True)
    return target


def install(project: Path) -> list[Path]:
    """`sfly init`：把两份 skill 都写进项目，返回各自的 skill 目录。"""
    return [install_skill(project, name) for name in SKILL_NAMES]


def _refusal(target: Path, found: Changes) -> str:
    lines = [f"skill 目录 {target} 和上次写入的不同，没有更新："]
    lines += [f"  改动：{n}" for n in found.modified]
    lines += [f"  新增：{n}" for n in found.added]
    lines += [f"  删除：{n}" for n in found.removed]
    lines.append("确认不需要这些改动后加 --force 覆盖（自己的约定请写在其他 skill 里）。")
    return "\n".join(lines)


def update(project: Path, *, force: bool) -> UpdateResult:
    """`sfly skill update`：每份 skill 单独检查。目录改动过且没有 force 的不覆盖，写进 `refused`；
    其余的换成当前版本（项目里还没有的也写进去）。"""
    if not (project / "pyproject.toml").is_file():
        raise SkillError(
            f"找不到 {project / 'pyproject.toml'}：在节点包项目的根目录运行，或用 --project 指定",
            usage=True,
        )
    result = UpdateResult()
    for name in SKILL_NAMES:
        target = skill_dir(project, name)
        found = changes(target) if target.is_dir() else Changes()
        if found and not force:
            result.refused.append(_refusal(target, found))
        else:
            result.updated.append(install_skill(project, name))
    return result
