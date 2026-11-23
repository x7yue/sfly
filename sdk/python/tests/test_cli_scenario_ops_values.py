"""`sfly scenario edit` 的值：按 JSON 解析，节点类型声明是字符串时按原样（#470 审查）。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import pytest

from sfly.cli.client import ApiError, Client
from sfly.cli.scenario_ops import (
    _accepts,
    _compare_versions,
    _needs_types,
    _newest_version,
    _node_inputs,
    _value,
)

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
    """一台 Agent：加载着开发包 devkit，上报的元信息是 `metadata`。"""
    return {
        "name": name,
        "status": status,
        "dev_packages": [{"name": "devkit", "metadata": metadata}],
    }


def _dev_nodes(inputs: Any) -> dict[str, Any]:
    return {
        "nodes": [
            {
                "name": "t",
                "inputs": {"type": "object", "properties": inputs},
                "outputs": {"type": "object", "properties": {}},
            }
        ]
    }


INTEGER_TAG = {"tag": INTEGER}
DEFAULT_A = {"default_agent": "a"}


def test_unpublished_package_reads_the_dev_version_from_online_agents() -> None:
    """只有开发版本的包（`GET /packages/<名>` 是 404）、场景还没锁定：和控制面一样取在线 Agent
    上报的开发版本。"""
    client = _FakeClient(
        {
            "/packages/devkit": NOT_FOUND,
            "/agents": {"agents": [_agent("b", _dev_nodes(TAG)), _agent("a", None, "offline")]},
        }
    )
    schemas = _node_inputs(cast(Client, client), {"default_agent": "b"}, "devkit", "t", None)
    assert schemas == TAG
    assert _value("1.10", schemas["tag"]) == "1.10"


@pytest.mark.parametrize("metadata", [None, {"nodes": None}, {"nodes": [None, 3]}, "x", {}])
def test_dev_metadata_that_is_missing_or_malformed_means_no_types(metadata: Any) -> None:
    """Agent 上报的元信息是 null 或格式不对：查不到声明（值照常按 JSON 解析），不抛异常。"""
    client = _FakeClient(
        {"/packages/devkit": NOT_FOUND, "/agents": {"agents": [_agent("a", metadata)]}}
    )
    assert _node_inputs(cast(Client, client), DEFAULT_A, "devkit", "t", None) == {}


@pytest.mark.parametrize("properties", ["x", [1], {"tag": "string"}, None])
def test_dev_properties_that_are_malformed_mean_no_types(properties: Any) -> None:
    """属性一层格式不对（照控制面的 reportedNodeTypes 规则）：当作不知道，不抛异常。"""
    client = _FakeClient(
        {
            "/packages/devkit": NOT_FOUND,
            "/agents": {"agents": [_agent("a", _dev_nodes(properties))]},
        }
    )
    assert _node_inputs(cast(Client, client), DEFAULT_A, "devkit", "t", None) == {}


def _two_agents() -> _FakeClient:
    """两台在线的 Agent 都加载着 devkit：a 声明 tag 是整数，b 声明是字符串
    （名字的顺序和声明无关）。"""
    return _FakeClient(
        {
            "/packages/devkit": NOT_FOUND,
            "/agents": {
                "agents": [_agent("b", _dev_nodes(TAG)), _agent("a", _dev_nodes(INTEGER_TAG))]
            },
        }
    )


def test_dev_types_come_from_the_agent_the_node_is_dispatched_to() -> None:
    """和控制面一样按派发目标取：节点的 Agent，没写就用场景的默认 Agent。"""
    client = cast(Client, _two_agents())
    default_a = _node_inputs(client, DEFAULT_A, "devkit", "t", None)
    assert default_a == INTEGER_TAG
    assert _value("3", default_a["tag"]) == 3
    on_b = _node_inputs(client, DEFAULT_A, "devkit", "t", None, agent="b")
    assert on_b == TAG
    assert _value("3", on_b["tag"]) == "3"
    # 没有派发目标（没写 Agent，也没有默认 Agent）、目标不在线或没加载：不知道。
    assert _node_inputs(client, {}, "devkit", "t", None) == {}
    assert _node_inputs(client, DEFAULT_A, "devkit", "t", None, agent="nobody") == {}


def test_dev_types_are_unknown_when_nodes_of_the_package_go_to_agents_that_disagree() -> None:
    """场景里已经有用这个包的节点派到另一台、声明不同：和控制面一样当作不知道。"""
    document = {
        "default_agent": "a",
        "packages": {"devkit": "dev"},
        "nodes": [{"id": "x", "kind": "package", "package": "devkit", "node": "t", "agent": "b"}],
    }
    client = cast(Client, _two_agents())
    assert _node_inputs(client, document, "devkit", "t", None) == {}
    # 都派到 b：用 b 的。
    assert _node_inputs(client, document, "devkit", "t", None, agent="b") == TAG


def test_other_errors_reading_the_package_still_fall_back_to_no_types() -> None:
    client = _FakeClient({"/packages/devkit": ApiError(500, "internal", "出错了")})
    assert _node_inputs(cast(Client, client), DEFAULT_A, "devkit", "t", None) == {}
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


VERSION_CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "testdata" / "version-order-cases.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize(("older", "newer"), VERSION_CASES["older_newer"])
def test_version_order_follows_the_shared_table(older: str, newer: str) -> None:
    """共用用例表 testdata/version-order-cases.json：和控制面、画布的 compareVersions 一个口径。"""
    assert _compare_versions(older, newer) < 0
    assert _compare_versions(newer, older) > 0


@pytest.mark.parametrize(("a", "b"), VERSION_CASES["equal"])
def test_equal_versions_follow_the_shared_table(a: str, b: str) -> None:
    assert _compare_versions(a, b) == 0


@pytest.mark.parametrize("case", VERSION_CASES["newest"])
def test_newest_version_follows_the_shared_table(case: dict[str, Any]) -> None:
    assert _newest_version(case["versions"]) == case["newest"]
