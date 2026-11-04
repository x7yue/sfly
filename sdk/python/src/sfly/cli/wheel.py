"""构建纯 Python wheel（py3-none-any）：用户代码 + dist-info（依赖写入 Requires-Dist）。

不依赖用户的构建后端，构建结果可复现（文件排序、固定时间戳）。
"""

from __future__ import annotations

import base64
import hashlib
import re
import zipfile
from collections.abc import Mapping, Sequence
from pathlib import Path

from sfly import __version__

_EPOCH = (1980, 1, 1, 0, 0, 0)


def dist_name(name: str) -> str:
    """wheel 文件名里的发行包名（PEP 427 / PEP 503 规范化）。"""
    return re.sub(r"[-_.]+", "_", name).lower()


def _record_hash(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return f"sha256={digest.decode('ascii')}"


def _source_files(source: Path) -> list[tuple[str, Path]]:
    """返回 (wheel 内路径, 源文件)。source 是包目录或单个 .py 模块。"""
    if source.is_file():
        return [(source.name, source)]
    files = []
    for path in sorted(source.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts or path.suffix in (".pyc", ".pyo"):
            continue
        files.append((path.relative_to(source.parent).as_posix(), path))
    return files


def build_wheel(
    *,
    name: str,
    version: str,
    requires_python: str,
    dependencies: Sequence[str],
    source: Path,
    out_dir: Path,
    extra_metadata: Mapping[str, bytes] | None = None,
) -> Path:
    """构建 wheel。`extra_metadata` 是额外写入 dist-info 目录的文件（文件名 → 内容）。"""
    dist = dist_name(name)
    file_version = version.replace("-", "_")
    info = f"{dist}-{file_version}.dist-info"
    metadata = [
        "Metadata-Version: 2.1",
        f"Name: {name}",
        f"Version: {version}",
        f"Requires-Python: {requires_python}",
        *(f"Requires-Dist: {dep}" for dep in dependencies),
    ]
    wheel_info = [
        "Wheel-Version: 1.0",
        f"Generator: sfly {__version__}",
        "Root-Is-Purelib: true",
        "Tag: py3-none-any",
    ]
    entries: list[tuple[str, bytes]] = [
        (arc, path.read_bytes()) for arc, path in _source_files(source)
    ]
    entries.append((f"{info}/METADATA", ("\n".join(metadata) + "\n").encode("utf-8")))
    entries.append((f"{info}/WHEEL", ("\n".join(wheel_info) + "\n").encode("utf-8")))
    for file_name, data in sorted((extra_metadata or {}).items()):
        entries.append((f"{info}/{file_name}", data))
    record = [f"{arc},{_record_hash(data)},{len(data)}" for arc, data in entries]
    record.append(f"{info}/RECORD,,")
    entries.append((f"{info}/RECORD", ("\n".join(record) + "\n").encode("utf-8")))

    out_dir.mkdir(parents=True, exist_ok=True)
    wheel = out_dir / f"{dist}-{file_version}-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arc, data in entries:
            zi = zipfile.ZipInfo(arc, date_time=_EPOCH)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            zf.writestr(zi, data)
    return wheel
