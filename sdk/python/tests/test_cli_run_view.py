"""命令行里的状态用词、子流程的空名称写法和界面一致：界面改了用词，这里的测试会失败。"""

from __future__ import annotations

import re
from pathlib import Path

from sfly.cli.run_view import NODE_STATUS_LABEL, RUN_STATUS_LABEL, UNNAMED_SUBFLOW

REPO = Path(__file__).resolve().parents[3]


def _web(path: str) -> str:
    return (REPO / "apps/web/src" / path).read_text(encoding="utf-8")


def test_node_status_words_are_the_ones_the_console_shows() -> None:
    found = re.findall(r'\n\t(\w+): \{\n\t\tlabel: "([^"]+)"', _web("lib/node-status.ts"))
    assert found, "没有从 lib/node-status.ts 里读到节点状态的中文标签"
    assert NODE_STATUS_LABEL == dict(found)


def test_run_status_words_are_the_ones_the_console_shows() -> None:
    block = re.search(r"RUN_STATUS_LABEL[^{]*\{(.*?)\n\};", _web("lib/copy.ts"), re.DOTALL)
    assert block, "没有从 lib/copy.ts 里读到 RUN_STATUS_LABEL"
    assert RUN_STATUS_LABEL == dict(re.findall(r'(\w+): "([^"]+)"', block[1]))


def test_unnamed_subflow_is_written_the_way_the_console_writes_it() -> None:
    source = (REPO / "packages/orchestration/src/chain-label.ts").read_text(encoding="utf-8")
    found = re.search(r'UNNAMED_SUBFLOW_LABEL = "([^"]+)"', source)
    assert found
    assert UNNAMED_SUBFLOW == found[1]
