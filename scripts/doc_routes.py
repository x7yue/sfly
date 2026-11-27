"""文档里手写的 HTTP 接口（「方法 + 路径」）要真的有（#802，`check_doc_references.py` 的第 5 类）。

查 `README.md`、`docs/ARCHITECTURE.md`、`docs/guide/`、`apps/*/README.md`、`evals/**/README.md`
的正文和代码块；不查 `docs/adr`、`docs/research`、`docs/perf`（历史记录）。
对照两份清单，都从代码里取，不手抄：

- 控制面的契约：`sdk/python/src/sfly/schemas/routes.json`（由契约生成，`pnpm gen:check` 守着它
  和契约一致；控制面注册的每条路由都要经契约，SSE 和下载也在里面）；
- 助手服务的路由：`packages/schema/src/assistant-protocol.ts` 的 `ASSISTANT_ROUTES`。

按段比：`:参数`、`<占位>`（里面可以有空格）、`{参数}` 都当通配；`…` 当「后面还有几段」；
查询参数（`?` 之后）不比；`HEAD` 按 `GET` 比。
"""

from __future__ import annotations

import difflib
import json
import re
from collections.abc import Callable, Iterable

CONTRACT = "sdk/python/src/sfly/schemas/routes.json"
ASSISTANT = "packages/schema/src/assistant-protocol.ts"
DOCS = re.compile(
    r"^(?:README\.md|docs/ARCHITECTURE\.md|docs/guide/.+|apps/[^/]+/README\.md|evals/(?:.+/)?README\.md)$"
)
METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD"
# 路径：`/` 开头，到空白、反引号、引号、中文标点为止；`<…>` 占位里可以有空格。
ROUTE = re.compile(rf"(?<![\w-])({METHODS}) (/(?:<[^>\n]*>|[^\s`'\"<>()（）,，。、；;|])*)")
ASSISTANT_LIST = re.compile(r"export const ASSISTANT_ROUTES = \[(.*?)\]", re.DOTALL)


def is_checked(path: str) -> bool:
    return bool(DOCS.match(path)) and path.endswith(".md")


def load_routes(read: Callable[[str], str]) -> list[str]:
    """两份清单里的全部路由，写成 `方法 路径`。"""
    routes = [f"{r['method']} {r['path']}" for r in json.loads(read(CONTRACT))["routes"]]
    listed = ASSISTANT_LIST.search(read(ASSISTANT))
    if listed is None:
        raise ValueError(
            f"{ASSISTANT} 里没有 ASSISTANT_ROUTES：改了写法要同步 scripts/doc_routes.py"
        )
    return routes + re.findall(r'"([A-Z]+ /[^"]*)"', listed.group(1))


def segments(path: str) -> list[str]:
    return path.split("?", 1)[0].strip("/").split("/")


def is_wildcard(segment: str) -> bool:
    return segment.startswith((":", "<", "{")) or segment == "*"


def matches(written: str, route: str) -> bool:
    method, path = written.split(" ", 1)
    route_method, route_path = route.split(" ", 1)
    if method != route_method and not (method == "HEAD" and route_method == "GET"):
        return False
    have, want = segments(path), segments(route_path)
    if have and have[-1] in ("…", "..."):
        have = have[:-1]
        want = want[: len(have)]
    if len(have) != len(want):
        return False
    return all(a == b or is_wildcard(a) or is_wildcard(b) for a, b in zip(have, want, strict=True))


def check_line(routes: list[str], line: str) -> Iterable[tuple[str, str, list[str]]]:
    """这一行里对不上的接口：（原文，说明，猜的写法）。"""
    for match in ROUTE.finditer(line):
        written = f"{match.group(1)} {match.group(2)}"
        if any(matches(written, route) for route in routes):
            continue
        method, path = written.split("?", 1)[0].split(" ", 1)
        # 搬到项目下的（#488）最常见：先看加上 `/projects/:project` 有没有。
        moved = [r for r in routes if matches(f"{method} /projects/:project{path}", r)]
        close = difflib.get_close_matches(f"{method} {path}", routes, 3, 0.6)
        hints = [f"是不是 {g}？" for g in dict.fromkeys(moved + close)][:3]
        yield (
            written,
            f"`{written}` 不在控制面的契约里，也不是助手服务的路由（{CONTRACT}、{ASSISTANT}）",
            hints,
        )
