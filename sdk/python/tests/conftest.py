"""SDK 测试共用的 fixture；桩的实现见 indexes.py（测试里 `from indexes import ...`）。"""

from __future__ import annotations

import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

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
