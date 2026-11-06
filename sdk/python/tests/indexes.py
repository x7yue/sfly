"""SDK 测试共用的桩（`sfly init` 及其生成的项目用；fixture 在 conftest.py）。

- `FakeControlPlane`：本地 HTTP 服务，提供 `sfly init` 读取的 `/sdk/project-settings`，
  以及 sfly 简单索引 `/simple/`（与控制面相同：只有 `sfly` 项目，wheel 从本仓库 sdk/python 构建）。
- `StaticServer.add_index` + `wheelhouse`：PEP 503 的「PyPI 镜像」桩。wheel 是把当前测试环境里
  已安装的发行版（pytest、ruff、jsonschema 及其依赖）重新打包出来的；当前环境没有安装的依赖
  （例如只在 Windows 上需要的 colorama）用空模块的同名 wheel 代替。
  生成的项目里 `uv sync` 只访问这两个桩，不访问外网。
- `uv_env()`：运行 uv 的环境——去掉开发者的 `UV_*` / `SFLY_*` 配置，独立的 uv 缓存，不下载 Python。
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import threading
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib import metadata
from pathlib import Path

from packaging.requirements import Requirement

SDK = Path(__file__).resolve().parents[1]


def normalize(name: str) -> str:
    """PEP 503 的项目名规范化。"""
    return re.sub(r"[-_.]+", "-", name).lower()


Route = Callable[[], tuple[int, str, bytes]]


class StaticServer:
    """按路径返回固定内容的本地 HTTP 服务，记录收到的请求路径。"""

    def __init__(self) -> None:
        self.routes: dict[str, Route] = {}
        self.requests: list[str] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                server.requests.append(self.path)
                self.wfile.write(self._head())

            def do_HEAD(self) -> None:
                # uv 下载 wheel 前先用 HEAD 探测是否支持 Range。
                self._head()

            def _head(self) -> bytes:
                route = server.routes.get(self.path.split("?", 1)[0])
                status, content_type, body = route() if route else (404, "text/plain", b"")
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return body

            def log_message(self, *args: object) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def add(self, path: str, content_type: str, body: bytes, status: int = 200) -> None:
        self.routes[path] = lambda: (status, content_type, body)

    def add_index(self, prefix: str, wheels: list[Path]) -> None:
        """在 `<prefix>/` 下提供 PEP 503 简单索引，wheel 文件在 `<prefix>/files/<文件名>`。"""
        projects: dict[str, list[Path]] = {}
        for wheel in wheels:
            projects.setdefault(normalize(wheel.name.split("-", 1)[0]), []).append(wheel)
            self.add(f"{prefix}/files/{wheel.name}", "application/octet-stream", wheel.read_bytes())
        root = "".join(f'<a href="{p}/">{p}</a><br/>\n' for p in sorted(projects))
        self.add(f"{prefix}/", "text/html", f"<html><body>\n{root}</body></html>\n".encode())
        for project, files in projects.items():
            links = "".join(
                f'<a href="{self.url}{prefix}/files/{w.name}'
                f'#sha256={hashlib.sha256(w.read_bytes()).hexdigest()}">{w.name}</a><br/>\n'
                for w in files
            )
            page = f"<html><body>\n{links}</body></html>\n".encode()
            self.add(f"{prefix}/{project}/", "text/html", page)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@dataclass
class FakeControlPlane:
    """`sfly init` 看到的控制面：项目配置与 sfly 简单索引。"""

    server: StaticServer
    version: str
    pypi_mirror: str | None = None
    python_install_mirror: str | None = None
    sfly_wheels: list[Path] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.url = self.server.url
        self.server.add_index("/simple", self.sfly_wheels)
        self.server.routes["/sdk/project-settings"] = lambda: (
            200,
            "application/json",
            json.dumps(
                {
                    "version": self.version,
                    "sfly_index_url": f"{self.url}/simple/",
                    "pypi_mirror": self.pypi_mirror,
                    "python_install_mirror": self.python_install_mirror,
                }
            ).encode(),
        )

    @property
    def requests(self) -> list[str]:
        return self.server.requests


# ---------------------------------------------------------------- wheel


def _wheel_bytes(entries: dict[str, tuple[bytes, int]], dist_info: str) -> bytes:
    """把（归档内路径 → 内容、权限）打成 wheel，RECORD 按内容重新生成。"""
    record = [
        f"{arc},sha256={base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()},{len(data)}"
        for arc, (data, _) in entries.items()
    ]
    record.append(f"{dist_info}/RECORD,,")
    entries = {**entries, f"{dist_info}/RECORD": (("\n".join(record) + "\n").encode(), 0o644)}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arc, (data, mode) in entries.items():
            info = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (mode & 0o777) << 16
            zf.writestr(info, data)
    return buffer.getvalue()


def _compressed_tag(tags: list[str]) -> str:
    parts: list[list[str]] = [[], [], []]
    for tag in tags:
        for i, part in enumerate(tag.split("-")):
            if part not in parts[i]:
                parts[i].append(part)
    return "-".join(".".join(p) for p in parts)


_SKIPPED_DIST_INFO = {"RECORD", "INSTALLER", "REQUESTED", "direct_url.json", "uv_cache.json"}


def repack(dist: metadata.Distribution, out: Path) -> Path:
    """把已安装的发行版重新打成 wheel。

    安装时生成的文件和入口脚本去掉，其他脚本（例如 ruff 的二进制）放进 `.data/scripts`。
    """
    files = dist.files or []
    dist_info = next(str(f.parent) for f in files if f.name == "METADATA")
    stem = dist_info.removesuffix(".dist-info")
    wheel_meta = dist.read_text("WHEEL") or ""
    tags = [line.split(":", 1)[1].strip() for line in wheel_meta.splitlines() if "Tag:" in line]
    generated = {ep.name for ep in dist.entry_points if ep.group.endswith("_scripts")}
    entries: dict[str, tuple[bytes, int]] = {}
    for file in files:
        if "__pycache__" in file.parts or file.suffix == ".pyc":
            continue
        path = Path(str(dist.locate_file(file))).resolve()
        if file.parts[0] == "..":
            if path.parent.name != "bin" or path.name in generated:
                continue
            arc = f"{stem}.data/scripts/{path.name}"
        elif str(file.parent) == dist_info and file.name in _SKIPPED_DIST_INFO:
            continue
        else:
            arc = file.as_posix()
        entries[arc] = (path.read_bytes(), path.stat().st_mode)
    wheel = out / f"{stem}-{_compressed_tag(tags)}.whl"
    wheel.write_bytes(_wheel_bytes(entries, dist_info))
    return wheel


def stub_wheel(requirement: Requirement, out: Path) -> Path:
    """空模块的同名 wheel，版本满足要求（取下限）。"""
    version = next(
        (s.version for s in requirement.specifier if s.operator in (">=", "==", "~=")), "1.0"
    )
    stem = f"{re.sub(r'[-_.]+', '_', requirement.name).lower()}-{version}"
    dist_info = f"{stem}.dist-info"
    meta = f"Metadata-Version: 2.1\nName: {requirement.name}\nVersion: {version}\n"
    wheel_meta = (
        "Wheel-Version: 1.0\nGenerator: sfly-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    )
    entries = {
        f"{dist_info}/METADATA": (meta.encode(), 0o644),
        f"{dist_info}/WHEEL": (wheel_meta.encode(), 0o644),
    }
    wheel = out / f"{stem}-py3-none-any.whl"
    wheel.write_bytes(_wheel_bytes(entries, dist_info))
    return wheel


def wheelhouse(requirements: list[str], out: Path) -> list[Path]:
    """requirements 及其全部依赖的 wheel：已安装的重新打包，没安装的用空模块代替。"""
    wheels: list[Path] = []
    seen: set[str] = set()
    queue = [Requirement(r) for r in requirements]
    while queue:
        requirement = queue.pop()
        key = normalize(requirement.name)
        if key in seen:
            continue
        seen.add(key)
        try:
            dist = metadata.distribution(requirement.name)
        except metadata.PackageNotFoundError:
            wheels.append(stub_wheel(requirement, out))
            continue
        wheels.append(repack(dist, out))
        for spec in dist.requires or []:
            dependency = Requirement(spec)
            marker = dependency.marker
            if marker is not None and "extra" in str(marker):
                if not any(marker.evaluate({"extra": e}) for e in requirement.extras):
                    continue
            queue.append(dependency)
    return wheels


def uv_env(tmp: Path) -> dict[str, str]:
    """运行 uv / sfly 的环境：不受开发者的 uv、sfly 配置和当前 venv 影响，不访问外网。"""
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("UV_", "SFLY_")) and k not in ("VIRTUAL_ENV", "PYTHONPATH")
    }
    env.update(
        UV_CACHE_DIR=str(tmp / "uv-cache"),
        UV_PYTHON_DOWNLOADS="never",
        # 不读开发者的 ~/.config/uv/uv.toml（UV_NO_CONFIG 会把项目的 [tool.uv] 也忽略）。
        XDG_CONFIG_HOME=str(tmp / "config"),
        SFLY_HOME=str(tmp / "sfly-home"),
    )
    return env
