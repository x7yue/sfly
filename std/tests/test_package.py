"""构建出的 sfly-std 节点包：元信息合法、声明了最低 SDK 版本、依赖只写下限、每个节点都有文档。

发布流程（.github/workflows/std-release.yml）发布前也做同样的检查（scripts/release/std.sh）。
"""

from __future__ import annotations

import json
import os
import re
import sys
import zipfile
from email.parser import Parser
from pathlib import Path
from typing import Any

import pytest
from packaging.specifiers import SpecifierSet
from packaging.version import Version

from sfly import __version__ as SDK_VERSION
from sfly.cli.build import build

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

REPO = Path(__file__).resolve().parents[2]
STD = REPO / "std"
DOC = REPO / "docs" / "guide" / "standard-nodes.md"
#: 构建出的 `shell` 节点类型（元信息 nodes 里的那一项）。前端端到端测试
#: （apps/web/e2e/std-shell.spec.ts）在没有 Python 的 Playwright 镜像里运行，构建不了 sfly-std，
#: 用这份副本发布节点包。
SHELL_NODE_FIXTURE = REPO / "testdata" / "std-shell-node.json"
#: 最后一个不支持指标标签的已发布平台版本（v0.0.4）；标签（#78）从它的下一个版本起才有。
LAST_SDK_WITHOUT_LABELS = Version("0.0.4")
#: 最后一个没有 ctx.artifacts.download 的已发布平台版本（v0.1.3）；
#: 下载接口（#193）从它的下一个版本起才有。
LAST_SDK_WITHOUT_ARTIFACT_DOWNLOAD = Version("0.1.3")
#: 最后一个没有 Agent 能力 files（files.list、files.read、files.write）的已发布平台版本（v0.1.3）；
#: 它们（#198–#200，ADR 0019）和 SDK 的 ctx.agent() 从它的下一个版本起才有。
LAST_AGENT_WITHOUT_FILE_CAPABILITIES = Version("0.1.3")


@pytest.fixture(scope="module")
def archive(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return build(STD, tmp_path_factory.mktemp("sfly-std"))


@pytest.fixture(scope="module")
def metadata(archive: Path) -> dict[str, Any]:
    with zipfile.ZipFile(archive) as zf:
        result: dict[str, Any] = json.loads(zf.read("sfly-package.json"))
    return result


def test_archive_is_named_after_the_package_version(archive: Path) -> None:
    project = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))["project"]

    assert archive.name == f"sfly-std-{project['version']}.sflypkg"


def test_declares_the_minimum_sdk_version_explicitly(metadata: dict[str, Any]) -> None:
    # 不写时 sfly build 用构建时 SDK 的版本，会随平台版本上涨、无谓地拒绝旧 Agent（#79）。
    pyproject = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))
    declared = pyproject.get("tool", {}).get("sfly", {}).get("requires-sdk")

    assert declared, "std/pyproject.toml 必须声明 [tool.sfly] requires-sdk"
    assert metadata["requires_sdk"] == declared


def test_declares_the_minimum_agent_version_explicitly(metadata: dict[str, Any]) -> None:
    # pull_files 用 Agent 能力访问另一台 Agent（ADR 0019）：requires-agent 同时约束节点所在的 Agent
    # 和「Agent」类型的参数选的 Agent，不满足时触发前预检就阻断，不会运行到一半才失败。
    pyproject = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))
    declared = pyproject.get("tool", {}).get("sfly", {}).get("requires-agent")

    assert declared, "std/pyproject.toml 必须声明 [tool.sfly] requires-agent"
    assert metadata["requires_agent"] == declared


def test_requires_an_agent_with_the_file_capabilities() -> None:
    # pull_files 列出、下载、删除另一台 Agent 上的文件：两台 Agent 都要有能力 files、files.read、
    # files.write。和 requires-sdk 一样，这些能力还没随平台版本发布时只能声明当前版本能满足的范围
    # （否则同版本的控制面在预检时阻断全部标准节点）；仓库版本号一旦越过
    # LAST_AGENT_WITHOUT_FILE_CAPABILITIES，requires-agent 必须同步排除它。
    pyproject = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))
    declared = SpecifierSet(pyproject["tool"]["sfly"]["requires-agent"])
    version = Version(SDK_VERSION)  # 平台版本：SDK、Agent、控制面同一个版本号

    assert version in declared, f"当前版本 {version} 不满足 requires-agent {declared}"
    if version > LAST_AGENT_WITHOUT_FILE_CAPABILITIES:
        assert LAST_AGENT_WITHOUT_FILE_CAPABILITIES not in declared, (
            f"版本号已是 {version}：std/pyproject.toml 的 requires-agent 要调成 >={version}"
            "（Agent 能力 files）"
        )


