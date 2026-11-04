"""列出当前 Python 环境中安装的节点包（`python -m sfly.installed`）。只用标准库（ADR 0002）。

`sfly build` 把节点包元信息 `sfly-package.json` 同时写进 wheel 的 dist-info，
所以装进共享 venv 的节点包都能通过 `importlib.metadata` 找到。
Agent 在共享 venv 中运行本模块，用结果生成 Hello 里的已安装包列表，并查找节点入口。

输出（标准输出，一行 JSON）：
`{"packages": [<sfly-package.json 内容>, ...], "requires": {<包名>: [<Requires-Dist>, ...]}}`，
packages 按包名排序；requires 是每个节点包 wheel 声明的依赖，Agent 安装其他节点包时
把它们一起交给 uv 解析，以发现依赖冲突。
"""

from __future__ import annotations

import json
import sys
from importlib import metadata
from typing import Any

METADATA_FILE = "sfly-package.json"


def _node_distributions() -> dict[str, tuple[dict[str, Any], list[str]]]:
    found: dict[str, tuple[dict[str, Any], list[str]]] = {}
    for dist in metadata.distributions():
        text = dist.read_text(METADATA_FILE)
        if text is None:
            continue
        package: dict[str, Any] = json.loads(text)
        # sys.path 上同名的发行包只有第一个生效。
        found.setdefault(str(package["name"]), (package, list(dist.requires or [])))
    return found


def installed_packages() -> list[dict[str, Any]]:
    found = _node_distributions()
    return [found[name][0] for name in sorted(found)]


def main() -> int:
    found = _node_distributions()
    result = {
        "packages": [found[name][0] for name in sorted(found)],
        "requires": {name: found[name][1] for name in sorted(found)},
    }
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
