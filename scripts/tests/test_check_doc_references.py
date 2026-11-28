"""文档引用检查（scripts/check_doc_references.py）：每一类各有一条该拦的、一条不该拦的。
每个用例在临时目录里建一个只含几份文档和源码的 git 仓库（检查读 git 已跟踪的文件），
不碰真实仓库。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

REPO_ROOT = Path(__file__).resolve().parents[2]
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


def make_repo(tmp_path: Path) -> Path:
    """临时目录里的仓库：检查脚本和它用到的模块、几份基础文档（别的测试文件也用它）。"""
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "scripts" / "check_doc_references.py")
    shutil.copy(SCRIPT.with_name("doc_commands.py"), root / "scripts" / "doc_commands.py")
    put(root, BASE_FILES)
    git(root, "init", "-b", "main")
    return root


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    return make_repo(tmp_path)


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
    assert "§4 下的小节是 4.1、4.2" in result.stderr
    # 「§N 第 M 条」检查不再核对：提示不能把人引向查不出的写法。
    assert "第 6 条" not in result.stderr


def test_a_missing_deeper_section_names_the_longest_heading_that_exists(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// docs/SEMANTICS.md §4.1.2\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "docs/SEMANTICS.md §4.1.2 指向的章节不存在" in result.stderr
    assert "§4.1 没有再分的小节" in result.stderr
    assert "第 1.2 条" not in result.stderr
    assert "第 2 条" not in result.stderr


def test_a_missing_chapter_lists_the_chapters_that_exist(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// docs/SEMANTICS.md §9\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "§1 到 §5" in result.stderr


def test_a_missing_section_inside_a_reference_list_is_reported(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// 第一行\n// docs/SEMANTICS.md §1.1、§6.4。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert (
        "apps/server/src/engine/ids.ts:2: docs/SEMANTICS.md §6.4 指向的章节不存在" in result.stderr
    )
    assert "§1.1 指向" not in result.stderr
    assert "没有写明是哪份文档" not in result.stderr


def test_a_reference_list_keeps_the_document_of_its_first_reference(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// docs/SEMANTICS.md §1.1、§5.4。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "docs/SEMANTICS.md §5.4 指向的章节不存在" in result.stderr


def test_reference_lists_may_use_other_separators_and_deeper_numbers_are_not_cut_short(
    repo: Path,
) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// docs/SEMANTICS.md §1.1，§4.1,§4.2、§5\n"})
    assert check(repo).returncode == 0

    put(repo, {"apps/server/src/engine/ids.ts": "// docs/SEMANTICS.md §4.1.2\n"})
    result = check(repo)

    assert result.returncode == 1
    assert "docs/SEMANTICS.md §4.1.2 指向的章节不存在" in result.stderr


def test_section_reference_without_a_document_fails(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// 取消整个运行（§4.1）。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "apps/server/src/engine/ids.ts:1" in result.stderr
    assert "没有写明是哪份文档" in result.stderr
    assert "docs/SEMANTICS.md" in result.stderr


def test_the_hint_for_a_section_without_a_document_names_only_the_documents_that_have_it(
    repo: Path,
) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// 性能测试的目标（§7.6）。\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "docs/ARCHITECTURE.md" in result.stderr
    assert "docs/SEMANTICS.md" not in result.stderr
    assert "docs/DESIGN-SYSTEM.md" not in result.stderr


def test_the_hint_for_a_section_that_no_document_has_says_so(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// 见 §9.9\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "都没有" in result.stderr


@pytest.mark.parametrize(
    "text",
    [
        "// SEMANTICS §4.1",
        "// SEMANTICS.md §4.1",
        "// docs/SEMANTICS §4.1",
        "// docs/SEMANTICS.md 第 4.1 节",
        "// `docs/SEMANTICS.md` §4.1",
        "// docs/SEMANTICS.md 的 §4.1",
        "// SEMANTICS 第 4.1 节",
        "// SEMANTICS.md 的第 4.1 节",
    ],
)
def test_other_ways_of_writing_a_section_reference_fail_and_show_the_agreed_one(
    repo: Path, text: str
) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": text + "\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "写法不统一" in result.stderr
    assert "docs/SEMANTICS.md §4.1" in result.stderr


def test_an_item_number_and_a_reference_list_can_be_combined(repo: Path) -> None:
    put(
        repo,
        {"apps/server/src/engine/ids.ts": "// docs/SEMANTICS.md §4 第 6 条、§1.1、§4.2 第 3 条\n"},
    )
    assert check(repo).returncode == 0

    put(repo, {"apps/server/src/engine/ids.ts": "// docs/SEMANTICS.md §4 第 6 条、§9\n"})
    result = check(repo)

    assert result.returncode == 1
    assert "docs/SEMANTICS.md §9 指向的章节不存在" in result.stderr
    assert "没有写明是哪份文档" not in result.stderr


def test_section_signs_that_follow_an_rfc_or_an_adr_number_are_not_ours(repo: Path) -> None:
    put(
        repo,
        {
            "apps/server/src/engine/ids.ts": (
                "// 状态码见 RFC 9110 §15.5.20，ADR 0024 §2、§3，RFC 9110 §15.5.20、§15.5.21\n"
            )
        },
    )
    assert check(repo).returncode == 0

    put(repo, {"apps/server/src/engine/ids.ts": "// RFC 9110 §15.5.20；本地的 §3.1\n"})
    result = check(repo)

    assert result.returncode == 1
    assert "§3.1 没有写明是哪份文档" in result.stderr
    assert "15.5" not in result.stderr


def test_a_space_after_the_section_sign_does_not_hide_a_missing_section(repo: Path) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": "// docs/SEMANTICS.md § 4.9\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "docs/SEMANTICS.md §4.9 指向的章节不存在" in result.stderr


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


def test_perf_reports_and_documentation_fixtures_are_not_checked(repo: Path) -> None:
    put(
        repo,
        {
            "docs/perf/0.1.0/report.md": "目标 §7.6，`apps/server/gone.ts`，[x](gone.md)\n",
            "apps/web/e2e/docs-fixture/page.md": (
                "见 `apps/server/gone.ts`，docs/SEMANTICS.md §9.9\n"
            ),
        },
    )

    assert check(repo).returncode == 0


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


def test_footnote_definitions_are_not_links(repo: Path) -> None:
    put(repo, {"docs/guide/page.md": "# 页面\n\n正文[^1]\n\n[^1]: 脚注文字\n"})

    result = check(repo)

    assert result.returncode == 0, result.stderr


def test_duplicate_headings_get_numbered_anchors_and_a_longer_fence_hides_inner_fences(
    repo: Path,
) -> None:
    put(
        repo,
        {
            "docs/guide/page.md": (
                "# 页面\n\n## 小节\n\n## 小节\n\n````md\n```\n# 里面的标题\n```\n````\n\n"
                "[第二个](#小节-1)\n"
            )
        },
    )
    assert check(repo).returncode == 0

    put(
        repo,
        {
            "docs/guide/page.md": (
                "# 页面\n\n````md\n```\n```\n# 里面的标题\n````\n\n[x](#里面的标题)\n"
            )
        },
    )
    assert check(repo).returncode == 1


def test_a_link_that_leaves_the_repository_fails(repo: Path) -> None:
    put(repo, {"docs/guide/page.md": "# 页面\n\n[外面](../../../outside.md)\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "指到了仓库外面" in result.stderr


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


def run_outside_a_repository(
    tmp_path: Path, env: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    root = tmp_path / "not-a-repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "scripts" / "check_doc_references.py")
    shutil.copy(SCRIPT.with_name("doc_commands.py"), root / "scripts" / "doc_commands.py")
    return subprocess.run(
        [sys.executable, str(root / "scripts" / "check_doc_references.py")],
        env=env,
        capture_output=True,
        text=True,
    )


def test_without_a_git_work_tree_it_says_what_it_skipped_and_does_not_crash(
    tmp_path: Path,
) -> None:
    result = run_outside_a_repository(tmp_path, {**ENV, "GIT_CEILING_DIRECTORIES": str(tmp_path)})

    assert result.returncode == 0
    assert result.stderr.count("\n") == 1
    assert "git" in result.stderr
    assert "跳过" in result.stderr
    assert "Traceback" not in result.stderr


def test_without_a_git_executable_it_says_what_it_skipped_and_does_not_crash(
    tmp_path: Path,
) -> None:
    result = run_outside_a_repository(tmp_path, {**ENV, "PATH": str(tmp_path / "empty")})

    assert result.returncode == 0
    assert result.stderr.count("\n") == 1
    assert "跳过" in result.stderr
    assert "Traceback" not in result.stderr


def test_pyproject_type_checks_the_script_and_only_collects_tests_from_directories() -> None:
    config = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert "scripts/check_doc_references.py" in config["tool"]["mypy"]["files"]
    for entry in config["tool"]["pytest"]["ini_options"]["testpaths"]:
        assert (REPO_ROOT / entry).is_dir(), entry


# —— 仓库自带的 skill：真实文件在 .agents/skills，.claude/skills 是指向它的软链 ——


def add_skill(repo: Path, name: str, *, link: bool = True, skill_md: bool = True) -> None:
    put(repo, {f".agents/skills/{name}/notes.md": "# 说明\n"})
    if skill_md:
        put(repo, {f".agents/skills/{name}/SKILL.md": "# skill\n"})
    if link:
        (repo / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
        os.symlink(f"../../.agents/skills/{name}", repo / ".claude" / "skills" / name)


def test_skills_that_live_in_agents_and_are_linked_from_claude_pass(repo: Path) -> None:
    add_skill(repo, "alpha")
    add_skill(repo, "beta")

    result = check(repo)

    assert result.returncode == 0, result.stderr


def test_a_real_directory_in_claude_skills_fails_and_says_how_to_move_it(repo: Path) -> None:
    put(repo, {".claude/skills/gamma/SKILL.md": "# skill\n"})

    result = check(repo)

    assert result.returncode == 1
    assert ".claude/skills/gamma" in result.stderr
    assert "$ ln -sfn ../../.agents/skills/gamma .claude/skills/gamma" in result.stderr
    assert "$ git mv .claude/skills/gamma .agents/skills/gamma" in result.stderr


def test_a_skill_without_a_link_in_claude_skills_fails_and_says_how_to_link_it(
    repo: Path,
) -> None:
    add_skill(repo, "delta", link=False)

    result = check(repo)

    assert result.returncode == 1
    assert ".agents/skills/delta" in result.stderr
    assert "$ ln -sfn ../../.agents/skills/delta .claude/skills/delta" in result.stderr


def test_a_link_to_the_wrong_place_fails(repo: Path) -> None:
    add_skill(repo, "epsilon", link=False)
    (repo / ".claude" / "skills").mkdir(parents=True)
    os.symlink("../../docs/epsilon", repo / ".claude" / "skills" / "epsilon")

    result = check(repo)

    assert result.returncode == 1
    assert ".claude/skills/epsilon" in result.stderr
    assert "$ ln -sfn ../../.agents/skills/epsilon .claude/skills/epsilon" in result.stderr


def test_a_skill_directory_without_skill_md_fails(repo: Path) -> None:
    add_skill(repo, "zeta", skill_md=False)

    result = check(repo)

    assert result.returncode == 1
    assert ".agents/skills/zeta/SKILL.md" in result.stderr


def test_a_skill_that_is_itself_a_link_in_agents_skills_fails(repo: Path) -> None:
    put(repo, {".claude/skills/eta/SKILL.md": "# skill\n"})
    (repo / ".agents" / "skills").mkdir(parents=True)
    os.symlink("../../.claude/skills/eta", repo / ".agents" / "skills" / "eta")

    result = check(repo)

    assert result.returncode == 1
    assert ".agents/skills/eta" in result.stderr


def broken_real_directory(repo: Path) -> None:
    (repo / ".agents" / "skills").mkdir(parents=True)
    put(repo, {".claude/skills/gamma/SKILL.md": "# skill\n"})


def broken_both_sides_have_a_real_directory(repo: Path) -> None:
    add_skill(repo, "alpha")
    add_skill(repo, "gamma", link=False)
    put(repo, {".claude/skills/gamma/SKILL.md": "# skill\n"})


def broken_no_link(repo: Path) -> None:
    add_skill(repo, "alpha")
    add_skill(repo, "gamma", link=False)


def broken_link_points_elsewhere(repo: Path) -> None:
    add_skill(repo, "gamma", link=False)
    (repo / ".claude" / "skills").mkdir(parents=True)
    os.symlink("../../docs/guide", repo / ".claude" / "skills" / "gamma")
    (repo / "docs" / "guide").mkdir(parents=True, exist_ok=True)


def broken_absolute_link(repo: Path) -> None:
    add_skill(repo, "gamma", link=False)
    (repo / ".claude" / "skills").mkdir(parents=True)
    os.symlink(repo / ".agents" / "skills" / "gamma", repo / ".claude" / "skills" / "gamma")


def broken_dangling_link_to_another_name(repo: Path) -> None:
    add_skill(repo, "gamma", link=False)
    (repo / ".claude" / "skills").mkdir(parents=True)
    os.symlink("../../.agents/skills/nope", repo / ".claude" / "skills" / "gamma")


def broken_skill_was_renamed(repo: Path) -> None:
    add_skill(repo, "old")
    (repo / ".agents" / "skills" / "old").rename(repo / ".agents" / "skills" / "new")


def broken_link_without_a_skill(repo: Path) -> None:
    (repo / ".claude" / "skills").mkdir(parents=True)
    os.symlink("../../.agents/skills/ghost", repo / ".claude" / "skills" / "ghost")


def broken_plain_file(repo: Path) -> None:
    put(repo, {".claude/skills/README.md": "# 说明\n"})


BROKEN_SKILL_LAYOUTS = [
    broken_real_directory,
    broken_both_sides_have_a_real_directory,
    broken_no_link,
    broken_link_points_elsewhere,
    broken_absolute_link,
    broken_dangling_link_to_another_name,
    broken_skill_was_renamed,
    broken_link_without_a_skill,
    broken_plain_file,
]


@pytest.mark.parametrize("layout", BROKEN_SKILL_LAYOUTS, ids=lambda f: f.__name__)
def test_running_the_commands_in_the_report_fixes_every_broken_skill_layout(
    repo: Path, layout: Callable[[Path], None]
) -> None:
    layout(repo)
    result = check(repo)
    assert result.returncode == 1
    commands = [
        line.removeprefix("  $ ") for line in result.stderr.splitlines() if line.startswith("  $ ")
    ]
    assert commands, result.stderr

    for command in commands:
        subprocess.run(["bash", "-c", command], cwd=repo, env=ENV, check=True, capture_output=True)
    fixed = check(repo)

    assert fixed.returncode == 0, f"{commands}\n{fixed.stderr}"


def test_a_link_whose_skill_directory_does_not_exist_fails(repo: Path) -> None:
    broken_link_without_a_skill(repo)

    result = check(repo)

    assert result.returncode == 1
    assert ".claude/skills/ghost" in result.stderr
    assert ".agents/skills/ghost 不存在" in result.stderr
    assert "$ git rm -f .claude/skills/ghost" in result.stderr


def test_renaming_a_skill_reports_both_the_stale_link_and_the_unlinked_new_name(
    repo: Path,
) -> None:
    broken_skill_was_renamed(repo)

    result = check(repo)

    assert result.returncode == 1
    assert ".agents/skills/old 不存在" in result.stderr
    assert ".claude/skills/new 没有指向 .agents/skills/new 的软链接" in result.stderr


def test_a_plain_file_in_claude_skills_is_not_treated_as_a_skill(repo: Path) -> None:
    broken_plain_file(repo)

    result = check(repo)

    assert result.returncode == 1
    assert "只能放指向 .agents/skills/<名称> 的软链接" in result.stderr
    assert "git mv" not in result.stderr
    assert "SKILL.md" not in result.stderr


def test_skill_problems_are_summed_up_apart_from_reference_problems(repo: Path) -> None:
    add_skill(repo, "delta", link=False)

    result = check(repo)

    assert result.returncode == 1
    assert "1 处 skill 目录布局不符" in result.stderr
    assert "AGENTS.md「Agent skills」" in result.stderr
    assert "文档引用有问题" not in result.stderr
    assert "doc-references.allow" not in result.stderr
    assert "CODING_STANDARDS.md" not in result.stderr


def test_the_summary_for_a_mix_names_each_kind_and_only_offers_the_allow_list_for_references(
    repo: Path,
) -> None:
    add_skill(repo, "delta", link=False)
    put(repo, {"README.md": "见 `apps/server/src/engine/nope.ts`\n"})

    result = check(repo)

    assert result.returncode == 1
    assert "共 1 处文档引用有问题" in result.stderr
    assert "1 处 skill 目录布局不符" in result.stderr
    assert "README.md | apps/server/src/engine/nope.ts | <原因>" in result.stderr
    assert ".agents/skills/delta | " not in result.stderr


def test_a_path_that_goes_through_a_symlinked_directory_exists(repo: Path) -> None:
    add_skill(repo, "alpha")
    put(repo, {"README.md": "见 `.claude/skills/alpha/SKILL.md` 和 `.claude/skills/alpha/`。\n"})
    assert check(repo).returncode == 0

    put(repo, {"README.md": "见 `.claude/skills/alpha/missing.md`。\n"})
    result = check(repo)

    assert result.returncode == 1
    assert ".claude/skills/alpha/missing.md" in result.stderr


def test_a_fence_indented_four_spaces_or_more_inside_a_list_hides_its_content(repo: Path) -> None:
    put(
        repo,
        {
            "docs/guide/page.md": (
                "# 页面\n\n- 步骤\n\n        ```sh\n"
                "        见 [x](gone.md) 和 `apps/server/gone.ts`\n        ```\n"
            )
        },
    )

    result = check(repo)

    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "text",
    [
        "// 见 ADR 0021 的 §3",
        "// 见 `ADR 0021` §3",
        "// 见 docs/adr/0005-x.md §2",
        "// 见 docs/adr/0005-x.md 的 §2",
    ],
)
def test_other_ways_of_pointing_at_an_adr_section_are_not_ours(repo: Path, text: str) -> None:
    put(repo, {"apps/server/src/engine/ids.ts": text + "\n"})

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
