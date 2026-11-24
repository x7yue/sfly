"""全栈测试用的节点包 testdata/std-helpers-package 的源码，和测试里的外壳、文档里的示例是同一份。

`helper_nodes.py`（这个目录里测试用的节点外壳）和 `service_example.py`（开发文档里的示例）
复制到了那个节点包里，在真实的控制面和 Agent 上跑
（apps/server/test/full-stack-std-helpers.test.ts）：改了这里的文件，要把副本一起改。
"""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parents[1] / "testdata" / "std-helpers-package" / "src" / "std_helpers_user"


def test_the_full_stack_package_has_the_same_nodes_as_the_test_shims() -> None:
    assert (PACKAGE / "__init__.py").read_text(encoding="utf-8") == (
        HERE / "helper_nodes.py"
    ).read_text(encoding="utf-8"), (
        "改了 std/tests/helper_nodes.py：把它复制到 testdata/std-helpers-package"
    )


def test_the_full_stack_package_has_the_documentation_example() -> None:
    assert (PACKAGE / "service.py").read_text(encoding="utf-8") == (
        HERE / "service_example.py"
    ).read_text(encoding="utf-8"), (
        "改了 std/tests/service_example.py：把它复制到 testdata/std-helpers-package"
    )