def test_requires_an_sdk_that_supports_metric_labels() -> None:
    # system_monitor、process_monitor 按网卡、磁盘、进程上报带标签的指标：
    # 不支持标签的旧 Agent 会丢掉标签，把各个对象的点混进同一个序列。
    # 标签还没随平台版本发布时只能声明当前版本（否则同版本的控制面拒绝全部标准节点）；
    # 仓库版本号一旦越过 LAST_SDK_WITHOUT_LABELS，requires-sdk 必须同步排除它。
    pyproject = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))
    declared = SpecifierSet(pyproject["tool"]["sfly"]["requires-sdk"])
    sdk = Version(SDK_VERSION)

    assert sdk in declared, f"当前 SDK {sdk} 不满足 requires-sdk {declared}"
    if sdk > LAST_SDK_WITHOUT_LABELS:
        assert LAST_SDK_WITHOUT_LABELS not in declared, (
            f"版本号已是 {sdk}：std/pyproject.toml 的 requires-sdk 要调成 >={sdk}（指标标签）"
        )


def test_requires_an_sdk_that_can_download_artifacts() -> None:
    # 0.3.0 起 shell 的 stdout_file / stderr_file、http_request 的 body_file 是给后续节点用
    # ctx.artifacts.download 下载的（#181）：声明的最低 SDK 版本是第一个带下载接口的平台版本。
    # pull_files 用到的 ctx.agent()（#198）也从同一个版本起才有。
    # 和指标标签一样，下载接口还没随平台版本发布时只能声明当前版本能满足的范围；
    # 仓库版本号一旦越过 LAST_SDK_WITHOUT_ARTIFACT_DOWNLOAD，requires-sdk 必须同步排除它，
    # sfly-std 0.3.0 在那个平台版本发布之后再发布（docs/agents/branching-and-release.md）。
    pyproject = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))
    declared = SpecifierSet(pyproject["tool"]["sfly"]["requires-sdk"])
    sdk = Version(SDK_VERSION)

    assert sdk in declared, f"当前 SDK {sdk} 不满足 requires-sdk {declared}"
    if sdk > LAST_SDK_WITHOUT_ARTIFACT_DOWNLOAD:
        assert LAST_SDK_WITHOUT_ARTIFACT_DOWNLOAD not in declared, (
            f"版本号已是 {sdk}：std/pyproject.toml 的 requires-sdk 要调成 >={sdk}"
            "（ctx.artifacts.download）"
        )


def test_the_upload_instructions_on_the_standard_nodes_page_name_the_current_version() -> None:
    # 「上传 sfly-std」一节的命令里写的是当前版本的附件名，照着复制就能上传。
    version = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))["project"][
        "version"
    ]
    names = set(re.findall(r"sfly-std-[0-9][0-9.]*\.sflypkg", DOC.read_text(encoding="utf-8")))

    assert names == {f"sfly-std-{version}.sflypkg"}


def test_dependencies_only_have_lower_bounds(archive: Path) -> None:
    with zipfile.ZipFile(archive) as outer:
        wheel_name = next(n for n in outer.namelist() if n.endswith(".whl"))
        wheel = outer.extract(wheel_name, archive.parent / "wheel")
    with zipfile.ZipFile(wheel) as zf:
        meta_name = next(n for n in zf.namelist() if n.endswith(".dist-info/METADATA"))
        requires = Parser().parsestr(zf.read(meta_name).decode()).get_all("Requires-Dist") or []

    assert requires, "sfly-std 至少依赖 psutil 和 httpx"
    for requirement in requires:
        assert re.fullmatch(r"[A-Za-z0-9._-]+>=[0-9][0-9.]*", requirement.replace(" ", "")), (
            f"依赖只写宽松的下限（name>=X.Y），实际为 {requirement!r}"
        )


def test_every_node_has_a_chinese_title(metadata: dict[str, Any]) -> None:
    for node in metadata["nodes"]:
        assert re.search(r"[一-鿿]", node["title"]), node["name"]


def test_every_node_has_its_own_section_on_the_standard_nodes_page(
    metadata: dict[str, Any],
) -> None:
    sections = re.findall(r"^## `([a-z_][a-z0-9_]*)`", DOC.read_text(encoding="utf-8"), re.M)

    assert sorted(sections) == sorted(node["name"] for node in metadata["nodes"])


def _tables(text: str) -> dict[str, tuple[list[str], list[list[str]]]]:
    """Markdown 里的表格：表头第一格 → (表头, 数据行)。"""
    tables: dict[str, tuple[list[str], list[list[str]]]] = {}
    for block in re.findall(r"(?:^\|.*\n?)+", text, re.M):
        rows = [
            [cell.strip() for cell in line.strip().strip("|").split("|")]
            for line in block.strip().splitlines()
        ]
        tables[rows[0][0]] = (rows[0], rows[2:])
    return tables


def _names(cell: str) -> list[str]:
    """表格第一格里的参数、输出或指标名：`a`、`a` / `b`、`a`、`b`。"""
    return re.findall(r"`([a-z_][a-z0-9_]*)`", cell)


