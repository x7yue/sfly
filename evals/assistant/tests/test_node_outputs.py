"""评测集里读运行详情里节点输出的 `node_outputs`：输出被运行视图省略（单个超过 16 KiB 或整份视图
合计用完，#633）时不能悄悄返回 None，要明确报错，说明怎么取全文。"""

from __future__ import annotations

from typing import Any

import pytest
from aeval.tasks import node_outputs


def _run(node: dict[str, Any]) -> dict[str, Any]:
    return {"chains": [{"nodes": [{"node_id": "a", "status": "success", **node}]}]}


def test_inline_outputs_are_returned() -> None:
    run = _run({"outputs": {"ok": True}, "outputs_omitted_bytes": None})

    assert node_outputs(run, "a") == {"ok": True}


def test_a_node_without_outputs_or_not_found_is_none() -> None:
    assert node_outputs(_run({"outputs": None, "outputs_omitted_bytes": None}), "a") is None
    assert node_outputs(_run({"outputs": {"ok": 1}}), "missing") is None


def test_omitted_outputs_are_an_error_not_a_silent_none() -> None:
    run = _run({"outputs": None, "outputs_omitted_bytes": 18432})

    with pytest.raises(RuntimeError) as caught:
        node_outputs(run, "a")

    message = str(caught.value)
    assert "a" in message
    assert "18432" in message
    assert "/tasks/" in message  # 怎么取全文
