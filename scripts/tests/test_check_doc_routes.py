"""文档里手写的 HTTP 接口（scripts/doc_routes.py，#802）：一条该拦的、一条不该拦的，放行。
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


CONTRACT_ROUTES = (
    '{"routes": [{"method": "GET", "path": "/runs/:id"}, '
    '{"method": "POST", "path": "/runs/:id/cancel"}, '
    '{"method": "POST", "path": "/projects/:project/packages"}]}\n'
)
ASSISTANT_PROTOCOL = (
    "export const ASSISTANT_ROUTES = [\n"
    '\t"POST /sessions/:id/prompt",\n'
    '\t"GET /health",\n'
    "] as const;\n"
)
ROUTE_FILES = {
    "sdk/python/src/sfly/schemas/routes.json": CONTRACT_ROUTES,
    "packages/schema/src/assistant-protocol.ts": ASSISTANT_PROTOCOL,
}


def test_http_routes_that_exist_pass(repo: Path) -> None:
    put(
        repo,
        {
            **ROUTE_FILES,
            "README.md": (
                "取消：`POST /runs/<运行 ID>/cancel`，读：`GET /runs/{id}`、`HEAD /runs/:id`。\n"
                "助手服务：POST /sessions/:id/prompt、`GET /health?x=1`。\n"
                "发布在 `POST /projects/<项目>/…`。\n"
            ),
            "docs/guide/api.md": "```sh\ncurl -X POST …  # POST /runs/:id/cancel\n```\n",
            # 历史记录不查。
            "docs/adr/0001-x.md": "以前是 `POST /old/path`。\n",
        },
    )

    result = check(repo)

    assert result.returncode == 0, result.stderr


def test_a_renamed_route_left_in_the_docs_fails_with_the_place(repo: Path) -> None:
    put(
        repo,
        {
            **ROUTE_FILES,
            "docs/guide/run.md": "# 运行\n\n停止用 `POST /runs/:id/stop`。\n",
            "apps/web/README.md": "发布：`POST /packages`。\n",
        },
    )

    result = check(repo)

    assert result.returncode == 1
    assert "docs/guide/run.md:3: `POST /runs/:id/stop` 不在控制面的契约里" in result.stderr
    assert "是不是 POST /runs/:id/cancel？" in result.stderr
    # 搬到项目下的旧路径：先提示带项目的写法。
    assert "apps/web/README.md:1: `POST /packages`" in result.stderr
    assert "是不是 POST /projects/:project/packages？" in result.stderr


def test_an_old_route_written_on_purpose_can_be_allowed_with_a_reason(repo: Path) -> None:
    put(
        repo,
        {
            **ROUTE_FILES,
            "README.md": "以前的写法 `POST /packages?project=public` 已经去掉。\n",
            "scripts/doc-references.allow": (
                "README.md | POST /packages?project=public | 说明以前的写法已经去掉\n"
            ),
        },
    )

    assert check(repo).returncode == 0
