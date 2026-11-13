"""产物下载（`ctx.artifacts.download` 的实现）。只用标准库（ADR 0002）。

只在节点第一次下载时才导入（urllib.request、http.client 不在执行器的启动路径上，#76）。

产物引用是控制面上的下载地址 `GET <控制面>/tasks/<任务 ID>/artifacts/<名称>`
（apps/server/src/http/artifact-routes.ts）：200 是文件内容，404 是产物不存在，
410 是运行已过保留期、产物被清理。下载直接访问这个地址，不经过 Agent。
"""

from __future__ import annotations

import http.client
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from urllib.parse import urlsplit

from sfly.context import ArtifactDownloadError, cancelled_error

#: 每次读写的块大小：内存占用与产物大小无关。
_CHUNK = 64 * 1024
#: 第一次重试前等待的秒数，之后每次加倍，不超过 `_MAX_DELAY`。
_FIRST_DELAY = 0.5
_MAX_DELAY = 8.0
#: 重试等待期间检查取消的间隔（秒）。
_CANCEL_POLL = 0.1
#: 值得重试的 HTTP 状态：服务端错误，以及请求超时、限流。
_RETRY_STATUS = frozenset({408, 429})


class _Transient(Exception):
    """这一次尝试失败了，重试可能成功（连不上、连接中断、服务端错误）。"""


def download(
    ref: object,
    dest: str | os.PathLike[str],
    *,
    retries: int,
    timeout: float,
    local: Mapping[str, str],
    cancelled: Callable[[], bool],
) -> Path:
    """把产物引用 `ref` 的内容写到 `dest`，返回 `dest`。见 `Artifacts.download`。"""
    if not isinstance(ref, str) or not ref.strip():
        raise ArtifactDownloadError(f"产物引用无效：应为非空字符串，实际是 {ref!r}")
    target = Path(dest)
    replaced = local.get(ref)
    if replaced is not None:
        source = Path(replaced)
        if not source.is_file():
            raise ArtifactDownloadError(f"本地调试为产物引用 {ref} 指定的文件不存在：{source}")
        return _write(target, lambda: _read_file(source), cancelled)

    url = urlsplit(ref)
    if url.scheme.lower() in ("http", "https"):
        if not url.hostname:
            raise ArtifactDownloadError(f"产物引用无效：下载地址里没有主机名（{ref}）")
        return _fetch(ref, url.netloc, target, retries, timeout, cancelled)
    # 本地调试时产物引用是产物的本地文件路径。
    if Path(ref).is_file():
        return _write(target, lambda: _read_file(Path(ref)), cancelled)
    raise ArtifactDownloadError(
        f"产物引用无效：既不是 http(s) 下载地址，也不是已有的本地文件（{ref}）。"
        "产物引用来自 ctx.artifacts.save / ref 的返回值"
    )


def _read_file(source: Path) -> Iterator[bytes]:
    with source.open("rb") as f:
        while chunk := f.read(_CHUNK):
            yield chunk


def _write(
    target: Path, chunks: Callable[[], Iterator[bytes]], cancelled: Callable[[], bool]
) -> Path:
    """把内容按块写到 `target` 旁边的临时文件，写完再改名：失败或取消时不留下半个文件。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    try:
        with part.open("wb") as out:
            for chunk in chunks():
                if cancelled():
                    raise cancelled_error("任务已取消，下载中止")
                out.write(chunk)
        os.replace(part, target)
    finally:
        part.unlink(missing_ok=True)
    return target


def _fetch(
    ref: str,
    host: str,
    target: Path,
    retries: int,
    timeout: float,
    cancelled: Callable[[], bool],
) -> Path:
    attempts = max(0, retries) + 1
    for attempt in range(attempts):
        try:
            return _write(target, lambda: _read_url(ref, host, timeout), cancelled)
        except _Transient as error:
            if attempt + 1 == attempts:
                tried = f"已重试 {attempts - 1} 次" if attempts > 1 else "未重试"
                raise ArtifactDownloadError(f"下载产物失败：{error}（{tried}；{ref}）") from None
            _sleep(min(_FIRST_DELAY * 2**attempt, _MAX_DELAY), cancelled)
    raise AssertionError("unreachable")


def _sleep(seconds: float, cancelled: Callable[[], bool]) -> None:
    deadline = time.monotonic() + seconds
    while (left := deadline - time.monotonic()) > 0:
        if cancelled():
            raise cancelled_error("任务已取消，下载中止")
        time.sleep(min(left, _CANCEL_POLL))


def _read_url(ref: str, host: str, timeout: float) -> Iterator[bytes]:
    """一次下载尝试：逐块产出响应体。

    可重试的失败抛 `_Transient`，其余抛 `ArtifactDownloadError`。
    """
    request = urllib.request.Request(ref, headers={"accept-encoding": "identity"})
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        with error:
            status = error.code
        if status == 404:
            raise ArtifactDownloadError(
                f"产物不存在（HTTP 404）：任务没有保存过这个产物，或产物还没有上传完"
                f"（产物在保存它的任务结束后才上传）（{ref}）"
            ) from None
        if status == 410:
            raise ArtifactDownloadError(
                f"产物已被清理（HTTP 410）：运行已过保留期（{ref}）"
            ) from None
        if status >= 500 or status in _RETRY_STATUS:
            raise _Transient(f"控制面返回 HTTP {status}") from None
        raise ArtifactDownloadError(f"下载产物失败：控制面返回 HTTP {status}（{ref}）") from None
    except urllib.error.URLError as error:
        raise _Transient(f"连不上控制面 {host}：{error.reason}") from None
    except (OSError, http.client.HTTPException) as error:
        raise _Transient(f"连不上控制面 {host}：{_describe(error)}") from None

    with response:
        length = response.headers.get("content-length")
        expected = int(length) if length is not None and length.isdigit() else None
        received = 0
        while True:
            try:
                # read1：有多少读多少（最多一块），不等凑满一块，慢速连接上也能及时响应取消。
                chunk = response.read1(_CHUNK)
            except (OSError, http.client.HTTPException) as error:
                raise _Transient(
                    f"连接中断（已收到 {received} 字节）：{_describe(error)}"
                ) from None
            if not chunk:
                break
            received += len(chunk)
            yield chunk
        if expected is not None and received != expected:
            raise _Transient(f"连接中断：只收到 {received} / {expected} 字节")


def _describe(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}" if str(error) else type(error).__name__
