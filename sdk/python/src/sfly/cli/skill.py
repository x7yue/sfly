"""节点开发 skill `sfly-node-dev`：`sfly init` 写进项目，`sfly skill update` 换成当前 SDK 的版本。

- 内容在包里的 `sfly/cli/skills/sfly-node-dev/`，随 wheel 发布。仓库里这两个文件是指向用户文档
  的软链接（ADR 0013：只有一份源文件）：`SKILL.md` → docs/guide/skills/sfly-node-dev/SKILL.md，
  `reference.md` → SDK 参考页 docs/guide/sdk-reference.md；uv_build 构建 wheel 时跟随软链接。
- 写到项目的 `.agents/skills/sfly-node-dev/`（Codex 读取），`.claude/skills/sfly-node-dev`
  是指向它的相对软链接（Claude Code 读取）。
- 每次写入同时写 `.sfly-skill.json`（SDK 版本和每个文件的 sha256）。目录内容和它记录的不同，
  说明被改过，`sfly skill update` 不加 `--force` 就不覆盖。
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

SKILL_NAME = "sfly-node-dev"
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


def skill_dir(project: Path) -> Path:
    return project / ".agents" / "skills" / SKILL_NAME


def _bundled() -> dict[str, bytes]:
    """当前 SDK 版本带的 skill 文件：相对路径 → 内容。"""
    root = resources.files("sfly.cli") / "skills" / SKILL_NAME
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


def install(project: Path) -> Path:
    """把当前 SDK 版本的 skill 整个写进项目（替换已有的 skill 目录），返回 skill 目录。"""
    target = skill_dir(project)
    target.parent.mkdir(parents=True, exist_ok=True)
    files = _bundled()
    # 在旁边写好再换进去：中途失败不会留下一半新一半旧的目录。
    fresh = Path(tempfile.mkdtemp(prefix=f".{SKILL_NAME}.", dir=target.parent))
    try:
        for name, data in files.items():
            (fresh / name).write_bytes(data)
        manifest = {"sfly_version": __version__, "files": {n: _sha256(d) for n, d in files.items()}}
        (fresh / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        fresh.chmod(0o755)
        if target.exists() or target.is_symlink():
            old = Path(tempfile.mkdtemp(prefix=f".{SKILL_NAME}.old.", dir=target.parent))
            target.rename(old / SKILL_NAME)
            fresh.rename(target)
            shutil.rmtree(old, ignore_errors=True)
        else:
            fresh.rename(target)
    finally:
        shutil.rmtree(fresh, ignore_errors=True)

    link = project / ".claude" / "skills" / SKILL_NAME
    if not os.path.lexists(link):
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(os.path.relpath(target, link.parent), target_is_directory=True)
    return target


def update(project: Path, *, force: bool) -> Path:
    """`sfly skill update`：目录改动过且没有 force 时抛出 SkillError，不覆盖。"""
    if not (project / "pyproject.toml").is_file():
        raise SkillError(
            f"找不到 {project / 'pyproject.toml'}：在节点包项目的根目录运行，或用 --project 指定",
            usage=True,
        )
    target = skill_dir(project)
    found = changes(target) if target.is_dir() else Changes()
    if found and not force:
        lines = [f"skill 目录 {target} 和上次写入的不同，没有更新："]
        lines += [f"  改动：{n}" for n in found.modified]
        lines += [f"  新增：{n}" for n in found.added]
        lines += [f"  删除：{n}" for n in found.removed]
        lines.append("确认不需要这些改动后加 --force 覆盖（自己的约定请写在其他 skill 里）。")
        raise SkillError("\n".join(lines))
    return install(project)
