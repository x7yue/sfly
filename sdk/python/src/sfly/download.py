"""产物下载（`ctx.artifacts.download` 的实现）。只用标准库（ADR 0002）。

只在节点第一次下载时才导入（urllib.request、http.client 不在执行器的启动路径上，#76）。

产物引用是控制面上的下载地址 `GET <控制面>/tasks/<任务 ID>/artifacts/<名称>`
（apps/server/src/http/artifact-routes.ts）：200 是文件内容，404 是产物不存在，
410 是运行已过保留期、产物被清理。下载直接访问这个地址，不经过 Agent。

任务凭据（#492）：Agent 把控制面随任务下发的任务凭据放进环境变量 `SFLY_TASK_TOKEN`，下载时带
`Authorization: Bearer`。它只对**控制面的地址**带——和 `SFLY_ARTIFACTS_URL`（Agent 给的产物地址前缀，
就是控制面）同一个协议、主机和端口的地址；产物引用可以是任何 http(s) 地址（节点输出里的引用来自
上游节点，上游节点能写任何东西），别的地址一律不带；控制面的地址重定向到别的地方时，跟着去的请求里
也不带（urllib 默认会把请求头带到重定向的新地址）。凭据只在这次任务尝试有效，
任务结束之后下载是 401。
"""

from __future__ import annotations

import http.client
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator, Mapping
from http.client import HTTPMessage
from pathlib import Path
from typing import IO
from urllib.parse import urlsplit

from sfly.context import ArtifactDownloadError, cancelled_error

_DEFAULT_PORTS = {"http": 80, "https": 443}

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
    task_token: str | None = None,
    control_plane_url: str | None = None,
) -> Path:
    """把产物引用 `ref` 的内容写到 `dest`，返回 `dest`。见 `Artifacts.download`。

    `task_token` 是任务凭据（`SFLY_TASK_TOKEN`），`control_plane_url` 是控制面的地址
    （`SFLY_ARTIFACTS_URL`）：只对和它同一个协议、主机和端口的地址带凭据（见模块说明）；
    任何一个没有（本地调试、旧版本控制面或 Agent 不下发）就不带。

    任务已经进入收尾时间（取消标记在）时一开头就抛出 `Cancelled`，不检查引用、不发请求、不写文件：
    和 `AgentSocket.call` 同一个口径。
    """
    if cancelled():
        raise cancelled_error("任务正在收尾，下载中止")
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
        credential = (
            _Credential(task_token, control_plane_url)
            if task_token and control_plane_url and _same_origin(ref, control_plane_url)
            else None
        )
        return _fetch(ref, url.netloc, target, retries, timeout, cancelled, credential)
    # 本地调试时产物引用是产物的本地文件路径。
    if Path(ref).is_file():
        return _write(target, lambda: _read_file(Path(ref)), cancelled)
    raise ArtifactDownloadError(
        f"产物引用无效：既不是 http(s) 下载地址，也不是已有的本地文件（{ref}）。"
        "产物引用来自 ctx.artifacts.save / ref 的返回值"
    )


def _origin(url: str) -> tuple[str, str, int | None] | None:
    """协议、主机（小写）和端口（没写的取协议的默认端口）；不是 http(s) 地址时为 None。"""
    try:
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return None
    if scheme not in _DEFAULT_PORTS or not host:
        return None
    return scheme, host, port if port is not None else _DEFAULT_PORTS[scheme]


def _same_origin(url: str, other: str) -> bool:
    origin = _origin(url)
    return origin is not None and origin == _origin(other)


class _Credential:
    """任务凭据和它可以发给的地址（控制面的地址）。"""

    def __init__(self, token: str, control_plane_url: str) -> None:
        self.token = token
        self.control_plane_url = control_plane_url

    def applies_to(self, url: str) -> bool:
        return _same_origin(url, self.control_plane_url)


class _KeepCredentialOnlyAtHome(urllib.request.HTTPRedirectHandler):
    """重定向到别的主机（或端口、协议）时去掉 `Authorization`。

    urllib 默认把原请求的头都带到重定向的新地址。"""

    def __init__(self, credential: _Credential | None) -> None:
        super().__init__()
        self._credential = credential

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> urllib.request.Request | None:
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and (
            self._credential is None or not self._credential.applies_to(newurl)
        ):
            new.headers.pop("Authorization", None)
            new.unredirected_hdrs.pop("Authorization", None)
        return new


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
                    raise cancelled_error("任务正在收尾，下载中止")
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
    credential: _Credential | None = None,
) -> Path:
    attempts = max(0, retries) + 1
    for attempt in range(attempts):
        try:
            return _write(target, lambda: _read_url(ref, host, timeout, credential), cancelled)
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
            raise cancelled_error("任务正在收尾，下载中止")
        time.sleep(min(left, _CANCEL_POLL))


def _read_url(
    ref: str, host: str, timeout: float, credential: _Credential | None = None
) -> Iterator[bytes]:
    """一次下载尝试：逐块产出响应体。

    可重试的失败抛 `_Transient`，其余抛 `ArtifactDownloadError`。
    """
    headers = {"accept-encoding": "identity"}
    if credential is not None:
        headers["Authorization"] = f"Bearer {credential.token}"
    request = urllib.request.Request(ref, headers=headers)
    try:
        response = urllib.request.build_opener(_KeepCredentialOnlyAtHome(credential)).open(
            request, timeout=timeout
        )
    except urllib.error.HTTPError as error:
        with error:
            status = error.code
        if status in (401, 403):
            raise ArtifactDownloadError(_refused(status, credential is not None, ref)) from None
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


def _refused(status: int, sent_credential: bool, ref: str) -> str:
    """控制面拒绝了下载（401、403）：不是网络问题，重试没有用。消息不带凭据。"""
    if sent_credential:
        return (
            f"下载产物被控制面拒绝（HTTP {status}）：任务凭据无效或已失效——"
            f"它只在这次任务尝试有效，任务结束、被取消或租约过期之后不能再下载，"
            f"也只能下载本项目任务的产物（{ref}）"
        )
    return (
        f"下载产物被控制面拒绝（HTTP {status}）：这次请求没有带任务凭据——"
        "产物地址不在控制面上，或者这台 Agent 没有下发任务凭据"
        f"（旧版本的 Agent 或控制面不下发）（{ref}）"
    )


def _describe(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}" if str(error) else type(error).__name__
