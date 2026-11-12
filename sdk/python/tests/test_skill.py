"""给 AI 编程助手的两份 skill `sfly-node-dev` 和 `sfly-platform`：随 SDK wheel 发布，
`sfly skill update` 换成当前 SDK 版本的内容。

skill 和作为 reference.md 的文档页（SDK 参考、用命令行操作平台）的源文件在用户文档目录 docs/guide 里
（ADR 0013），wheel 里的内容必须和它们相同。
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

SFLY = str(Path(sys.executable).parent / "sfly")
GUIDE = Path(__file__).resolve().parents[3] / "docs" / "guide"
SKILLS = {
    "sfly-node-dev": {
        "SKILL.md": GUIDE / "skills" / "sfly-node-dev" / "SKILL.md",
        "reference.md": GUIDE / "sdk-reference.md",
    },
    "sfly-platform": {
        "SKILL.md": GUIDE / "skills" / "sfly-platform" / "SKILL.md",
        "reference.md": GUIDE / "platform-cli.md",
    },
}
TRIGGERS = {
    "sfly-node-dev": ("开发 sfly 节点包", ("新增或修改", "本地调试", "联调", "构建", "发布")),
    "sfly-platform": (
        "用 sfly 命令行操作 sfly 平台",
        ("联调", "触发", "等待", "日志", "场景", "Agent"),
    ),
}


@pytest.mark.parametrize("skill", SKILLS)
def test_wheel_ships_skill_identical_to_user_docs(sfly_wheel: Path, skill: str) -> None:
    with zipfile.ZipFile(sfly_wheel) as zf:
        for name, source in SKILLS[skill].items():
            assert zf.read(f"sfly/cli/skills/{skill}/{name}") == source.read_bytes(), name


@pytest.mark.parametrize("skill", SKILLS)
def test_skill_files_have_no_doc_placeholders(skill: str) -> None:
    # wheel 里的内容原样写进项目，控制面的占位符（{{SFLY_URL}} 等）不会被替换。
    for name, source in SKILLS[skill].items():
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


@pytest.mark.parametrize("skill", SKILLS)
def test_skill_frontmatter_is_valid_and_model_invoked(skill: str) -> None:
    fields = frontmatter(SKILLS[skill]["SKILL.md"].read_text(encoding="utf-8"))

    assert set(fields) == {"name", "description"}  # 没有 disable-model-invocation
    assert fields["name"] == skill  # 与目录名相同
    start, triggers = TRIGGERS[skill]
    description = fields["description"]
    assert description.startswith(start)
    assert len(description) <= 500
    for trigger in triggers:
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


def skill(project: Path, name: str = "sfly-node-dev") -> Path:
    return project / ".agents" / "skills" / name


def assert_current(project: Path, name: str) -> None:
    for file, source in SKILLS[name].items():
        assert (skill(project, name) / file).read_bytes() == source.read_bytes(), file
    link = project / ".claude" / "skills" / name
    assert link.is_symlink() and link.resolve() == skill(project, name).resolve()


def assert_all_current(project: Path) -> None:
    for name in SKILLS:
        assert_current(project, name)


def test_update_writes_both_missing_skills(project: Path) -> None:
    run = skill_update(project)

    assert run.returncode == 0, run.stderr
    for name in SKILLS:
        assert f"已更新 skill {name}" in run.stdout
    assert_all_current(project)


def test_update_replaces_unmodified_skills_directly(project: Path) -> None:
    assert skill_update(project).returncode == 0

    run = skill_update(project)

    assert run.returncode == 0, run.stderr
    assert_all_current(project)


@pytest.mark.parametrize("modified", SKILLS)
def test_update_refuses_to_overwrite_a_modified_skill_without_force(
    project: Path, modified: str
) -> None:
    assert skill_update(project).returncode == 0
    other = next(name for name in SKILLS if name != modified)
    (skill(project, modified) / "SKILL.md").write_text("我改过的 skill\n", encoding="utf-8")
    (skill(project, modified) / "notes.md").write_text("我的笔记\n", encoding="utf-8")
    (skill(project, modified) / "reference.md").unlink()
    # 另一份被删掉了：它不受改过的那份影响，照常写回来。
    shutil.rmtree(skill(project, other))

    run = skill_update(project)

    assert run.returncode == 1
    assert "改动：SKILL.md" in run.stderr
    assert "新增：notes.md" in run.stderr
    assert "删除：reference.md" in run.stderr
    assert "--force" in run.stderr
    assert f"已更新 skill {other}" in run.stdout
    assert modified not in run.stdout
    assert (skill(project, modified) / "SKILL.md").read_text(encoding="utf-8") == "我改过的 skill\n"
    assert (skill(project, modified) / "notes.md").is_file()
    assert_current(project, other)

    forced = skill_update(project, "--force")

    assert forced.returncode == 0, forced.stderr
    assert_all_current(project)
    assert not (skill(project, modified) / "notes.md").exists()  # 整个目录被替换
    assert skill_update(project).returncode == 0  # 覆盖之后又是「未改动」


@pytest.mark.parametrize("name", SKILLS)
def test_update_treats_hand_written_skill_as_modified(project: Path, name: str) -> None:
    skill(project, name).mkdir(parents=True)
    (skill(project, name) / "SKILL.md").write_text("手写的 skill\n", encoding="utf-8")

    run = skill_update(project)

    assert run.returncode == 1
    assert "新增：SKILL.md" in run.stderr
    assert (skill(project, name) / "SKILL.md").read_text(encoding="utf-8") == "手写的 skill\n"
    for other in SKILLS.keys() - {name}:
        assert_current(project, other)


def test_update_outside_a_project_fails(tmp_path: Path) -> None:
    run = skill_update(tmp_path)

    assert run.returncode == 2
    assert "pyproject.toml" in run.stderr
    assert list(tmp_path.iterdir()) == []
