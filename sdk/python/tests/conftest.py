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
from indexes import SDK, FakeControlPlane, StaticServer, uv_env, wheelhouse


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
def pypi_mirror() -> Iterator[StaticServer]:
    """「PyPI 镜像」桩：`<url>/pypi/simple/`，有 pytest、ruff、jsonschema 及其依赖。"""
    with tempfile.TemporaryDirectory(prefix="sfly-wheelhouse-") as tmp:
        server = StaticServer()
        server.add_index("/pypi/simple", wheelhouse(["pytest", "ruff", "jsonschema"], Path(tmp)))
        yield server
        server.close()


@pytest.fixture
def control_plane(sfly_wheel: Path, pypi_mirror: StaticServer) -> Iterator[FakeControlPlane]:
    """配置了 PyPI 镜像（桩）和 Python 下载镜像（不会被访问：测试不下载 Python）的控制面。"""
    from sfly import __version__

    server = StaticServer()
    yield FakeControlPlane(
        server,
        version=__version__,
        pypi_mirror=f"{pypi_mirror.url}/pypi/simple/",
        python_install_mirror=f"{server.url}/github-release/astral-sh/python-build-standalone/",
        sfly_wheels=[sfly_wheel],
    )
    server.close()


@pytest.fixture
def sigterm_after(monkeypatch: pytest.MonkeyPatch) -> Callable[[Any, str], None]:
    """`sigterm_after(对象, 名称)`：之后调用 `对象.名称(...)` 时，在它返回之后、调用方拿到结果之前
    「收到 SIGTERM」：调用执行器装的处理函数（`sfly.context.on_sigterm`），和真实的信号落在这里
    一样。用来检查拿到资源（文件描述符、临时文件、子进程）和登记好清理之间被取消时不留下东西。"""
    from sfly.context import on_sigterm

    def patch(owner: Any, name: str) -> None:
        # 模块里没有定义的名字（例如 `open`）取内置的。
        real = getattr(owner, name, None) or getattr(builtins, name)

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            result = real(*args, **kwargs)
            on_sigterm(signal.SIGTERM, None)
            return result

        monkeypatch.setattr(owner, name, wrapper, raising=False)

    return patch
