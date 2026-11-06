"""SDK 运行时只能依赖标准库（ADR 0002）：导入后不应出现任何第三方模块。"""

from __future__ import annotations

import importlib.metadata
import json
import subprocess
import sys

RUNTIME_MODULES = [
    "sfly",
    "sfly.context",
    "sfly.installed",
    "sfly.local",
    "sfly.nodes",
    "sfly.runner",
    "sfly.schemas",
    # 本地调试（sfly.testing 在节点包的 pytest 里使用，执行时还会导入 sfly.cli.scan）。
    "sfly.testing",
    "sfly.cli.scan",
]

PROBE = """
import json, sys
before = set(sys.modules)
for name in {modules!r}:
    __import__(name)
loaded = {{m.split(".")[0] for m in set(sys.modules) - before}}
print(json.dumps(sorted(loaded)))
"""


def test_runtime_imports_only_stdlib() -> None:
    out = subprocess.run(
        [sys.executable, "-I", "-c", PROBE.format(modules=RUNTIME_MODULES)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    loaded = set(json.loads(out))
    third_party = loaded - set(sys.stdlib_module_names) - {"sfly"}
    assert third_party == set()


def test_cli_reports_version() -> None:
    out = subprocess.run(
        [sys.executable, "-c", "import sfly.cli; sfly.cli.main(['--version'])"],
        capture_output=True,
        text=True,
    )
    assert out.returncode == 0
    # 与 pyproject.toml 中的版本号一致（发布时由 scripts/release/version.sh 统一修改）。
    assert out.stdout.strip() == f"sfly {importlib.metadata.version('sfly')}"
