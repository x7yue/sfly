"""`sfly api --describe` 的文本：字段大纲、资源和读写的说明；打包的清单里每个接口都说得出来。"""

from __future__ import annotations

from typing import Any

import pytest

from sfly.cli.route_describe import (
    MAX_DEPTH,
    MAX_NOTE,
    call_example,
    describe_route,
    effect_brief,
    effect_text,
    target_text,
)
from sfly.cli.routes import Route, load_routes, routes_from_manifest

KINDS = {"scenario": "场景", "run": "运行", "system": "系统"}


def route(**fields: Any) -> Route:
    entry: dict[str, Any] = {
        "method": "GET",
        "path": "/things/:id",
        "key": ["things", "get"],
        "kind": "endpoint",
        "summary": "读一个东西",
        "effect": "read",
        "resource": {"kind": "scenario", "target": {"params": "id"}},
        "params": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
        "notes": [],
    }
    entry.update(fields)
    return routes_from_manifest({"resource_kinds": KINDS, "routes": [entry]})[0]


def test_header_says_what_it_does_whether_it_writes_and_what_it_acts_on() -> None:
    text = describe_route(route())
    assert text.splitlines()[:6] == [
        "GET /things/:id",
        "说明：读一个东西",
        "种类：普通",
        "效果：只读",
        "资源：场景，用路径参数 id 定位到具体的那一个",
        "调用：sfly api GET /things/<id>",
    ]
    assert "路径参数（* 必填）\n  id*: string" in text


def test_creating_and_removing_are_spelled_out() -> None:
    creating = route(
        method="POST",
        path="/things/:id/runs",
        effect="write",
        creates="run",
    )
    text = describe_route(creating)
    assert "效果：有副作用" in text
    assert "新建：运行（定位到的场景只被读，写落在新建出来的运行上）" in text
    assert "删除或归档" not in text
    assert effect_brief(creating) == "有副作用（新建运行）"
    assert creating.to_json()["creates"] == "run"
    assert "removes" not in creating.to_json()

    removing = route(method="POST", path="/things/:id/archive", effect="write", removes=True)
    text = describe_route(removing)
    assert "删除或归档：是（让定位到的场景或它的一部分不再可用）" in text
    assert "新建：" not in text
    assert effect_brief(removing) == "有副作用（删除或归档）"
    assert removing.to_json()["removes"] is True
    assert "creates" not in removing.to_json()

    # 同类新建（复制）和没有这两项的写、只读
    copy = route(method="POST", effect="write", creates="scenario")
    assert "新建：场景（定位到的场景只被读，写落在新建出来的场景上）" in describe_route(copy)
    assert effect_brief(route(effect="write")) == "有副作用"
    assert effect_brief(route()) == "只读"


def test_effect_and_target_texts() -> None:
    assert effect_text("read") == "只读"
    assert effect_text("write") == "有副作用"
    assert (
        target_text({"kind": "run", "target": {"query": "run"}})
        == "用查询参数 run 定位到具体的那一个"
    )
    assert (
        target_text({"kind": "run", "target": {"body": "run"}})
        == "用请求体字段 run 定位到具体的那一个"
    )
    assert "没有具体的那一个" in target_text({"kind": "run", "target": "collection"})
    assert "上传的内容里" in target_text({"kind": "package", "target": "upload"})
    assert "平台自身" in target_text({"kind": "system", "target": "global"})


def test_a_write_to_a_collection() -> None:
    text = describe_route(
        route(
            method="POST",
            path="/things",
            effect="write",
            resource={"kind": "scenario", "target": "collection"},
            params=None,
            body={
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["name"],
            },
            response={
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        )
    )
    assert "效果：有副作用" in text
    assert "资源：场景，列表或新建，没有具体的那一个" in text
    assert "调用：sfly api POST /things --body '{…}'" in text
    assert "请求体（JSON，* 必填）\n  name*: string\n  tags: string[]" in text
    assert "响应（JSON）\n  id*: string" in text
    assert "路径参数" not in text


def test_response_fields_are_outlined_with_required_marks_and_nesting() -> None:
    schema = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "format": "uuid"},
            "status": {"enum": ["running", "done"]},
            "owner": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {"name": {"type": "string"}},
                        "required": ["name"],
                    },
                    {"type": "null"},
                ]
            },
            "rows": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"n": {"type": "integer"}},
                    "required": ["n"],
                },
            },
            "labels": {"type": "object", "additionalProperties": {"type": "string"}},
            "note": {"type": "string", "description": "写给人看的一句话"},
        },
        "required": ["id", "status", "owner", "rows"],
    }
    text = describe_route(route(response=schema))
    assert text.split("响应（JSON）\n")[1].splitlines() == [
        "  id*: string（uuid）",
        '  status*: "running" | "done"',
        "  owner*: object | null",
        "    name*: string",
        "  rows*: object[]",
        "    n*: integer",
        "  labels: object（名称 → string）",
        "  note: string — 写给人看的一句话",
    ]


