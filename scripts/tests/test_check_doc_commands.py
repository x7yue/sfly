"""文档里的 pnpm 命令（scripts/doc_commands.py，#801）：该拦的、不该拦的，放行。
用的是 test_check_doc_references.py 的临时仓库。"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "test_check_doc_references", Path(__file__).with_name("test_check_doc_references.py")
)
assert _spec is not None and _spec.loader is not None
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)
check, put = base.check, base.put


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root: Path = base.make_repo(tmp_path)
    return root


ROOT_PACKAGE = '{"name": "sfly", "scripts": {"lint": "x", "lint:docs": "x", "test:e2e": "x"}}\n'
WEB_PACKAGE = '{"name": "@sfly/web", "scripts": {"dev": "vite", "build": "vite build"}}\n'


def test_pnpm_commands_that_exist_pass(repo: Path) -> None:
    put(
        repo,
        {
            "package.json": ROOT_PACKAGE,
            "apps/web/package.json": WEB_PACKAGE,
            "README.md": (
                "跑 `pnpm lint:docs`，或者 `pnpm -s lint`、`pnpm run test:e2e`。\n"
                "pnpm 10 以上；用 pnpm 安装；`pnpm install`、`pnpm exec vitest`、`pnpm dlx x`。\n"
                "```sh\npnpm --filter @sfly/web dev\npnpm --filter=@sfly/web build\n```\n"
            ),
            "apps/web/README.md": "在这个目录里 `pnpm dev`。\n",
        },
    )

    result = check(repo)

    assert result.returncode == 0, result.stderr


def test_a_renamed_script_left_in_the_docs_fails_with_the_place_and_the_fix(repo: Path) -> None:
    put(
        repo,
        {
            "package.json": ROOT_PACKAGE,
            "README.md": "# sfly\n\n改完跑 `pnpm lint:doc`。\n",
        },
    )

    result = check(repo)

    assert result.returncode == 1
    assert "README.md:3: `pnpm lint:doc`：lint:doc 不是 pnpm 的命令" in result.stderr
    assert "是不是 pnpm lint:docs？" in result.stderr
    assert "scripts/doc-references.allow" in result.stderr


def test_package_scripts_count_only_in_that_package_or_with_filter(repo: Path) -> None:
    put(
        repo,
        {
            "package.json": ROOT_PACKAGE,
            "apps/web/package.json": WEB_PACKAGE,
            "README.md": "根目录没有 `pnpm dev`。\n",
            "docs/guide/web.md": "```sh\npnpm --filter @sfly/web lint:docs\n```\n",
        },
    )

    result = check(repo)

    assert result.returncode == 1
    assert "README.md:1: `pnpm dev`" in result.stderr
    assert "docs/guide/web.md:2: `pnpm --filter @sfly/web lint:docs`" in result.stderr
    assert "@sfly/web 的 package.json" in result.stderr


def test_a_pnpm_command_can_be_allowed_with_a_reason(repo: Path) -> None:
    put(
        repo,
        {
            "package.json": ROOT_PACKAGE,
            "README.md": "用户项目里的 `pnpm storybook`。\n",
            "scripts/doc-references.allow": "README.md | pnpm storybook | 用户项目里的命令\n",
        },
    )

    assert check(repo).returncode == 0, check(repo).stderr
