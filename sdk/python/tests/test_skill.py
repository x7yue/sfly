"""节点开发 skill `sfly-node-dev`：随 SDK wheel 发布，`sfly skill update` 换成当前 SDK 版本的内容。

skill 与 SDK 参考的源文件在用户文档目录 docs/guide 里（ADR 0013），wheel 里的内容必须和它们相同。
"""

from __future__ import annotations

import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

SFLY = str(Path(sys.executable).parent / "sfly")
GUIDE = Path(__file__).resolve().parents[3] / "docs" / "guide"
SKILL_SOURCES = {
    "SKILL.md": GUIDE / "skills" / "sfly-node-dev" / "SKILL.md",
    "reference.md": GUIDE / "sdk-reference.md",
}


def test_wheel_ships_skill_identical_to_user_docs(sfly_wheel: Path) -> None:
    with zipfile.ZipFile(sfly_wheel) as zf:
        for name, source in SKILL_SOURCES.items():
            assert zf.read(f"sfly/cli/skills/sfly-node-dev/{name}") == source.read_bytes(), name


def test_skill_files_have_no_doc_placeholders() -> None:
    # wheel 里的内容原样写进项目，控制面的占位符（{{SFLY_URL}} 等）不会被替换。
    for name, source in SKILL_SOURCES.items():
        assert "{{" not in source.read_text(encoding="utf-8"), name


def frontmatter(text: str) -> dict[str, str]:
    """解析 SKILL.md 的 frontmatter：只接受单行的 `键: 普通标量`（YAML 的严格子集）。"""
    assert text.startswith("---\n")
    head, sep, _ = text[4:].partition("\n---\n")
    assert sep, "frontmatter 没有结束的 ---"
    fields: dict[str, str] = {}
    for line in head.splitlines():
        key, sep, value = line.partition(": ")
        assert sep and re.fullmatch(r"[a-z][a-z-]*", key), line
        # 普通标量：不以 YAML 指示符开头，不含「: 」和「 #」。
        assert value and value[0] not in "-?:,[]{}#&*!|>'\"%@`", line
        assert ": " not in value and " #" not in value, line
        assert key not in fields, line
        fields[key] = value
    return fields


def test_skill_frontmatter_is_valid_and_model_invoked() -> None:
    fields = frontmatter(SKILL_SOURCES["SKILL.md"].read_text(encoding="utf-8"))

    assert set(fields) == {"name", "description"}  # 没有 disable-model-invocation
    assert fields["name"] == "sfly-node-dev"  # 与目录名相同
    description = fields["description"]
    assert description.startswith("开发 sfly 节点包")
    assert len(description) <= 500
    for trigger in ("新增或修改", "本地调试", "联调", "构建", "发布"):
        assert trigger in description, trigger


def skill_update(project: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [SFLY, "skill", "update", *args],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=60,
    )


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """一个节点包项目（只需要 pyproject.toml）。"""
    project = tmp_path / "demo"
    project.mkdir()
    (project / "pyproject.toml").write_text('[project]\nname = "demo"\nversion = "0.1.0"\n')
    return project


def skill(project: Path) -> Path:
    return project / ".agents" / "skills" / "sfly-node-dev"


def assert_current(project: Path) -> None:
    for name, source in SKILL_SOURCES.items():
        assert (skill(project) / name).read_bytes() == source.read_bytes(), name
    link = project / ".claude" / "skills" / "sfly-node-dev"
    assert link.is_symlink() and link.resolve() == skill(project).resolve()


def test_update_writes_missing_skill(project: Path) -> None:
    run = skill_update(project)

    assert run.returncode == 0, run.stderr
    assert "已更新" in run.stdout
    assert_current(project)


def test_update_replaces_unmodified_skill_directly(project: Path) -> None:
    assert skill_update(project).returncode == 0

    run = skill_update(project)

    assert run.returncode == 0, run.stderr
    assert_current(project)


def test_update_refuses_to_overwrite_modified_skill_without_force(project: Path) -> None:
    assert skill_update(project).returncode == 0
    (skill(project) / "SKILL.md").write_text("我改过的 skill\n", encoding="utf-8")
    (skill(project) / "notes.md").write_text("我的笔记\n", encoding="utf-8")
    (skill(project) / "reference.md").unlink()

    run = skill_update(project)

    assert run.returncode == 1
    assert "改动：SKILL.md" in run.stderr
    assert "新增：notes.md" in run.stderr
    assert "删除：reference.md" in run.stderr
    assert "--force" in run.stderr
    assert (skill(project) / "SKILL.md").read_text(encoding="utf-8") == "我改过的 skill\n"
    assert (skill(project) / "notes.md").is_file()

    forced = skill_update(project, "--force")

    assert forced.returncode == 0, forced.stderr
    assert_current(project)
    assert not (skill(project) / "notes.md").exists()  # 整个目录被替换
    assert skill_update(project).returncode == 0  # 覆盖之后又是「未改动」


def test_update_treats_hand_written_skill_as_modified(project: Path) -> None:
    skill(project).mkdir(parents=True)
    (skill(project) / "SKILL.md").write_text("手写的 skill\n", encoding="utf-8")

    run = skill_update(project)

    assert run.returncode == 1
    assert "新增：SKILL.md" in run.stderr
    assert (skill(project) / "SKILL.md").read_text(encoding="utf-8") == "手写的 skill\n"


def test_update_outside_a_project_fails(tmp_path: Path) -> None:
    run = skill_update(tmp_path)

    assert run.returncode == 2
    assert "pyproject.toml" in run.stderr
    assert list(tmp_path.iterdir()) == []
