"""SDK 测试共用的 fixture；桩的实现见 indexes.py（测试里 `from indexes import ...`）。"""

from __future__ import annotations

import builtins
import signal
import subprocess
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from indexes import SDK, STD, FakeControlPlane, StaticServer, uv_env, wheelhouse


@pytest.fixture(scope="session")
def sfly_wheel(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """从本仓库 sdk/python 构建的 sfly wheel（版本即 `sfly.__version__`）。"""
    out = tmp_path_factory.mktemp("sfly-wheel")
    env = uv_env(out)
    subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(out), str(SDK)],
        check=True,
        capture_output=True,
        env=env,
    )
    return next(out.glob("sfly-*.whl"))


@pytest.fixture(scope="session")
def std_wheel(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """从本仓库 std 构建的 sfly-std wheel（控制面的包索引里的 sfly-std）。"""
    out = tmp_path_factory.mktemp("std-wheel")
    subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(out), str(STD)],
        check=True,
        capture_output=True,
        env=uv_env(out),
    )
    return next(out.glob("sfly_std-*.whl"))


@pytest.fixture(scope="session")
def pypi_mirror() -> Iterator[StaticServer]:
    """「PyPI 镜像」桩：`<url>/pypi/simple/`。

    有 pytest、ruff、jsonschema、sfly-std 的依赖（psutil）及它们的依赖；
    没有 sfly-std 和 sfly：它们不在 PyPI 上，只在控制面的包索引里。"""
    with tempfile.TemporaryDirectory(prefix="sfly-wheelhouse-") as tmp:
        server = StaticServer()
        server.add_index(
            "/pypi/simple",
            wheelhouse(["pytest", "ruff", "jsonschema", "psutil"], Path(tmp)),
        )
        yield server
        server.close()


@pytest.fixture
def control_plane(
    sfly_wheel: Path, std_wheel: Path, pypi_mirror: StaticServer
) -> Iterator[FakeControlPlane]:
    """配置了 PyPI 镜像（桩）和 Python 下载镜像（不会被访问：测试不下载 Python）的控制面。"""
    from sfly import __version__

    server = StaticServer()
    yield FakeControlPlane(
        server,
        version=__version__,
        pypi_mirror=f"{pypi_mirror.url}/pypi/simple/",
        python_install_mirror=f"{server.url}/github-release/astral-sh/python-build-standalone/",
        wheels=[sfly_wheel, std_wheel],
    )
    server.close()


@pytest.fixture
def short_dir() -> Iterator[Path]:
    """放本地 socket 的短目录（TMPDIR 下）：socket 路径有长度上限（Linux 108 字节，
    macOS 104 字节），`tmp_path` 下的路径会超出。和 `tmp_path` 一样解析掉符号链接（macOS 的
    /var 链接到 /private/var），切换到这里之后 `os.getcwd()` 与它一致。"""
    with tempfile.TemporaryDirectory(prefix="sfly-") as tmp:
        yield Path(tmp).resolve()


@pytest.fixture(autouse=True)
def _cancelled_once_per_test() -> Iterator[None]:
    """执行器进程里一次取消只抛一次 `Cancelled`（`sfly.context.cancelled_error`）；
    测试在同一个进程里多次「收到取消」，每个用例从没有抛出过开始。"""
    from sfly.context import _Sigterm

    _Sigterm.raised = False
    yield
    _Sigterm.raised = False


@pytest.fixture
def sigterm_after(monkeypatch: pytest.MonkeyPatch) -> Callable[[Any, str], None]:
    """`sigterm_after(对象, 名称)`：之后调用 `对象.名称(...)` 时，在它返回之后、调用方拿到结果之前
    「收到 SIGTERM」：调用执行器装的处理函数（`sfly.context.on_sigterm`），和真实的信号落在这里
    一样。用来检查拿到资源（文件描述符、临时文件、子进程）和登记好清理之间被取消时不留下东西。
    每次都当作一次新的取消：一个用例里先后检查几种操作时，各自都收到 `Cancelled`。"""
    from sfly.context import _Sigterm, on_sigterm

    def patch(owner: Any, name: str) -> None:
        # 模块里没有定义的名字（例如 `open`）取内置的。
        real = getattr(owner, name, None) or getattr(builtins, name)

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            result = real(*args, **kwargs)
            _Sigterm.raised = False
            on_sigterm(signal.SIGTERM, None)
            return result

        monkeypatch.setattr(owner, name, wrapper, raising=False)

    return patch