def test_alternatives_are_labelled_by_the_field_that_tells_them_apart() -> None:
    def option(kind: str, extra: str) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"kind": {"const": kind}, extra: {"type": "string"}},
            "required": ["kind"],
        }

    schema = {
        "type": "object",
        "properties": {"node": {"oneOf": [option("a", "x"), option("b", "y")]}},
        "required": ["node"],
    }
    text = describe_route(route(response=schema))
    assert text.split("响应（JSON）\n")[1].splitlines() == [
        "  node*: object",
        '    选项 1（kind = "a"）：',
        '      kind*: "a"',
        "      x: string",
        '    选项 2（kind = "b"）：',
        '      kind*: "b"',
        "      y: string",
    ]


def test_recursive_schemas_stop_at_the_reference() -> None:
    schema = {
        "$ref": "#/$defs/tree",
        "$defs": {
            "tree": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "children": {"type": "array", "items": {"$ref": "#/$defs/tree"}},
                },
                "required": ["name"],
            }
        },
    }
    text = describe_route(route(response=schema))
    assert text.split("响应（JSON）\n")[1].splitlines() == [
        "  name*: string",
        "  children: （递归，同上）[]",
    ]


def test_fields_deeper_than_the_limit_are_left_out_and_say_so() -> None:
    leaf: dict[str, Any] = {"type": "object", "properties": {"deep": {"type": "string"}}}
    schema: dict[str, Any] = leaf
    for level in reversed(range(MAX_DEPTH)):
        schema = {"type": "object", "properties": {f"level{level + 1}": schema}}
    text = describe_route(route(response=schema))
    assert f"level{MAX_DEPTH}: object" in text
    assert "deep" not in text
    assert f"字段只列到第 {MAX_DEPTH} 层" in text
    assert "字段只列到" not in describe_route(
        route(response={"type": "object", "properties": {"a": {"type": "string"}}})
    )


def test_field_descriptions_are_shown_after_the_type_on_one_line() -> None:
    schema = {
        "type": "object",
        "properties": {
            "keep": {"const": True, "description": "写 true 表示沿用原来的值。"},
            "wrapped": {
                "type": "string",
                "description": (
                    "分成两行写的\n  中文说明，接起来不留空格；English words\n  keep a space."
                ),
            },
            "long": {"type": "string", "description": "长" * (MAX_NOTE + 50)},
            "bare": {"type": "string"},
        },
        "required": ["keep"],
    }
    text = describe_route(route(method="POST", effect="write", params=None, body=schema))
    lines = text.split("请求体（JSON，* 必填）\n")[1].splitlines()
    assert lines[0] == "  keep*: true — 写 true 表示沿用原来的值。"
    assert (
        lines[1]
        == "  wrapped: string — 分成两行写的中文说明，接起来不留空格；English words keep a space."
    )
    assert lines[2] == f"  long: string — {'长' * (MAX_NOTE - 1)}…"
    assert lines[3] == "  bare: string"


def test_responses_without_a_body_downloads_streams_and_uploads() -> None:
    assert "响应：没有响应体（204）" in describe_route(route(method="DELETE", effect="write"))

    download = describe_route(
        route(path="/files", kind="download", params=None, content_type="text/plain")
    )
    assert "种类：下载" in download
    assert "响应：文件内容（content-type：text/plain）" in download

    stream = describe_route(
        route(
            path="/things/:id/events",
            kind="stream",
            events={
                "tick": {
                    "type": "object",
                    "properties": {"n": {"type": "integer"}},
                    "required": ["n"],
                }
            },
        )
    )
    assert "事件流（SSE）" in stream
    assert "time 事件" in stream
    assert "事件 tick\n  n*: integer" in stream

    upload = describe_route(
        route(method="POST", path="/things", kind="upload", effect="write", params=None)
    )
    assert "请求体：原始字节" in upload
    assert "sfly api 不能直接调用" in upload
    assert "调用：" not in upload


def test_constraints_the_json_schema_cannot_express_are_listed() -> None:
    text = describe_route(
        route(
            notes=[
                {"part": "body", "path": "a.b", "reason": "自定义校验"},
                {"part": "query", "path": "", "reason": "转换"},
            ]
        )
    )
    assert "只由控制面校验的约束：\n  body a.b：自定义校验\n  query：转换" in text


def test_call_example_lists_what_must_be_given() -> None:
    assert call_example(route(path="/a/:x/b/:y")) == "sfly api GET /a/<x>/b/<y>"
    assert call_example(route(path="/files/*")) == "sfly api GET /files/<剩余路径>"
    required = route(
        method="POST",
        query={"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]},
        body={"type": "object", "properties": {"a": {}}, "required": ["a"]},
    )
    assert call_example(required) == "sfly api POST /things/<id> --query n=<值> --body '{…}'"


@pytest.mark.parametrize("entry", load_routes(), ids=lambda r: f"{r.method} {r.path}")
def test_every_route_in_the_shipped_manifest_can_be_described(entry: Route) -> None:
    text = describe_route(entry)
    assert text.startswith(f"{entry.method} {entry.path}\n说明：{entry.summary}\n")
    assert f"效果：{effect_text(entry.effect)}" in text
    assert entry.resource_label != entry.resource["kind"], "资源类别没有中文名"
    assert f"资源：{entry.resource_label}，" in text
    if entry.kind in ("endpoint", "upload"):
        assert ("响应（JSON）" in text) != ("没有响应体" in text)
    if entry.kind == "stream":
        assert all(f"事件 {name}" in text for name in entry.events or {})
