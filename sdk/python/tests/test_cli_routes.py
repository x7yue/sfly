"""命令行用到的每个控制面路径都在路由清单里；控制面改了路由，这里就会失败。

清单由 HTTP 契约导出（`pnpm gen`，`pnpm gen:check` 保证它是最新的），命令行是手写的：
这条测试把两边对上，漏改的命令行路径在测试里就暴露出来，不用等到运行时 404。
"""

from __future__ import annotations

import json
import textwrap
from importlib import resources
from pathlib import Path

from cli_paths import collect_paths, mismatches
from jsonschema import Draft202012Validator

import sfly.cli
from sfly.cli.routes import load_routes, routes_from_manifest

CLI_SOURCE = Path(sfly.cli.__file__).parent


def test_every_path_the_cli_uses_is_in_the_manifest() -> None:
    uses = collect_paths(CLI_SOURCE)
    assert {use.path.split("/")[1] for use in uses} >= {"orchestrations", "runs", "tasks"}, (
        "扫描没有找到命令行用到的路径，扫描方式可能失效了"
    )
    missing = mismatches(uses, load_routes())
    assert missing == [], "命令行用到了路由清单里没有的路径（控制面改了路由？）：\n" + "\n".join(
        f"  {use}" for use in missing
    )


SMALL_MANIFEST = {
    "routes": [
        {"method": method, "path": path, "key": None, "kind": "endpoint"}
        for method, path in [
            ("GET", "/runs/:id"),
            ("POST", "/runs/:id/cancel"),
            ("GET", "/runs/:id/logs"),
            ("GET", "/orchestrations/:id/head"),
            ("POST", "/packages"),
        ]
    ]
}


def test_a_path_that_does_not_match_the_manifest_fails_the_check(tmp_path: Path) -> None:
    (tmp_path / "ok.py").write_text(
        textwrap.dedent(
            """
            def good(client, run_id):
                client.get(f"/runs/{run_id}")
                client.request("POST", f"/runs/{run_id}/cancel")
                base = f"/orchestrations/{run_id}"
                client.get(f"{base}/head")
            """
        )
    )
    (tmp_path / "bad.py").write_text(
        textwrap.dedent(
            """
            def typo(client, run_id):
                client.get(f"/runs/{run_id}/lgos")

            def wrong_method(client, run_id):
                client.request("POST", f"/runs/{run_id}")

            def built_from_a_variable(client, scenario_id):
                base = f"/orchestrations/{scenario_id}"
                client.get(f"{base}/headz")

            def outside_the_client(server):
                return f"{server}/pakages"
            """
        )
    )
    flagged = {
        (use.file, use.method, use.path)
        for use in mismatches(collect_paths(tmp_path), routes_from_manifest(SMALL_MANIFEST))
    }
    assert flagged == {
        ("bad.py", "GET", "/runs/x/lgos"),
        ("bad.py", None, "/runs/x/lgos"),
        ("bad.py", "POST", "/runs/x"),
        ("bad.py", "GET", "/orchestrations/x/headz"),
        ("bad.py", None, "/orchestrations/x/headz"),
        ("bad.py", None, "/pakages"),
    }


def test_a_route_changed_in_the_contract_makes_the_checked_cli_fail() -> None:
    manifest = json.loads(
        resources.files("sfly.schemas").joinpath("routes.json").read_text(encoding="utf-8")
    )
    for route in manifest["routes"]:
        if route["path"] == "/runs/:id/logs":
            route["path"] = "/runs/:id/log-lines"
    missing = mismatches(collect_paths(CLI_SOURCE), routes_from_manifest(manifest))
    assert {use.file for use in missing} >= {"run_logs.py"}
    assert {use.path for use in missing} >= {"/runs/x/logs"}


def test_every_schema_in_the_manifest_is_a_valid_json_schema() -> None:
    routes = load_routes()
    assert len(routes) > 50
    for route in routes:
        for schema in (route.params, route.query, route.body):
            if schema is not None:
                Draft202012Validator.check_schema(schema)
