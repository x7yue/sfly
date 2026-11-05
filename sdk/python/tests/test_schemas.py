"""导出的 JSON Schema 能被 Python 侧用来校验文档。"""

from __future__ import annotations

from typing import Any

import pytest
from jsonschema import Draft202012Validator

from sfly.schemas import SchemaName, load_schema


def validator(name: SchemaName) -> Draft202012Validator:
    schema = load_schema(name)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def package_metadata(**overrides: Any) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "name": "demo-checks",
        "version": "1.2.0",
        "requires_python": ">=3.10",
        "nodes": [
            {
                "name": "http_check",
                "title": "HTTP 检查",
                "entry": "demo_checks.http:http_check",
                "inputs": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "expect": {"type": "integer", "default": 200},
                    },
                    "required": ["url"],
                },
                "outputs": {"type": "object", "properties": {"status": {}, "report": {}}},
            }
        ],
    }
    meta.update(overrides)
    return meta


def test_valid_package_metadata_passes() -> None:
    assert list(validator("package-metadata").iter_errors(package_metadata())) == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"name": "Demo Checks"},
        {"nodes": []},
        {"version": ""},
        {"version": "dev"},
        {"version": "../1.0"},
        {"unexpected": True},
    ],
)
def test_invalid_package_metadata_is_rejected(overrides: dict[str, Any]) -> None:
    assert not validator("package-metadata").is_valid(package_metadata(**overrides))


def test_node_entry_must_be_module_function() -> None:
    meta = package_metadata()
    meta["nodes"][0]["entry"] = "demo_checks.http"
    assert not validator("package-metadata").is_valid(meta)


def with_node(**fields: Any) -> dict[str, Any]:
    meta = package_metadata()
    meta["nodes"][0].update(fields)
    return meta


def test_node_type_can_declare_metrics_charts_and_primary_metric() -> None:
    meta = with_node(
        metrics=[
            {"name": "tps", "unit": "笔/s", "kind": "gauge", "description": "每秒成交"},
            {"name": "rejected", "unit": "", "kind": "counter"},
        ],
        charts=[{"title": "TPS", "type": "stat", "metrics": ["tps", "rejected"]}],
        primary_metric="tps",
    )
    assert list(validator("package-metadata").iter_errors(meta)) == []


@pytest.mark.parametrize(
    "fields",
    [
        {"metrics": [{"name": f"m{i}", "unit": "", "kind": "gauge"} for i in range(51)]},
        {"charts": [{"title": f"c{i}", "type": "line", "metrics": ["m"]} for i in range(21)]},
        {"metrics": [{"name": "m", "unit": "", "kind": "histogram"}]},
        {"metrics": [{"name": "m", "kind": "gauge"}]},
        {"charts": [{"title": "c", "type": "pie", "metrics": ["m"]}]},
        {"charts": [{"title": "c", "type": "line", "metrics": []}]},
        {"primary_metric": "9lives"},
    ],
)
def test_invalid_metric_declarations_are_rejected(fields: dict[str, Any]) -> None:
    assert not validator("package-metadata").is_valid(with_node(**fields))


def test_orchestration_document_with_defaults_omitted_passes() -> None:
    doc = {
        "default_agent": "lab-01",
        "nodes": [
            {
                "id": "entry",
                "kind": "entry",
                "params": [{"name": "url", "type": "string"}],
            },
            {
                "id": "check",
                "kind": "package",
                "package": "demo-checks",
                "node": "http_check",
                "inputs": {"url": "${{ params.url }}/health"},
            },
            {"id": "cleanup", "kind": "sleep", "duration": "5s", "always": True},
        ],
        "edges": [
            {"from": "entry", "to": "check", "kind": "chain"},
            {"from": "check", "to": "cleanup", "kind": "chain"},
        ],
        "packages": {"demo-checks": "1.2.0"},
    }
    assert list(validator("orchestration-document").iter_errors(doc)) == []


def test_orchestration_document_rejects_unknown_node_kind() -> None:
    doc = {"nodes": [{"id": "x", "kind": "foreach"}]}
    assert not validator("orchestration-document").is_valid(doc)
