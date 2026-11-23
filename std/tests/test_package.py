"""构建出的 sfly-std 节点包：元信息合法、声明了最低 SDK 版本、依赖只写下限、每个节点都有文档。

发布流程（.github/workflows/std-release.yml）发布前也做同样的检查（scripts/release/std.sh）。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import zipfile
from email.parser import Parser
from pathlib import Path
from typing import Any
from unittest import mock

import psutil
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
#: 最后一个没有 sfly.Doc 的已发布平台版本（v0.3.0）；Doc（#303）从它的下一个版本起才有。
LAST_SDK_WITHOUT_DOC = Version("0.3.0")
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
    # 辅助函数 pull_files_from_agent、watch_agent_files 用 Agent 能力访问另一台 Agent（ADR 0019）：
    # requires-agent 同时约束节点所在的 Agent 和「Agent」类型的参数选的 Agent，
    # 不满足时触发前预检就阻断，不会运行到一半才失败。
    pyproject = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))
    declared = pyproject.get("tool", {}).get("sfly", {}).get("requires-agent")

    assert declared, "std/pyproject.toml 必须声明 [tool.sfly] requires-agent"
    assert metadata["requires_agent"] == declared


def test_requires_an_agent_with_the_file_capabilities() -> None:
    # pull_files_from_agent 列出、下载、删除另一台 Agent 上的文件：两台 Agent 都要有能力
    # files、files.read、files.write。和 requires-sdk 一样，
    # 这些能力还没随平台版本发布时只能声明当前版本能满足的范围
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
    # monitor_system、monitor_processes 按网卡、磁盘、进程上报带标签的指标：
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
    # 0.3.0 起 shell 的 stdout_file / stderr_file 是给后续节点用
    # ctx.artifacts.download 下载的（#181）：声明的最低 SDK 版本是第一个带下载接口的平台版本。
    # pull_files_from_agent 用到的 ctx.agent()（#198）也从同一个版本起才有。
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


def test_requires_an_sdk_that_has_doc() -> None:
    # 标准节点用 Annotated[类型, Doc("…")] 写输入、输出的说明（#317），更旧的 SDK 导入标准节点包时
    # 就失败。和下载接口一样，Doc 还没随平台版本发布时只能声明当前版本能满足的范围（否则同版本的
    # 控制面在预检时阻断全部标准节点）；仓库版本号一旦越过 LAST_SDK_WITHOUT_DOC，requires-sdk
    # 必须同步排除它，下一次发布 sfly-std 在那个平台版本发布之后（见 branching-and-release.md）。
    pyproject = tomllib.loads((STD / "pyproject.toml").read_text(encoding="utf-8"))
    declared = SpecifierSet(pyproject["tool"]["sfly"]["requires-sdk"])
    sdk = Version(SDK_VERSION)

    assert sdk in declared, f"当前 SDK {sdk} 不满足 requires-sdk {declared}"
    if sdk > LAST_SDK_WITHOUT_DOC:
        assert LAST_SDK_WITHOUT_DOC not in declared, (
            f"版本号已是 {sdk}：std/pyproject.toml 的 requires-sdk 要调成 >={sdk}（sfly.Doc）"
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

    assert requires, "sfly-std 至少依赖 psutil"
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
    # 指标表（有指标时，含单位、标出主指标；有带标签的指标时多一列「标签」，写标签键）
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
            labeled = any(m.get("labels") for m in node["metrics"])
            assert header == ["指标", "单位", *(["标签"] if labeled else []), "说明"], name
            units = {n: row[1] for row in rows for n in _names(row[0])}
            assert units == {m["name"]: m.get("unit", "") for m in node["metrics"]}, name
            primary = [n for row in rows if "（主指标）" in row[0] for n in _names(row[0])]
            assert primary == [node["primary_metric"]], name
            if labeled:
                labels = {n: _names(row[2]) for row in rows for n in _names(row[0])}
                assert labels == {m["name"]: m.get("labels", []) for m in node["metrics"]}, name
        else:
            assert "指标" not in tables, name


def test_every_parameter_and_output_description_matches_the_standard_nodes_page(
    metadata: dict[str, Any],
) -> None:
    # 说明以代码为准（#317）：参数表、输出表、指标表「说明」列的文字，与元信息里这个输入、输出、
    # 指标的说明一字不差（一行写了几个名字时，每个名字的说明都要和这一格一样）。
    # 画布按纯文本显示说明，所以表格里不写 Markdown。
    sections = _node_sections()
    for node in metadata["nodes"]:
        tables = _tables(sections[node["name"]][1])
        for kind, schema in (("参数", node["inputs"]), ("输出", node["outputs"])):
            if kind not in tables:
                continue
            header, rows = tables[kind]
            column = header.index("说明")
            for row in rows:
                for name in _names(row[0]):
                    where = f"{node['name']} 的{kind} {name}"
                    description = schema["properties"][name].get("description")
                    assert row[column], f"{where}：「说明」列是空的"
                    assert description == row[column], where
        if node["metrics"]:
            header, rows = tables["指标"]
            column = header.index("说明")
            descriptions = {m["name"]: m.get("description") for m in node["metrics"]}
            for row in rows:
                for name in _names(row[0]):
                    where = f"{node['name']} 的指标 {name}"
                    assert row[column], f"{where}：「说明」列是空的"
                    assert descriptions[name] == row[column], where


#: 0.4.0 删除的 14 个节点（ADR 0030，名单也在 std/tests/test_release.py 和
#: packages/orchestration 的 `REMOVED_STD_NODES` 里）。
REMOVED_NODES = [
    "system_monitor",
    "process_monitor",
    "wait_port",
    "wait_file",
    "wait_log_line",
    "follow_log",
    "collect_artifacts",
    "pull_files",
    "watch_files",
    "http_request",
    "assert",
    "file_assert",
    "process_assert",
    "port_assert",
]


UPGRADE_HEADING = "\n## 从 0.3.0 升级"
RELEASE_NOTES = STD / "release-notes" / "0.4.0.md"


def upgrade_section(text: str) -> str:
    """「从 0.3.0 升级」一节：从它的标题到下一个二级标题（没有就到文件末尾）。"""
    _, found, rest = text.partition(UPGRADE_HEADING)
    assert found, "没有「从 0.3.0 升级」一节"
    return rest.split("\n## ", 1)[0]


def without_upgrade_section(text: str) -> str:
    """去掉「从 0.3.0 升级」一节（那里要写被删的节点），别的内容原样留着：后面再加的一节也要查。"""
    head, found, rest = text.partition(UPGRADE_HEADING)
    if not found:
        return text
    _, sep, after = rest.partition("\n## ")
    return head + (sep + after if sep else "")


def guide_texts() -> dict[str, str]:
    """开发文档目录里的页面（不含「标准节点」页里「从 0.3.0 升级」一节：那里要写被删的节点）。"""
    guide = REPO / "docs" / "guide"
    texts: dict[str, str] = {}
    for path in sorted([*guide.rglob("*.md"), guide / "pages.json"]):
        text = path.read_text(encoding="utf-8")
        if path == DOC:
            text = without_upgrade_section(text)
        texts[str(path.relative_to(REPO))] = text
    return texts


def uses_a_removed_node_as_a_node(text: str) -> list[str]:
    """文字里把被删的节点当节点来用的地方：`"node": "名字"`、`node: 名字`、「`名字` 节点」、
    `sfly-std` 后面跟着节点名；名字很特别的（`wait_port` 这类）出现就算，`assert` 这样的
    普通词只认前面几种写法。"""
    found: list[str] = []
    for name in REMOVED_NODES:
        node_forms = [
            rf'"node"\s*:\s*"{name}"',
            rf"\bnode:\s*{name}\b",
            rf"`{name}`\s*节点",
            rf"sfly-std[/.:@]{name}\b",
            rf"`sfly-std`\s*的\s*`{name}`",
        ]
        if name != "assert":
            # 下划线连着的名字（`pull_files_from_agent`、`follow_log_file`）是辅助函数，不是节点。
            node_forms.append(rf"(?<![\w.]){name}(?!\w)")
        for form in node_forms:
            found += [m.group(0) for m in re.finditer(form, text)]
    return found


def test_no_guide_page_names_a_removed_node_as_a_node() -> None:
    # 页面改成辅助函数之后，把 0.3.0 的节点名写回去（例如 quickstart 的示例场景里又用
    # `http_request`）没有别的测试会红：用户照着写会得到「节点包 sfly-std@0.4.0 中没有节点类型」。
    texts = guide_texts()
    found = {
        page: hits for page, text in texts.items() if (hits := uses_a_removed_node_as_a_node(text))
    }

    assert found == {}
    # 豁免只是「从 0.3.0 升级」一节：「标准节点」页前面的几节、后面可能加的节都还在被查的文本里
    # （豁免放大到整页时这里会红，守卫就成了摆设）。
    page = texts[str(DOC.relative_to(REPO))]
    assert "\n## `shell`" in page and "\n## `stop_process`" in page
    assert UPGRADE_HEADING not in page


def test_the_guard_for_removed_nodes_tells_a_node_from_an_ordinary_word() -> None:
    uses = uses_a_removed_node_as_a_node
    # 当节点来用：认出来。
    assert uses('{"package": "sfly-std", "node": "http_request"}')
    assert uses("先用 `wait_port` 节点等服务就绪")
    assert uses("sfly-std/assert")
    assert uses("起服务后再 follow_log")
    # 辅助函数、普通的词：不算。
    assert not uses("`sfly_std.logs.follow_log_file` 和 pull_files_from_agent")
    assert not uses("assert result.status == 'success'，断言失败时抛出异常")
    assert not uses("用 `shell` 节点跑一条命令")


def test_the_guard_exempts_only_the_upgrade_section() -> None:
    page = (
        "# 标准节点\n\n## `shell`：Shell 命令\n先用 `wait_port` 节点\n\n"
        "## 从 0.3.0 升级\n| `wait_port` | 辅助函数 |\n\n"
        "## 常见问题\n别再用 `http_request` 节点\n"
    )

    kept = without_upgrade_section(page)

    assert "| `wait_port` | 辅助函数 |" not in kept
    assert "## `shell`" in kept and "## 常见问题" in kept
    # 升级一节前后的内容照样查：两处都认出来。
    hits = uses_a_removed_node_as_a_node(kept)
    assert any("wait_port" in hit for hit in hits) and any("http_request" in hit for hit in hits)
    # 升级一节是最后一节时，去掉的就是到文件末尾。
    last = "# 标准节点\n\n## `shell`\n正文\n\n## 从 0.3.0 升级\n`wait_port` 节点\n"
    assert uses_a_removed_node_as_a_node(without_upgrade_section(last)) == []
    # 没有这一节的页面原样返回。
    assert (
        without_upgrade_section("# 别的页面\n`wait_port` 节点\n")
        == "# 别的页面\n`wait_port` 节点\n"
    )


def _recipe_block() -> str:
    """「从 0.3.0 升级」一节里 `process_assert` 的写法（那一节的第一段 Python 代码）。"""
    match = re.search(
        r"```python\n(.*?)```", upgrade_section(DOC.read_text(encoding="utf-8")), re.S
    )
    assert match, "「从 0.3.0 升级」一节里没有 Python 示例"
    return match.group(1)


def _run_recipe(code: str) -> list[Any]:
    namespace: dict[str, Any] = {}
    exec(compile(code, str(DOC), "exec"), namespace)
    matched: list[Any] = namespace["matched"]
    return matched


def test_the_process_assert_recipe_in_the_upgrade_section_runs_and_needs_every_condition() -> None:
    # 0.3.0 的 `process_assert` 同时给名字和命令行时要求全部满足；文档里的写法照抄要能跑、结果一样：
    # 名字对、命令行里有标记的进程数得到，只有名字对的数不到。
    marker = f"sfly-doc-recipe-{os.getpid()}"
    sleep = "import time; time.sleep(60)"
    both = subprocess.Popen([sys.executable, "-c", sleep, marker])
    only_name = subprocess.Popen([sys.executable, "-c", sleep])
    try:
        name = psutil.Process(both.pid).name()
        code = _recipe_block()
        assert 'name="python"' in code and "server\\.py" in code
        # 文档里是 name="python"、server.py：换成这台机器上解释器进程的名字和这次的标记。
        code = code.replace('name="python"', f"name={name!r}").replace("server\\.py", marker)
        # 刚起的子进程要等到 exec 完成、命令行才是最终的样子。
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and marker not in " ".join(
            psutil.Process(both.pid).cmdline()
        ):
            time.sleep(0.05)

        matched = _run_recipe(code)

        assert [p.pid for p in matched] == [both.pid]
    finally:
        for child in (both, only_name):
            child.kill()
            child.wait()


def test_the_process_assert_recipe_treats_a_vanished_or_unreadable_process_as_no_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 0.3.0 把 `cmdline()` 抛出的 NoSuchProcess（进程刚退出）、AccessDenied（macOS 上读别的用户的
    # 进程）都当作不匹配。
    alive = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "server.py"])
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and "server.py" not in " ".join(
            psutil.Process(alive.pid).cmdline()
        ):
            time.sleep(0.05)
        vanished = psutil.Process(gone.pid)
        gone.wait()
        denied = mock.Mock(spec=psutil.Process)
        denied.cmdline.side_effect = psutil.AccessDenied()
        candidates = [psutil.Process(alive.pid), vanished, denied]
        monkeypatch.setattr("sfly_std.processes.find_processes", lambda **_: candidates)
        with pytest.raises(psutil.NoSuchProcess):
            vanished.cmdline()

        matched = _run_recipe(_recipe_block())

        assert [p.pid for p in matched] == [alive.pid]
    finally:
        alive.kill()
        alive.wait()


def test_the_release_notes_carry_the_same_recipe_as_the_guide() -> None:
    notes = RELEASE_NOTES.read_text(encoding="utf-8")
    assert f"```python\n{_recipe_block()}```" in notes


def test_the_removed_node_list_and_the_warning_pointer_match_the_control_plane() -> None:
    # 被删节点的名单有几份：TS 侧（`REMOVED_STD_NODES`，保存、检查、预检的警告用它）、这里、发布说明
    # 的表。TS 侧少一个名字时那个节点的警告就没有指向替换办法的那半句；警告的原文还抄在开发文档和
    # 发布说明里。
    ts = (REPO / "packages" / "orchestration" / "src" / "references.ts").read_text(encoding="utf-8")
    listed = re.search(r"REMOVED_STD_NODES[^=]*=\s*new Set\(\[(.*?)\]\)", ts, re.S)
    assert listed, "references.ts 里找不到 REMOVED_STD_NODES"
    assert sorted(re.findall(r'"(\w+)"', listed.group(1))) == sorted(REMOVED_NODES)

    pointer = re.search(r'REMOVED_STD_NODE_HINT\s*=\s*"(.*?)";', ts, re.S)
    assert pointer, "references.ts 里找不到 REMOVED_STD_NODE_HINT"
    sentence = f"节点包 sfly-std@0.4.0 中没有节点类型 assert{pointer.group(1)}"
    assert sentence in DOC.read_text(encoding="utf-8")
    assert sentence in RELEASE_NOTES.read_text(encoding="utf-8")


def test_descriptions_are_plain_text(metadata: dict[str, Any]) -> None:
    # 节点、输入、输出、指标的说明在画布上按纯文本显示（不渲染 Markdown）：反引号和链接会原样出现。
    markdown = re.compile(r"`|\]\(")
    for node in metadata["nodes"]:
        schemas = [node["inputs"], node["outputs"]]
        texts = (
            [(node["name"], node.get("description"))]
            + [
                (f"{node['name']} 的 {name}", prop.get("description"))
                for schema in schemas
                for name, prop in schema.get("properties", {}).items()
            ]
            + [(f"{node['name']} 的 {m['name']}", m.get("description")) for m in node["metrics"]]
        )
        for where, text in texts:
            assert text is None or not markdown.search(text), f"{where} 的说明里有 Markdown"


def test_every_node_has_a_description(metadata: dict[str, Any]) -> None:
    # 节点函数的文档字符串就是节点类型的说明，显示在「添加节点」菜单和检查器里。
    assert [n["name"] for n in metadata["nodes"] if not n.get("description")] == []


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
