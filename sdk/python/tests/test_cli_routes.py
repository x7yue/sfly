"""命令行用到的每个控制面路径都在路由清单里；控制面改了路由，这里就会失败。

清单由 HTTP 契约导出（`pnpm gen`，`pnpm gen:check` 保证它是最新的），命令行是手写的：
这条测试把两边对上，漏改的命令行路径在测试里就暴露出来，不用等到运行时 404。
"""

from __future__ import annotations

import json
import textwrap
from importlib import resources
from pathlib import Path

import pytest
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
        {
            "method": method,
            "path": path,
            "key": None,
            "kind": "endpoint",
            "summary": "测试用的接口",
            "effect": "read",
            "resource": {"kind": "system", "target": "global"},
        }
        for method, path in [
            ("GET", "/runs/:id"),
            ("POST", "/runs/:id/cancel"),
            ("GET", "/runs/:id/logs"),
            ("GET", "/orchestrations/:id/head"),
            ("POST", "/projects/default/packages"),
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
        schemas = [
            route.params,
            route.query,
            route.body,
            route.response,
            *(route.events or {}).values(),
        ]
        for schema in schemas:
            if schema is not None:
                Draft202012Validator.check_schema(schema)


def test_every_route_in_the_manifest_has_a_one_line_summary_and_documented_request_fields() -> None:
    routes = load_routes()
    for route in routes:
        assert route.summary == route.summary.strip() and "\n" not in route.summary, route.path
        assert len(route.summary) <= 80, f"{route.method} {route.path}：说明超过 80 字"
    # 请求参数和请求体的字段说明进了清单：keep 是审查举的「含义不明显」的例子
    update = next(
        r for r in routes if r.method == "PATCH" and r.path.endswith("/presets/:presetId")
    )
    assert update.body is not None
    keep = update.body["properties"]["params"]["items"]["properties"]["keep"]
    assert "沿用" in keep["description"]
    # 按用途找：没见过这个平台的人会用的词
    wanted = {"输出", "日志", "产物", "指标", "关注项", "预设", "取消", "失败原因"}
    for word in wanted:
        assert any(word in route.summary for route in routes), f"没有接口的说明里有「{word}」"


def test_an_old_path_says_where_it_moved(capsys: pytest.CaptureFixture[str]) -> None:
    # 列表、新建和按名字定位的接口搬到了 /projects/<项目>/… 下（#488）：旧写法写明新写法，不发请求。
    from sfly.cli import main

    assert main(["api", "GET", "/agents", "--server", "http://127.0.0.1:9", "--json"]) == 2
    error = json.loads(capsys.readouterr().err)["error"]
    assert error["code"] == "route_moved"
    assert "/projects/default/agents" in error["message"]
    assert error["next"] == "sfly api GET /projects/default/agents"


def _moved(capsys: pytest.CaptureFixture[str], *args: str) -> dict[str, str]:
    from sfly.cli import main

    assert main(["api", *args, "--server", "http://127.0.0.1:9", "--json"]) == 2
    error: dict[str, str] = json.loads(capsys.readouterr().err)["error"]
    return error


def test_the_old_project_query_picks_the_project_of_the_new_path(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    # 旧的 POST /packages?project=public 发布到公共项目：照抄提示还是发到公共项目，
    # 不能变成默认项目。
    monkeypatch.delenv("SFLY_PROJECT", raising=False)
    error = _moved(capsys, "POST", "/packages?project=public")
    assert error["code"] == "route_moved"
    assert error["next"] == "sfly api POST /projects/public/packages"
    assert "?project=" in error["message"]
    error = _moved(capsys, "POST", "/packages", "--query", "project=public")
    assert error["next"] == "sfly api POST /projects/public/packages"
    # 不写 project 时是 SFLY_PROJECT，默认 default。
    assert _moved(capsys, "POST", "/packages")["next"] == "sfly api POST /projects/default/packages"
    monkeypatch.setenv("SFLY_PROJECT", "team-a")
    assert _moved(capsys, "GET", "/agents")["next"] == "sfly api GET /projects/team-a/agents"
    assert (
        _moved(capsys, "GET", "/runs?limit=5")["next"]
        == "sfly api GET '/projects/team-a/runs?limit=5'"
    )
    assert (
        _moved(capsys, "DELETE", "/feishu-bots/群")["next"]
        == "sfly api DELETE '/projects/team-a/feishu-bots/群'"
    )
    # 别的查询参数留在新写法里（项目只从发布接口的旧参数里取）。
    error = _moved(capsys, "GET", "/agents?project=public&x=1")
    assert error["next"] == "sfly api GET '/projects/team-a/agents?project=public&x=1'"


def test_only_routes_that_really_moved_get_the_hint(capsys: pytest.CaptureFixture[str]) -> None:
    # 加上项目恰好对得上清单的路径，不是 #488 搬过的旧路由，不给 route_moved
    # （例如本来就没有的 /sessions 列表）。
    error = _moved(capsys, "GET", "/sessions")
    assert error["code"] != "route_moved"
    error = _moved(capsys, "GET", "/workbench")
    assert error["code"] != "route_moved"