def _node_sections() -> dict[str, tuple[str, str]]:
    """「标准节点」页里每个节点的小节：节点名 → (标题, 正文)。"""
    page = DOC.read_text(encoding="utf-8")
    return {
        m["name"]: (m["title"], m["body"])
        for m in re.finditer(
            r"^## `(?P<name>[a-z_][a-z0-9_]*)`：(?P<title>.+)\n(?P<body>(?:(?!^## ).*\n?)*)",
            page,
            re.M,
        )
    }


def _labels(cell: str) -> list[str]:
    """指标说明末尾的「标签 `a`、`b`」里的标签键；没有时为空。"""
    m = re.search(r"，标签 ((?:`[a-z_][a-z0-9_]*`、?)+)$", cell)
    return _names(m[1]) if m else []


def test_the_overview_lists_every_node_with_its_title(metadata: dict[str, Any]) -> None:
    overview = DOC.read_text(encoding="utf-8").split("\n## 节点一览\n", 1)[1].split("\n## ", 1)[0]
    header, rows = _tables(overview)["类别"]

    assert header == ["类别", "节点", "标题", "用途"]
    assert sorted((_names(row[1])[0], row[2]) for row in rows) == sorted(
        (node["name"], node["title"]) for node in metadata["nodes"]
    )


def test_every_section_documents_the_parameters_outputs_and_metrics_in_the_same_layout(
    metadata: dict[str, Any],
) -> None:
    # 每节的结构一致：标题与节点标题相同；参数表、输出表（没有输出时写明「没有输出。」）、
    # 指标表（有指标时，含单位、标出主指标，带标签的指标在说明末尾写「标签 `键`、`键`」）
    # 与构建出的元信息逐项对应。
    sections = _node_sections()
    for node in metadata["nodes"]:
        name = node["name"]
        title, body = sections[name]
        tables = _tables(body)
        assert title == node["title"], name

        header, rows = tables["参数"]
        assert header == ["参数", "默认值", "说明"], name
        assert sorted(n for row in rows for n in _names(row[0])) == sorted(
            node["inputs"]["properties"]
        ), name

        outputs = sorted(node["outputs"].get("properties", {}))
        if outputs:
            header, rows = tables["输出"]
            assert header == ["输出", "说明"], name
            assert sorted(n for row in rows for n in _names(row[0])) == outputs, name
        else:
            assert "输出" not in tables and "\n没有输出。" in body, name

        if node["metrics"]:
            header, rows = tables["指标"]
            assert header == ["指标", "单位", "说明"], name
            units = {n: row[1] for row in rows for n in _names(row[0])}
            assert units == {m["name"]: m.get("unit", "") for m in node["metrics"]}, name
            primary = [n for row in rows if "（主指标）" in row[0] for n in _names(row[0])]
            assert primary == [node["primary_metric"]], name
            labels = {n: _labels(row[2]) for row in rows for n in _names(row[0])}
            assert labels == {m["name"]: m.get("labels", []) for m in node["metrics"]}, name
        else:
            assert "指标" not in tables, name


def test_the_shell_node_fixture_for_the_web_e2e_tests_matches_the_built_package(
    metadata: dict[str, Any],
) -> None:
    # 改了 shell 的参数或输出后重新生成：
    # SFLY_UPDATE_FIXTURES=1 uv run pytest std/tests/test_package.py
    node = next(n for n in metadata["nodes"] if n["name"] == "shell")
    if os.environ.get("SFLY_UPDATE_FIXTURES") == "1":
        SHELL_NODE_FIXTURE.write_text(
            json.dumps(node, ensure_ascii=False, indent="\t") + "\n", encoding="utf-8"
        )

    assert json.loads(SHELL_NODE_FIXTURE.read_text(encoding="utf-8")) == node, (
        f"{SHELL_NODE_FIXTURE.relative_to(REPO)} 与构建出的 shell 节点不一致，"
        "用 SFLY_UPDATE_FIXTURES=1 重新生成，再 pnpm exec biome format --write 这个文件"
    )


def test_system_monitor_declares_its_metrics_charts_and_primary_metric(
    metadata: dict[str, Any],
) -> None:
    node = next(n for n in metadata["nodes"] if n["name"] == "system_monitor")

    assert node["primary_metric"] == "cpu_percent"
    assert {m["name"] for m in node["metrics"]} == {
        "cpu_percent",
        "mem_used_percent",
        "mem_used_bytes",
        "load1",
        "disk_used_percent",
        "disk_read_bytes_per_s",
        "disk_write_bytes_per_s",
        "net_rx_bytes_per_s",
        "net_tx_bytes_per_s",
        "net_rx_bytes_per_s_by_nic",
        "net_tx_bytes_per_s_by_nic",
        "disk_read_bytes_per_s_by_disk",
        "disk_write_bytes_per_s_by_disk",
    }
    # 每个指标都画在声明的图表里，不靠平台生成的默认图表。
    charted = {name for chart in node["charts"] for name in chart["metrics"]}
    assert charted == {m["name"] for m in node["metrics"]}
