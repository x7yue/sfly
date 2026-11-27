"""SDK 和命令行里手抄的常量和控制面、Agent 的一致（#434）：一边改了另一边没改时这里失败。"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

from sfly import context, runner
from sfly.capabilities.errors import Kind
from sfly.cli import run_logs, run_query, run_view, scan

REPO = Path(__file__).resolve().parents[3]


def _source(path: str) -> str:
    return (REPO / path).read_text(encoding="utf-8")


def _constant(path: str, pattern: str) -> int:
    """读 `pattern`（含一个分组）匹配到的常量；值可以写成 `1024 * 1024`、`1_000` 这样的乘积。"""
    found = re.search(pattern, _source(path), re.MULTILINE)
    assert found, f"没有从 {path} 里读到 {pattern}"
    return math.prod(int(part.replace("_", "")) for part in found[1].split("*"))


def _ts(path: str, name: str) -> int:
    return _constant(path, rf"^export const {name} = ([\d_ *]+);")


def _query_maximum(path: str, field: str = "limit") -> int:
    routes = json.loads(_source("sdk/python/src/sfly/schemas/routes.json"))["routes"]
    route = next(r for r in routes if r["method"] == "GET" and r["path"] == path)
    maximum: int = route["query"]["properties"][field]["maximum"]
    return maximum


def test_output_limit_is_the_same_in_the_runner_the_agent_and_the_control_plane() -> None:
    server = _ts("apps/server/src/engine/output-limit.ts", "MAX_OUTPUT_BYTES")
    assert runner.MAX_OUTPUT_BYTES == server
    rust = _constant("agent/src/executor.rs", r"^pub const MAX_OUTPUT_BYTES: usize = ([\d_ *]+);")
    assert runner.MAX_OUTPUT_BYTES == rust


def test_metric_limits_are_the_ones_in_packages_schema() -> None:
    series = "packages/schema/src/series.ts"
    assert context.MAX_SERIES == _ts(series, "MAX_SERIES")
    assert context.MAX_LABEL_VALUE_CHARS == _ts(series, "MAX_LABEL_VALUE_CHARS")
    metadata = "packages/schema/src/package-metadata.ts"
    assert scan.MAX_LABEL_KEYS == _ts(metadata, "MAX_LABEL_KEYS")


def test_page_limits_are_the_ones_the_control_plane_accepts() -> None:
    assert run_query._MAX_RUNS == _query_maximum("/runs")
    assert run_view._RUN_LOOKUP_LIMIT == _query_maximum("/runs")
    for path in ("/tasks/:id/logs", "/runs/:id/logs"):
        assert run_logs._MAX_PAGE_LINES == _query_maximum(path), path


def test_builtin_node_types_are_named_the_way_the_console_names_them() -> None:
    source = _source("packages/orchestration/src/node-display.ts")
    block = re.search(r"NODE_KIND_LABEL[^{]*\{(.*?)\n\};", source, re.DOTALL)
    assert block, "没有从 node-display.ts 里读到 NODE_KIND_LABEL"
    console = dict(re.findall(r'(\w+): "([^"]+)"', block[1]))
    # 包节点在命令行里写 `包名/节点名`，不用种类名。
    del console["package"]
    assert run_view._BUILTIN_TYPES == console


def test_call_error_kinds_are_the_ones_the_agent_replies_with() -> None:
    source = _source("agent/src/calls/mod.rs")
    block = re.search(r"pub enum ErrorKind \{(.*?)\n\}", source, re.DOTALL)
    assert block, "没有从 agent/src/calls/mod.rs 里读到 ErrorKind"
    variants = re.findall(r"^    (\w+),$", block[1], re.MULTILINE)
    rust = {re.sub(r"(?<!^)([A-Z])", r"_\1", v).lower() for v in variants}
    sdk = {value for name, value in vars(Kind).items() if name.isupper()}
    assert rust == sdk
