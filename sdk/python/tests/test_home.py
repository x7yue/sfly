"""`SFLY_HOME`（默认 `~/.sfly`）：`sfly publish` 的控制面地址按 `--server` > `SFLY_SERVER` >
`$SFLY_HOME/agent.env` 取值；`sfly dev` 按 Agent 相同的规则找本地 socket
（默认 `$SFLY_HOME/work/agent.sock`）。"""

from __future__ import annotations

import json
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from sfly.cli import main


class FakeControlPlane:
    """接受 `POST /packages` 的本地 HTTP 服务，记录收到的请求路径。"""

    def __init__(self) -> None:
        self.paths: list[str] = []
        plane = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.rfile.read(int(self.headers["Content-Length"]))
                plane.paths.append(self.path)
                body = json.dumps({"name": "demo", "version": "1.0.0", "sha256": "0" * 64})
                self.send_response(201)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, *args: object) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def planes() -> Iterator[list[FakeControlPlane]]:
    started = [FakeControlPlane() for _ in range(3)]
    yield started
    for plane in started:
        plane.close()


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "sfly-home"
    home.mkdir()
    monkeypatch.setenv("SFLY_HOME", str(home))
    monkeypatch.delenv("SFLY_SERVER", raising=False)
    monkeypatch.delenv("SFLY_DEV_SOCKET", raising=False)
    monkeypatch.delenv("SFLY_WORK_DIR", raising=False)
    return home


def write_agent_env(home: Path, control_plane: str) -> None:
    (home / "agent.env").write_text(
        "# install.sh 写入的配置\n"
        "SFLY_SERVER=http://127.0.0.1:1\n"
        f'SFLY_CONTROL_PLANE_URL="{control_plane}"\n',
        encoding="utf-8",
    )


def test_publish_uses_the_control_plane_from_agent_env(
    home: Path, tmp_path: Path, planes: list[FakeControlPlane]
) -> None:
    archive = tmp_path / "demo-1.0.0.sflypkg"
    archive.write_bytes(b"archive")
    write_agent_env(home, planes[0].url)

    assert main(["publish", str(archive)]) == 0
    assert planes[0].paths == ["/packages"]


def test_server_option_and_environment_override_agent_env(
    home: Path, tmp_path: Path, planes: list[FakeControlPlane], monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / "demo-1.0.0.sflypkg"
    archive.write_bytes(b"archive")
    file_plane, env_plane, cli_plane = planes
    write_agent_env(home, file_plane.url)
    monkeypatch.setenv("SFLY_SERVER", env_plane.url)

    assert main(["publish", str(archive)]) == 0
    assert main(["publish", str(archive), "--server", cli_plane.url]) == 0
    assert (file_plane.paths, env_plane.paths, cli_plane.paths) == (
        [],
        ["/packages"],
        ["/packages"],
    )


def test_sfly_home_defaults_to_dot_sfly_in_the_home_directory(
    tmp_path: Path, planes: list[FakeControlPlane], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("SFLY_HOME", raising=False)
    monkeypatch.delenv("SFLY_SERVER", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    (tmp_path / "user" / ".sfly").mkdir(parents=True)
    write_agent_env(tmp_path / "user" / ".sfly", planes[0].url)
    archive = tmp_path / "demo-1.0.0.sflypkg"
    archive.write_bytes(b"archive")

    assert main(["publish", str(archive)]) == 0
    assert planes[0].paths == ["/packages"]


def dev_project(root: Path) -> Path:
    (root / "src" / "demo_dev").mkdir(parents=True)
    (root / "pyproject.toml").write_text(
        '[project]\nname = "demo-dev"\nversion = "0.1.0"\ndependencies = []\n', encoding="utf-8"
    )
    (root / "src" / "demo_dev" / "__init__.py").write_text(
        "from sfly import node\n\n@node\ndef about() -> dict:\n    return {}\n", encoding="utf-8"
    )
    return root


@contextmanager
def fake_agent(path: Path) -> Iterator[list[dict[str, object]]]:
    """在 `path` 上监听的假 Agent（本地 socket）：记录 `sfly dev` 发来的请求，回复加载成功。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    requests: list[dict[str, object]] = []
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(path))
        server.listen(1)
        server.settimeout(5)

        def serve() -> None:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            with conn:
                data = b""
                while chunk := conn.recv(65536):
                    data += chunk
                requests.append(json.loads(data))
                conn.sendall(b'{"ok": true, "message": "loaded demo-dev@dev"}\n')

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        yield requests
        thread.join(5)


def test_dev_connects_to_the_socket_under_sfly_home(
    home: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with fake_agent(home / "work" / "agent.sock") as requests:
        assert main(["dev", str(dev_project(tmp_path / "proj"))]) == 0

    assert [r["package"] for r in requests] == ["demo-dev"]
    assert "loaded demo-dev@dev" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("agent_env", "environment", "socket_at"),
    [
        # 与 Agent 的优先级相同：dev socket > 工作目录下的 agent.sock，
        # 每一项都是环境变量 > agent.env。
        ("SFLY_WORK_DIR={tmp}/work-file\n", {}, "work-file/agent.sock"),
        (
            "SFLY_WORK_DIR={tmp}/work-file\n",
            {"SFLY_WORK_DIR": "{tmp}/work-env"},
            "work-env/agent.sock",
        ),
        (
            "SFLY_DEV_SOCKET={tmp}/file.sock\n",
            {"SFLY_WORK_DIR": "{tmp}/work-env"},
            "file.sock",
        ),
        ("SFLY_DEV_SOCKET={tmp}/file.sock\n", {"SFLY_DEV_SOCKET": "{tmp}/env.sock"}, "env.sock"),
    ],
)
def test_dev_finds_the_socket_the_way_the_agent_does(
    home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    agent_env: str,
    environment: dict[str, str],
    socket_at: str,
) -> None:
    (home / "agent.env").write_text(agent_env.format(tmp=tmp_path), encoding="utf-8")
    for key, value in environment.items():
        monkeypatch.setenv(key, value.format(tmp=tmp_path))

    with fake_agent(tmp_path / socket_at) as requests:
        assert main(["dev", str(dev_project(tmp_path / "proj"))]) == 0

    assert [r["package"] for r in requests] == ["demo-dev"]
