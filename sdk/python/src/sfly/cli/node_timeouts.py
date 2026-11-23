"""节点生效的超时和它从哪来（`sfly scenario show`，#476）。

生效的顺序：场景里这个节点写的 → 节点类型声明的（`@node(timeout=…)`）→ 平台默认的 1 小时
（docs/SEMANTICS.md §3.3）。和控制面派发时的取法一致（packages/orchestration/src/node-config.ts 的
`effectiveTimeout`）：节点类型声明的超时不是 1 到 `MAX_TIMEOUT_SECONDS` 之间的整数时当作没声明
（开发版本的元信息是 Agent 上报的，没经过发布校验）。
"""

from __future__ import annotations

from typing import Any

from sfly.cli.client import ApiError, Client, segment
from sfly.cli.value_text import value_text

#: 平台默认的超时（秒）。
PLATFORM_TIMEOUT_SECONDS = 3600
#: 节点类型声明的超时的上限（秒）：派发给 Agent 时是 32 位无符号整数。
MAX_TIMEOUT_SECONDS = 4_294_967_295

SOURCE_LABELS = {"node": "节点上设置", "type": "节点类型声明", "platform": "平台默认"}
UNKNOWN_TEXT = "未知（找不到节点类型）"

#: 找不到节点类型：不知道它有没有声明超时。
UNKNOWN = "unknown"


def _is_timeout(value: Any) -> bool:
    """是不是合格的超时：1 到 `MAX_TIMEOUT_SECONDS` 之间的整数（布尔值不算）；和控制面的
    `isNodeTimeout` 一致。"""
    return (
        isinstance(value, int) and not isinstance(value, bool) and 0 < value <= MAX_TIMEOUT_SECONDS
    )


#: 场景里这个节点没写超时（文档里没有 `timeout` 这个键）：和写了 `null` 不是一回事。
ABSENT: Any = object()


def node_timeout_problem(label: str, written: Any) -> str | None:
    """场景里这个节点写的超时不合格时的说明（和控制面派发、保存、预检的 `nodeTimeoutProblem`
    同一句话），没写（`ABSENT`）或合格时是 None；写了 `null` 和别的不合格的值一样报出来
    （保存时 `null` 同样被拒绝，#576）。`label` 是节点（`显示名称（节点 ID）`、节点 ID）。"""
    if written is ABSENT or _is_timeout(written):
        return None
    return (
        f"节点 {label}：timeout 必须是 1 到 {MAX_TIMEOUT_SECONDS} 之间的正整数（秒），"
        f"实际是 {value_text(written)}"
    )


def effective_timeout(node: dict[str, Any], declared: Any) -> dict[str, Any]:
    """`{"seconds": 秒, "source": "node" | "type" | "platform" | "unknown"}`，规则和控制面派发时
    的取法（packages/orchestration/src/node-config.ts 的 `effectiveTimeout`）一致，两端共用
    一张用例表。

    `declared` 是节点类型声明的超时（没声明是 None）；找不到节点类型时是 `UNKNOWN`：这时
    场景里没写超时的节点说不出生效的值（`seconds` 是 None），不猜它是平台默认（Python 独有，
    表里不比较）。
    不合格的值（不是 1 到上限之间的整数）当作没写，哪一种来源都一样。
    """
    written = node.get("timeout")
    if _is_timeout(written):
        return {"seconds": written, "source": "node"}
    if declared == UNKNOWN:
        return {"seconds": None, "source": "unknown"}
    if _is_timeout(declared):
        return {"seconds": declared, "source": "type"}
    return {"seconds": PLATFORM_TIMEOUT_SECONDS, "source": "platform"}


def timeout_view(node: dict[str, Any], label: str, declared: Any) -> dict[str, Any]:
    """`sfly scenario show` 里包节点的 `timeout`：生效的值和来源；场景里写的值派发时会被拒绝
    （升级前保存的版本里可能有）时，`source` 是 `invalid`，带着说明（`problem`）。"""
    problem = node_timeout_problem(label, node.get("timeout", ABSENT))
    if problem is not None:
        return {"seconds": None, "source": "invalid", "problem": problem}
    return effective_timeout(node, declared)


def timeout_text(timeout: dict[str, Any]) -> str:
    """表格里的写法：`43200（节点类型声明，秒）`；找不到节点类型时是 `未知（找不到节点类型）`；
    场景里写的值派发时会被拒绝时写明原因。"""
    if timeout["source"] == "invalid":
        return f"无效：{timeout['problem']}（派发时这个任务会以配置错误失败）"
    seconds = timeout["seconds"]
    if seconds is None:
        return UNKNOWN_TEXT
    return f"{seconds}（{SOURCE_LABELS[timeout['source']]}，秒）"


def declared_timeouts(client: Client, document: dict[str, Any]) -> dict[str, int | None | str]:
    """文档里每个包节点（节点 ID）的节点类型声明的超时：没声明的是 None，找不到节点类型的是
    `UNKNOWN`。

    已发布的版本读 `GET /packages/<包>/versions/<版本>`；开发版本取节点所在的 Agent（节点上选的，
    没选是场景的默认 Agent）上报的元信息（`GET /agents` 的 `dev_packages`）。
    """
    locked: dict[str, str] = document.get("packages", {})
    default_agent = document.get("default_agent")
    published: dict[tuple[str, str], list[dict[str, Any]] | None] = {}
    agents: list[dict[str, Any]] | None = None

    def published_nodes(name: str, version: str) -> list[dict[str, Any]] | None:
        if (name, version) not in published:
            try:
                detail = client.get(f"/packages/{segment(name)}/versions/{segment(version)}")
                published[(name, version)] = detail["metadata"]["nodes"]
            except (ApiError, KeyError, TypeError):
                published[(name, version)] = None
        return published[(name, version)]

    def dev_nodes(name: str, agent: str | None) -> list[dict[str, Any]] | None:
        nonlocal agents
        if agents is None:
            try:
                agents = client.get("/agents")["agents"]
            except (ApiError, KeyError, TypeError):
                agents = []
        for a in agents:
            if a.get("name") != agent:
                continue
            for dev in a.get("dev_packages", []):
                nodes = dev.get("metadata", {}).get("nodes") if dev.get("name") == name else None
                if isinstance(nodes, list):
                    return nodes
        return None

    result: dict[str, int | None | str] = {}
    for node in document.get("nodes", []):
        if node.get("kind") != "package":
            continue
        version = locked.get(node["package"])
        if version is None:
            result[node["id"]] = UNKNOWN
            continue
        nodes = (
            dev_nodes(node["package"], node.get("agent") or default_agent)
            if version == "dev"
            else published_nodes(node["package"], version)
        )
        found = next(
            (n for n in nodes or [] if isinstance(n, dict) and n.get("name") == node["node"]),
            None,
        )
        result[node["id"]] = UNKNOWN if found is None else found.get("timeout")
    return result
