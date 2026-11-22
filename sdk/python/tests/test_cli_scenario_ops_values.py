"""`sfly scenario edit` 的值：按 JSON 解析，节点类型声明是字符串时按原样（#470 审查）。"""

from __future__ import annotations

from typing import Any, cast

import pytest

from sfly.cli.client import ApiError, Client
from sfly.cli.scenario_ops import _accepts, _needs_types, _newest_version, _node_inputs, _value

STRING: dict[str, Any] = {"type": "string"}
INTEGER: dict[str, Any] = {"type": "integer"}
OPTIONAL_STRING: dict[str, Any] = {"anyOf": [{"type": "string"}, {"type": "null"}]}


@pytest.mark.parametrize(
    ("text", "schema", "expected"),
    [
        ("1.10", STRING, "1.10"),
        ("true", STRING, "true"),
        ("3", STRING, "3"),
        ('"3"', STRING, "3"),
        ("3", INTEGER, 3),
        ("1.10", None, 1.1),
        ("api.test", STRING, "api.test"),
        ("null", OPTIONAL_STRING, None),
        ("1.10", OPTIONAL_STRING, "1.10"),
        ("3", {"type": ["string", "integer"]}, 3),
        ('{"a": 1}', {"type": "object"}, {"a": 1}),
        ("${{ params.x }}", INTEGER, "${{ params.x }}"),
        ("5", {"enum": ["5", "6"]}, "5"),
        ("5", {}, 5),
    ],
)
def test_value_follows_the_declared_type(text: str, schema: Any, expected: Any) -> None:
    assert _value(text, schema) == expected
    assert type(_value(text, schema)) is type(expected)


def test_accepts_matches_the_control_plane_rules() -> None:
    assert _accepts({"type": "number"}, 1.5)
    assert not _accepts({"type": "integer"}, True)
    assert not _accepts({"type": "number"}, False)
    assert _accepts({"type": "array"}, [1])


def test_types_are_only_looked_up_when_a_value_is_not_a_string() -> None:
    assert not _needs_types(["api.test", '"3"', "${{ params.x }}"])
    assert _needs_types(["api.test", "1.10"])


class _FakeClient:
    """按路径回答的控制面：值是异常时抛出它。"""

    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.paths: list[str] = []

    def get(self, path: str) -> Any:
        self.paths.append(path)
        answer = self.answers[path]
        if isinstance(answer, Exception):
            raise answer
        return answer


TAG = {"tag": STRING}
NOT_FOUND = ApiError(404, "not_found", "节点包 devkit 不存在")


def _agent(name: str, metadata: Any, status: str = "online") -> dict[str, Any]:
    return {
        "name": name,
        "status": status,
        "dev_packages": [{"name": "devkit", "metadata": metadata}],
    }


def _dev_nodes(inputs: dict[str, Any]) -> dict[str, Any]:
    return {"nodes": [{"name": "t", "inputs": {"type": "object", "properties": inputs}}]}


def test_unpublished_package_reads_the_dev_version_from_online_agents() -> None:
    """只有开发版本的包（`GET /packages/<名>` 是 404）、场景还没锁定：和控制面一样取在线 Agent
    上报的开发版本。"""
    client = _FakeClient(
        {
            "/packages/devkit": NOT_FOUND,
            "/agents": {"agents": [_agent("b", _dev_nodes(TAG)), _agent("a", None, "offline")]},
        }
    )
    schemas = _node_inputs(cast(Client, client), {}, "devkit", "t", None)
    assert schemas == TAG
    assert _value("1.10", schemas["tag"]) == "1.10"


@pytest.mark.parametrize("metadata", [None, {"nodes": None}, {"nodes": [None, 3]}, "x", {}])
def test_dev_metadata_that_is_missing_or_malformed_means_no_types(metadata: Any) -> None:
    """Agent 上报的元信息是 null 或格式不对：查不到声明（值照常按 JSON 解析），不抛异常。"""
    client = _FakeClient(
        {"/packages/devkit": NOT_FOUND, "/agents": {"agents": [_agent("a", metadata)]}}
    )
    assert _node_inputs(cast(Client, client), {}, "devkit", "t", None) == {}


def test_other_errors_reading_the_package_still_fall_back_to_no_types() -> None:
    client = _FakeClient({"/packages/devkit": ApiError(500, "internal", "出错了")})
    assert _node_inputs(cast(Client, client), {}, "devkit", "t", None) == {}
    assert client.paths == ["/packages/devkit"]


def test_latest_published_version_is_by_version_number_like_the_control_plane() -> None:
    """不写版本、没锁定时取最新发布的版本：按版本号比较（和控制面一样），不是按发布时间。"""
    client = _FakeClient(
        {
            "/packages/kit": {
                "versions": [
                    {"version": "1.2.0", "published_at": "2026-11-02T00:00:00Z"},
                    {"version": "1.10.0", "published_at": "2026-11-01T00:00:00Z"},
                ]
            },
            "/packages/kit/versions/1.10.0": {"metadata": _dev_nodes(TAG)},
        }
    )
    assert _node_inputs(cast(Client, client), {}, "kit", "t", None) == TAG
    assert client.paths[-1] == "/packages/kit/versions/1.10.0"


@pytest.mark.parametrize(
    ("older", "newer"),
    [
        ("1.2.0", "1.10.0"),
        ("1.0rc1", "1.0"),
        ("1.0", "1.0.1"),
        ("1.0a1", "1.0b1"),
        ("0.9", "1"),
    ],
)
def test_newest_version_follows_the_control_plane_order(older: str, newer: str) -> None:
    assert _newest_version([older, newer]) == newer
    assert _newest_version([newer, older]) == newer
    assert _newest_version(["1.0", "1.0.0"]) in ("1.0", "1.0.0")
