"""控制面的路由清单：`sfly.schemas/routes.json`，由 packages/schema 的 HTTP 契约导出（`pnpm gen`）。

`sfly api` 用它列出接口、把用户给的路径对应到路由模板、并在发请求前校验；
测试用同一份清单检查命令行用到的每个路径都对得上控制面的路由（`tests/test_cli_routes.py`）。

路径模板是 Fastify 风格：`:name` 匹配一段，末尾的 `*` 匹配剩余路径，
`:page.md` 是「一段，后面接字面量 .md」。
"""

from __future__ import annotations

import difflib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from importlib import resources
from typing import Any
from urllib.parse import unquote

# 种类的显示名。
KIND_LABELS = {"endpoint": "普通", "stream": "SSE", "download": "下载", "upload": "上传"}

_PARAM = re.compile(r":([A-Za-z_][A-Za-z0-9_]*)|\*$")
_STAR = "*"


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    key: tuple[str, ...] | None
    kind: str
    content_type: str | None
    params: dict[str, Any] | None
    query: dict[str, Any] | None
    body: dict[str, Any] | None
    notes: tuple[dict[str, str], ...]
    pattern: re.Pattern[str] = field(repr=False, compare=False)
    # 路径参数名，按出现顺序（末尾的 `*` 记作 `*`）。
    param_names: tuple[str, ...] = field(repr=False, compare=False)

    @classmethod
    def from_json(cls, entry: Mapping[str, Any]) -> Route:
        pattern, names = compile_template(entry["path"])
        key = entry.get("key")
        return cls(
            method=entry["method"],
            path=entry["path"],
            key=tuple(key) if key else None,
            kind=entry["kind"],
            content_type=entry.get("content_type"),
            params=entry.get("params"),
            query=entry.get("query"),
            body=entry.get("body"),
            notes=tuple(entry.get("notes", ())),
            pattern=pattern,
            param_names=names,
        )

    def to_json(self) -> dict[str, Any]:
        """还原成清单里的一条（`sfly api --list --json` 的输出）。"""
        entry: dict[str, Any] = {
            "method": self.method,
            "path": self.path,
            "key": list(self.key) if self.key else None,
            "kind": self.kind,
        }
        if self.content_type:
            entry["content_type"] = self.content_type
        for name in ("params", "query", "body"):
            if (schema := getattr(self, name)) is not None:
                entry[name] = schema
        entry["notes"] = list(self.notes)
        return entry

    def match(self, path: str) -> dict[str, str] | None:
        """`path` 是这个模板的一个实例时，返回路径参数（已解码）；否则为 None。"""
        found = self.pattern.match(path)
        if not found:
            return None
        return {
            (_STAR if name == _STAR_GROUP else name): unquote(value)
            for name, value in found.groupdict().items()
        }

    @property
    def specificity(self) -> tuple[int, int]:
        """同一个路径匹配多个模板时取最具体的：没有 `*` 的优先，参数少的优先。"""
        return (_STAR in self.param_names, len(self.param_names))


_STAR_GROUP = "_star"


def compile_template(template: str) -> tuple[re.Pattern[str], tuple[str, ...]]:
    parts: list[str] = []
    names: list[str] = []
    position = 0
    for found in _PARAM.finditer(template):
        parts.append(re.escape(template[position : found.start()]))
        if found.group(1):
            names.append(found.group(1))
            parts.append(f"(?P<{found.group(1)}>[^/]+)")
        else:
            names.append(_STAR)
            parts.append(f"(?P<{_STAR_GROUP}>.+)")
        position = found.end()
    parts.append(re.escape(template[position:]))
    return re.compile("^" + "".join(parts) + "$"), tuple(names)


def load_routes() -> list[Route]:
    """读取随 SDK 打包的路由清单。"""
    text = resources.files("sfly.schemas").joinpath("routes.json").read_text(encoding="utf-8")
    return routes_from_manifest(json.loads(text))


def routes_from_manifest(manifest: Mapping[str, Any]) -> list[Route]:
    return [Route.from_json(entry) for entry in manifest["routes"]]


@dataclass(frozen=True)
class Resolution:
    """用户给的方法和路径对应到清单里的哪条路由，或者为什么对不上。"""

    route: Route | None
    params: dict[str, str]
    # 路径对得上、方法不对时：这个路径支持的方法。
    other_methods: tuple[str, ...] = ()


def resolve(routes: Sequence[Route], method: str, path: str) -> Resolution:
    matches = [(route, params) for route in routes if (params := route.match(path)) is not None]
    same_method = [(route, params) for route, params in matches if route.method == method]
    if same_method:
        route, params = min(same_method, key=lambda item: item[0].specificity)
        return Resolution(route, params)
    return Resolution(None, {}, tuple(sorted({route.method for route, _ in matches})))


def closest(routes: Sequence[Route], method: str, path: str, limit: int = 5) -> list[Route]:
    """和 `method path` 最接近的几条路由：模板里的路径参数视作和用户给的那一段相同。"""
    user_segments = path.split("/")
    scored: list[tuple[float, int, Route]] = []
    for index, route in enumerate(routes):
        template = route.path.split("/")
        aligned = [
            user_segments[i] if segment.startswith(":") and i < len(user_segments) else segment
            for i, segment in enumerate(template)
        ]
        score = difflib.SequenceMatcher(None, path, "/".join(aligned)).ratio()
        if route.method == method:
            score += 0.05
        scored.append((score, -index, route))
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [route for score, _, route in scored[:limit] if score >= _MIN_SIMILARITY]


_MIN_SIMILARITY = 0.35
