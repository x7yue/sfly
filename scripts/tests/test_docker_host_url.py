"""e2e-docker.sh 在 macOS 上换数据库地址里的主机名（scripts/docker-host-url.sh）：
换漏了容器连不上数据库，换多了连到别的库。这里逐种写法验证：指向本机的几种写法都换，别的地址原样不动。"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "docker-host-url.sh"


def rewrite(url: str) -> str:
    return subprocess.run(
        ["bash", str(SCRIPT), url], check=True, capture_output=True, text=True
    ).stdout


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        # 默认地址：用户名密码、IPv4、端口。
        (
            "postgres://sfly:sfly@127.0.0.1:5432/sfly",
            "postgres://sfly:sfly@host.docker.internal:5432/sfly",
        ),
        (
            "postgres://sfly:sfly@localhost:5432/sfly",
            "postgres://sfly:sfly@host.docker.internal:5432/sfly",
        ),
        ("postgres://sfly:sfly@localhost/sfly", "postgres://sfly:sfly@host.docker.internal/sfly"),
        ("postgres://u@localhost:5432/db", "postgres://u@host.docker.internal:5432/db"),
        # 不带用户名密码。
        ("postgres://localhost/db", "postgres://host.docker.internal/db"),
        ("postgres://localhost:5432/db", "postgres://host.docker.internal:5432/db"),
        ("postgres://127.0.0.1/db", "postgres://host.docker.internal/db"),
        ("postgres://localhost", "postgres://host.docker.internal"),
        # IPv6 的本机地址。
        ("postgres://u:p@[::1]:5432/db", "postgres://u:p@host.docker.internal:5432/db"),
        ("postgres://[::1]/db", "postgres://host.docker.internal/db"),
        ("postgres://[::1]:5432/db", "postgres://host.docker.internal:5432/db"),
        # postgresql:// 同样；查询参数保留。
        (
            "postgresql://u:p@localhost/db?sslmode=disable",
            "postgresql://u:p@host.docker.internal/db?sslmode=disable",
        ),
        (
            "postgres://u:p@localhost?sslmode=disable",
            "postgres://u:p@host.docker.internal?sslmode=disable",
        ),
    ],
)
def test_localhost_forms_are_rewritten(url: str, expected: str) -> None:
    assert rewrite(url) == expected


@pytest.mark.parametrize(
    "url",
    [
        "postgres://u:p@db.example.com:5432/x",
        "postgres://u:p@localhost.example.com/x",
        "postgres://u:p@127.0.0.10:5432/x",
        "postgres://u:p@mylocalhost/x",
        "postgres://u:p@10.0.0.5/localhost",
        "postgres://u:p@db.example.com/x?host=localhost",
        "postgres://u:p@[::2]/x",
        "postgres://u:p@host.docker.internal:5432/x",
    ],
)
def test_other_addresses_are_left_alone(url: str) -> None:
    assert rewrite(url) == url
