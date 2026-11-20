"""文档引用检查（scripts/check_doc_references.py）：每一类各有一条该拦的、一条不该拦的。
每个用例在临时目录里建一个只含几份文档和源码的 git 仓库（检查读 git 已跟踪的文件），
不碰真实仓库。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_doc_references.py"
ENV = {
    **{k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}

SEMANTICS = """# 场景执行语义规范

## 1. 场景结构

### 1.1 组成

## 4. 异步任务节点与子流程

### 4.1 停止子流程节点

### 4.2 飞书通知节点

## 5. 内置等待节点
"""
ARCHITECTURE = """# sfly 架构设计

## 5. Agent

### 5.4 Agent 与执行器之间的本地协议

## 7. 前端

### 7.6 性能测试
"""
DESIGN_SYSTEM = """# 前端设计规范

## 2. 设计 token

### 2.1 基础色阶
"""
BASE_FILES = {
    "docs/SEMANTICS.md": SEMANTICS,
    "docs/ARCHITECTURE.md": ARCHITECTURE,
    "docs/DESIGN-SYSTEM.md": DESIGN_SYSTEM,
    "docs/guide/quickstart.md": "# 快速开始\n\n## 安装\n\n## 上传 sfly-std\n",
    "apps/server/src/engine/engine.ts": "export {};\n",
    "agent/src/logs.rs": "// logs\n",
    "README.md": "# sfly\n",
    ".gitignore": "dist/\nout/\n",
}


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], env=ENV, check=True, capture_output=True)


def put(repo: Path, files: dict[str, str]) -> None:
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def check(repo: Path, *, stage: bool = True) -> subprocess.CompletedProcess[str]:
    if stage:
        git(repo, "add", "-A")
    return subprocess.run(
        [sys.executable, str(repo / "scripts" / "check_doc_references.py")],
        env=ENV,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "scripts" / "check_doc_references.py")
    put(root, BASE_FILES)
    git(root, "init", "-b", "main")
    return root


def test_clean_repo_passes(repo: Path) -> None:
    result = check(repo)

    assert result.returncode == 0, result.stderr
    assert result.stderr == ""


# —— 反引号里的仓库路径 ——


def test_backticked_path_that_exists_passes(repo: Path) -> None:
    put(repo, {"README.md": "引擎在 `apps/server/src/engine/engine.ts`，目录 `agent/src/`。\n"})

    assert check(repo).returncode == 0


def test_backticked_path_that_does_not_exist_fails_with_file_line_and_how_to_fix(
    repo: Path,
) -> None:
    put(repo, {"docs/guide/notes.md": "# 笔记\n\n第一行\n见 `apps/server/src/engine/nope.ts`。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "docs/guide/notes.md:4" in result.stderr
    assert "apps/server/src/engine/nope.ts" in result.stderr
    assert "scripts/doc-references.allow" in result.stderr


def test_missing_path_suggests_a_tracked_file_with_the_same_name(repo: Path) -> None:
    put(repo, {"README.md": "引擎在 `apps/server/src/engine.ts`。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "apps/server/src/engine/engine.ts" in result.stderr


def test_missing_path_suggests_the_new_name_after_a_rename(repo: Path) -> None:
    put(repo, {"agent/src/old_name.rs": "// x\n"})
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "add")
    git(repo, "mv", "agent/src/old_name.rs", "agent/src/new_name.rs")
    git(repo, "commit", "-m", "rename")
    put(repo, {"README.md": "见 `agent/src/old_name.rs`。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "agent/src/new_name.rs" in result.stderr


def test_runtime_paths_that_do_not_start_with_a_repo_top_level_name_are_not_checked(
    repo: Path,
) -> None:
    put(
        repo,
        {
            "README.md": (
                "节点读 `task.json`，写 `out/result.json`，Agent 在 `~/.sfly/agent/`，"
                "日志在 `/var/log/sfly.log`，目录 `std/` 以外的 `node.py`。\n"
            )
        },
    )

    assert check(repo).returncode == 0


def test_wildcards_and_placeholders_are_not_checked(repo: Path) -> None:
    put(
        repo,
        {
            "README.md": (
                "`docs/guide/*.md`、`docs/<页面>.md`、`apps/{web,server}/src`、"
                "`docs/perf/X.Y.Z/`、`agent/src/…`、`agent/src/...`、`agent/src/x?.rs`。\n"
            )
        },
    )

    assert check(repo).returncode == 0


def test_line_number_and_symbol_suffixes_are_ignored_but_the_path_is_still_checked(
    repo: Path,
) -> None:
    put(repo, {"README.md": "`apps/server/src/engine/engine.ts:12-30`、`agent/src/logs.rs#run`\n"})
    assert check(repo).returncode == 0

    put(repo, {"README.md": "`apps/server/src/engine/gone.ts:12`\n"})
    result = check(repo)

    assert result.returncode == 1
    assert "apps/server/src/engine/gone.ts:12" in result.stderr


def test_paths_that_git_ignores_are_build_output_and_not_checked(repo: Path) -> None:
    put(repo, {"README.md": "产物在 `apps/server/dist/client`、`apps/web/dist/`、`out/server`。\n"})

    assert check(repo).returncode == 0


def test_code_blocks_and_spans_with_spaces_are_not_checked(repo: Path) -> None:
    put(
        repo,
        {
            "README.md": (
                "```text\napps/server/src/engine/gone.ts\n`agent/src/gone.rs`\n```\n\n"
                "命令 `pnpm test apps/server/src/engine/gone.ts`。\n"
            )
        },
    )

    assert check(repo).returncode == 0


def test_adr_and_research_keep_their_old_names(repo: Path) -> None:
    put(
        repo,
        {
            "docs/adr/0001-first.md": (
                "见 `apps/server/src/removed.ts`，docs/SEMANTICS.md §9.9，[x](gone.md)\n"
            ),
            "docs/research/survey.md": "见 `agent/src/removed.rs`\n",
        },
    )

    assert check(repo).returncode == 0


def test_a_markdown_file_that_is_a_symlink_is_not_reported_twice(repo: Path) -> None:
    put(repo, {"docs/guide/page.md": "见 `apps/server/src/engine/nope.ts`。\n"})
    (repo / "agent" / "src").mkdir(parents=True, exist_ok=True)
    os.symlink("../../docs/guide/page.md", repo / "agent" / "src" / "copy.md")

    result = check(repo)

    assert result.returncode == 1
    assert result.stderr.count("apps/server/src/engine/nope.ts 不存在") == 1


def test_a_new_file_that_is_not_added_yet_counts_for_paths_and_references(repo: Path) -> None:
    git(repo, "add", "-A")
    put(
        repo,
        {
            "agent/src/fresh.rs": "// docs/SEMANTICS.md §4.1\n",
            "README.md": "见 `agent/src/fresh.rs`。\n",
        },
    )
    assert check(repo, stage=False).returncode == 0

    put(repo, {"agent/src/fresh.rs": "// docs/SEMANTICS.md §4.9\n"})
    result = check(repo, stage=False)

    assert result.returncode == 1
    assert "agent/src/fresh.rs:1" in result.stderr


# —— 章节引用 ——


def test_section_reference_with_the_document_path_passes(repo: Path) -> None:
    put(
        repo,
        {
            "apps/server/src/engine/ids.ts": (
                "// 停止子流程（docs/SEMANTICS.md §4.1），协议见 docs/ARCHITECTURE.md §5.4。\n"
                "// 一组引用沿用前面的文档：docs/SEMANTICS.md §1.1、§4.2、§5，\n"
                "// 章节里的某一条：docs/SEMANTICS.md §4 第 6 条。\n"
                "// 设计规范：docs/DESIGN-SYSTEM.md §2.1\n"
            )
        },
    )

    result = check(repo)

    assert result.returncode == 0, result.stderr


def test_section_that_has_no_heading_fails_and_names_the_neighbours(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// 链实例 ID（docs/SEMANTICS.md §4.6）。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "apps/server/src/engine/ids.ts:1" in result.stderr
    assert "docs/SEMANTICS.md §4.6" in result.stderr
    assert "4.1" in result.stderr and "4.2" in result.stderr
    assert "§4 第 6 条" in result.stderr


def test_a_missing_section_inside_a_reference_list_is_reported(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// docs/SEMANTICS.md §1.1、§6.4。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "§6.4" in result.stderr


def test_section_reference_without_a_document_fails(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// 取消整个运行（§4.1）。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "apps/server/src/engine/ids.ts:1" in result.stderr
    assert "没有写明是哪份文档" in result.stderr
    assert "docs/SEMANTICS.md §4.1" in result.stderr


@pytest.mark.parametrize(
    "text",
    [
        "// SEMANTICS §4.1",
        "// SEMANTICS.md §4.1",
        "// docs/SEMANTICS §4.1",
        "// docs/SEMANTICS.md 第 4.1 节",
        "// `docs/SEMANTICS.md` §4.1",
    ],
)
def test_other_ways_of_writing_a_section_reference_fail_and_show_the_agreed_one(
    repo: Path, text: str
) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": text + "\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "docs/SEMANTICS.md §4.1" in result.stderr


def test_inside_the_numbered_documents_a_bare_section_refers_to_the_document_itself(
    repo: Path,
) -> None:
    put(repo, {"docs/SEMANTICS.md": SEMANTICS + "\n见 §4.1，以及 docs/ARCHITECTURE.md §5.4。\n"})
    assert check(repo).returncode == 0

    put(repo, {"docs/SEMANTICS.md": SEMANTICS + "\n见 §4.9。\n"})
    result = check(repo)

    assert result.returncode == 1
    assert "docs/SEMANTICS.md:" in result.stderr
    assert "§4.9" in result.stderr


def test_the_numbered_documents_write_section_references_with_the_section_sign(
    repo: Path,
) -> None:
    put(repo, {"docs/SEMANTICS.md": SEMANTICS + "\n停止子流程节点（第 4.1 节）。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "第 4.1 节" in result.stderr
    assert "§4.1" in result.stderr


def test_section_references_in_generated_code_are_not_checked(
    repo: Path,
) -> None:
    put(repo, {"packages/client/src/generated/types.ts": "// 保存只警告（§1.2）。\n"})

    assert check(repo).returncode == 0


# —— Markdown 相对链接和锚点 ——


def test_relative_links_and_anchors_that_exist_pass(repo: Path) -> None:
    put(
        repo,
        {
            "docs/guide/page.md": (
                "# 页面\n\n## 小节 A\n\n"
                "[快速开始](quickstart.md)，[上传](quickstart.md#上传-sfly-std)，"
                "[本页](#小节-a)，[目录](../../docs/guide/)，[外部](https://example.com/x#y)，"
                "[前端页面](/docs/quickstart)，[邮件](mailto:a@example.com)\n"
            )
        },
    )

    result = check(repo)

    assert result.returncode == 0, result.stderr


def test_link_to_a_missing_file_fails(repo: Path) -> None:
    put(repo, {"docs/guide/page.md": "# 页面\n\n见 [没有的页](missing.md)。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "docs/guide/page.md:3" in result.stderr
    assert "missing.md" in result.stderr


def test_link_to_a_missing_anchor_fails_and_lists_the_headings(repo: Path) -> None:
    put(repo, {"docs/guide/page.md": "# 页面\n\n见 [安装](quickstart.md#没有的小节)。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "docs/guide/page.md:3" in result.stderr
    assert "#没有的小节" in result.stderr
    assert "安装" in result.stderr


def test_link_to_a_missing_anchor_in_the_same_file_fails(repo: Path) -> None:
    put(repo, {"docs/guide/page.md": "# 页面\n\n## 小节\n\n[回到](#没有)\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "#没有" in result.stderr


def test_links_inside_code_are_not_checked_and_headings_inside_code_do_not_count(
    repo: Path,
) -> None:
    put(
        repo,
        {
            "docs/guide/page.md": (
                "# 页面\n\n`[x](gone.md)`\n\n```md\n[y](gone.md)\n# 代码里的标题\n```\n"
            )
        },
    )
    assert check(repo).returncode == 0

    put(
        repo, {"docs/guide/page.md": "# 页面\n\n```md\n# 代码里的标题\n```\n\n[z](#代码里的标题)\n"}
    )
    assert check(repo).returncode == 1


def test_links_in_a_file_that_a_symlink_points_to_also_resolve_from_the_symlink(
    repo: Path,
) -> None:
    put(
        repo,
        {
            "docs/guide/skills/page/SKILL.md": "# 页\n\n见 [参考](reference.md)。\n",
            "docs/guide/reference-source.md": "# 参考\n",
        },
    )
    link_dir = repo / "agent" / "skills" / "page"
    link_dir.mkdir(parents=True)
    os.symlink("../../../docs/guide/skills/page/SKILL.md", link_dir / "SKILL.md")
    os.symlink("../../../docs/guide/reference-source.md", link_dir / "reference.md")

    result = check(repo)

    assert result.returncode == 0, result.stderr


# —— 放行 ——


def test_allow_entry_with_a_reason_lets_one_reference_through(repo: Path) -> None:
    put(
        repo,
        {
            "README.md": "用户项目里有 `apps/mine/main.py`，仓库里没有。\n",
            "scripts/doc-references.allow": (
                "# 文件 | 引用原文 | 原因\n"
                "README.md | apps/mine/main.py | 描述用户项目的目录，不是本仓库的\n"
            ),
        },
    )

    result = check(repo)

    assert result.returncode == 0, result.stderr


def test_allow_entry_without_a_reason_is_an_error(repo: Path) -> None:
    put(
        repo,
        {
            "README.md": "有 `apps/mine/main.py`。\n",
            "scripts/doc-references.allow": "README.md | apps/mine/main.py |\n",
        },
    )

    result = check(repo)

    assert result.returncode == 1
    assert "scripts/doc-references.allow:1" in result.stderr
    assert "原因" in result.stderr


def test_allow_entry_that_no_longer_matches_anything_is_an_error(repo: Path) -> None:
    put(
        repo,
        {
            "README.md": "没有失效的引用。\n",
            "scripts/doc-references.allow": "README.md | apps/mine/main.py | 过去需要\n",
        },
    )

    result = check(repo)

    assert result.returncode == 1
    assert "scripts/doc-references.allow:1" in result.stderr
    assert "删掉" in result.stderr


def test_allow_entry_works_for_section_references_and_links_too(repo: Path) -> None:
    put(
        repo,
        {
            "apps/server/src/engine/ids.ts": "// 历史注释：docs/SEMANTICS.md §6.4\n",
            "docs/guide/page.md": "# 页面\n\n[旧页](gone.md)\n",
            "scripts/doc-references.allow": (
                "apps/server/src/engine/ids.ts | docs/SEMANTICS.md §6.4 | 保留当时的写法\n"
                "docs/guide/page.md | gone.md | 页面还没合入\n"
            ),
        },
    )

    result = check(repo)

    assert result.returncode == 0, result.stderr
