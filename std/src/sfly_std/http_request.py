"""`http_request`：发一个 HTTP 请求，断言状态码与响应 JSON，可重试直到满足。

断言格式（`expect_json`）与 `assert` 节点相同，定义在 `_assertions.py`。
用法见开发文档「标准节点」页（docs/guide/standard-nodes.md）的 `http_request` 一节。
"""

from __future__ import annotations

import json as jsonlib
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

import httpx

from sfly import Context, Metric, node
from sfly_std import _waiting
from sfly_std._assertions import Assertion, check, describe, validate
from sfly_std._waiting import DEFAULT_POLL, DEFAULT_WAIT, poll_until

#: 输出里响应内容（json 或 text）JSON 序列化后的最大字节数：json 超过时改为输出 text，
#: text 超过时只保留开头。按序列化后的大小算，是因为控制字符会转义成 \u00XX（6 字节）、
#: 1e15 这样的数会写成 1000000000000000.0，按原始字节限制可能让输出超过 1 MB 上限。
BODY_OUTPUT_BYTES = 256 * 1024
#: 输出里响应头（名字和值的字符数之和）的上限：超过时只保留前面的响应头。
HEADERS_OUTPUT_CHARS = 64 * 1024
#: 失败信息里附带的响应开头的最大字符数。
RESPONSE_PREVIEW_CHARS = 1000

Method = Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]


class _Required(TypedDict):
    status: int
    headers: dict[str, str]
    elapsed_ms: float


class HttpResponse(_Required, total=False):
    json: Any
    text: str


class ExpectationFailed(Exception):
    """响应的状态码或 JSON 不满足断言。"""


class RequestFailed(Exception):
    """请求没有得到响应：连接失败、超时、TLS 校验失败等。"""


_STATUS_CLASS = re.compile(r"[1-5]xx")


def _status_patterns(expect_status: int | str | Sequence[int | str]) -> list[int | str]:
    """检查 `expect_status` 的写法，统一成列表；写法不对时抛出 ValueError。"""
    patterns = [expect_status] if isinstance(expect_status, (int, str)) else list(expect_status)
    if not patterns:
        raise ValueError("expect_status 至少要有一项")
    for pattern in patterns:
        if isinstance(pattern, bool) or not isinstance(pattern, (int, str)):
            raise ValueError(f"expect_status 只能是状态码或 1xx～5xx，实际有 {pattern!r}")
        if isinstance(pattern, int) and not 100 <= pattern <= 599:
            raise ValueError(f"expect_status 的状态码必须在 100～599 之间，实际是 {pattern}")
        if isinstance(pattern, str) and not _STATUS_CLASS.fullmatch(pattern):
            hint = f"（状态码写成数字 {pattern}）" if pattern.isdigit() else ""
            raise ValueError(
                "expect_status 的文本只能是 1xx～5xx（小写），"
                f"实际是 {jsonlib.dumps(pattern)}{hint}"
            )
    return patterns


def _status_ok(status: int, patterns: list[int | str]) -> bool:
    return any(status == p if isinstance(p, int) else str(status)[0] == p[0] for p in patterns)


@node(
    title="HTTP 请求",
    metrics=[Metric("elapsed_ms", unit="ms", description="请求耗时")],
    primary_metric="elapsed_ms",
)
def http_request(
    ctx: Context,
    url: str,
    method: Method = "GET",
    headers: dict[str, str] | None = None,
    json: Any = None,
    body: str | None = None,
    request_timeout: float = 30,
    verify_tls: bool = True,
    expect_status: int | str | Sequence[int | str] = "2xx",
    expect_json: Sequence[Assertion] = (),
    until_ok: bool = False,
    wait: float = DEFAULT_WAIT,
    poll: float = DEFAULT_POLL,
) -> HttpResponse:
    """发一个 HTTP 请求，检查状态码（`expect_status`，默认 2xx）和响应 JSON（`expect_json`）。

    - `json` 作为 JSON 请求体发送，`body` 作为 UTF-8 文本发送，只能填一个；不跟随重定向；
    - `request_timeout`：单次请求最多等多少秒；`verify_tls`：是否校验 HTTPS 证书；
    - `expect_status`：状态码或 `1xx`～`5xx`，可以是列表；
    - `expect_json`：断言列表，格式与 `assert` 节点相同；
    - `until_ok`：打开时，没有响应或断言不通过就每 `poll` 秒重试，直到通过或超过 `wait` 秒。

    输出状态码、响应头、`json`（响应是 JSON 且序列化后不超过 256 KiB 时）或 `text`
    （序列化后最多 256 KiB，超过时只保留开头）、耗时（毫秒，也上报为指标 `elapsed_ms`）。
    不满足时失败，错误信息带上状态码和不通过的断言。
    """
    if json is not None and body is not None:
        raise ValueError("json 和 body 只能填一个")
    if request_timeout <= 0:
        raise ValueError("request_timeout 必须大于 0")
    _waiting.validate(wait, poll)
    statuses = _status_patterns(expect_status)
    validate(expect_json)
    request = _Request(
        method, url, headers, json, body.encode() if body is not None else None, request_timeout
    )
    with httpx.Client(timeout=request_timeout, verify=verify_tls) as client:

        def attempt() -> HttpResponse:
            """发一次请求并检查；不满足时抛出 RequestFailed / ExpectationFailed。"""
            response, elapsed_ms = request.send(client)
            ctx.metric("elapsed_ms", elapsed_ms)
            outputs, parsed = _outputs(ctx, response, elapsed_ms)
            problem = _problem(response, parsed, statuses, expect_json)
            if problem is not None:
                raise ExpectationFailed(f"{method} {url} 状态码 {response.status_code}，{problem}")
            return outputs

        if not until_ok:
            return attempt()

        attempts = 0
        last: RequestFailed | ExpectationFailed | None = None

        def retry() -> HttpResponse | None:
            nonlocal attempts, last
            attempts += 1
            try:
                return attempt()
            except (RequestFailed, ExpectationFailed) as error:
                if last is None or str(error) != str(last):  # 原因没变时不重复打日志
                    ctx.log.info("第 %d 次不满足，%g 秒后重试：%s", attempts, poll, error)
                last = error
                return None

        try:
            outputs, _ = poll_until(retry, what="请求满足", wait=wait, poll=poll)
        except TimeoutError:
            assert last is not None
            raise type(last)(f"{wait:g} 秒内 {attempts} 次请求都不满足，最后一次：{last}") from None
        return outputs


@dataclass(frozen=True)
class _Request:
    method: str
    url: str
    headers: dict[str, str] | None
    json: Any
    content: bytes | None
    timeout: float

    def send(self, client: httpx.Client) -> tuple[httpx.Response, float]:
        """发一次请求，返回响应和耗时（毫秒）；没有得到响应时抛出 RequestFailed。"""
        started = time.monotonic()
        try:
            response = client.request(
                self.method, self.url, headers=self.headers, json=self.json, content=self.content
            )
        except httpx.TimeoutException:
            raise RequestFailed(
                f"{self.method} {self.url} 请求超时（request_timeout {self.timeout:g} 秒）"
            ) from None
        except httpx.TransportError as error:
            raise RequestFailed(f"{self.method} {self.url} 请求失败：{error}") from None
        return response, round((time.monotonic() - started) * 1000, 3)


def _outputs(ctx: Context, response: httpx.Response, elapsed_ms: float) -> tuple[HttpResponse, Any]:
    """节点的输出，以及解析出的完整 JSON（不是 JSON 时为 _NOT_JSON）。"""
    outputs: HttpResponse = {
        "status": response.status_code,
        "headers": _headers(ctx, response),
        "elapsed_ms": elapsed_ms,
    }
    parsed = _parse_json(response)
    if parsed is not _NOT_JSON and _fits(parsed, BODY_OUTPUT_BYTES):
        outputs["json"] = parsed
        return outputs, parsed
    text = _serialized_head(response.text, BODY_OUTPUT_BYTES)
    if len(text) < len(response.text):
        ctx.log.warn(
            "响应共 %d 字节，输出 text 只保留开头 %d 个字符（JSON 序列化后 256 KiB）",
            len(response.content),
            len(text),
        )
    elif parsed is not _NOT_JSON:
        ctx.log.warn("响应是 JSON，但序列化后超过 256 KiB，改为输出 text")
    outputs["text"] = text
    return outputs, parsed


def _fits(value: Any, limit: int) -> bool:
    """value 写进节点输出后是否不超过 limit 字节；边序列化边累计，超过就停，不整份序列化大响应。"""
    size = 0
    for chunk in jsonlib.JSONEncoder(ensure_ascii=False).iterencode(value):
        size += len(chunk.encode())
        if size > limit:
            return False
    return True


def _serialized_size(value: Any) -> int:
    """value 写进节点输出（JSON，不转义非 ASCII 字符）后占的字节数；字符串不算两边的引号。"""
    size = len(jsonlib.dumps(value, ensure_ascii=False).encode())
    return size - 2 if isinstance(value, str) else size


def _serialized_head(text: str, limit: int) -> str:
    """text 最长的开头，写进节点输出后不超过 limit 字节。"""
    # 每个字符序列化后至少 1 字节：合格的开头不超过 limit 个字符。二分找最长的。
    if len(text) <= limit and _serialized_size(text) <= limit:
        return text
    low, high = 0, min(len(text), limit)
    while low < high:
        middle = (low + high + 1) // 2
        if _serialized_size(text[:middle]) <= limit:
            low = middle
        else:
            high = middle - 1
    return text[:low]


def _headers(ctx: Context, response: httpx.Response) -> dict[str, str]:
    """输出的响应头：按顺序保留，名字和值的字符数之和不超过 HEADERS_OUTPUT_CHARS。"""
    headers: dict[str, str] = {}
    size = 0
    for name, value in response.headers.items():
        size += len(name) + len(value)
        if size > HEADERS_OUTPUT_CHARS:
            total = sum(len(k) + len(v) for k, v in response.headers.items())
            ctx.log.warn(
                "响应头共 %d 个、%d 字符，输出 headers 只保留前 %d 个（64 KiB）",
                len(response.headers),
                total,
                len(headers),
            )
            break
        headers[name] = value
    return headers


_NOT_JSON = object()


def _parse_json(response: httpx.Response) -> Any:
    """响应内容解析成的 JSON 值；不是 JSON 时返回 _NOT_JSON。"""
    try:
        return jsonlib.loads(response.content)
    except ValueError:
        return _NOT_JSON


def _problem(
    response: httpx.Response,
    parsed: Any,
    statuses: list[int | str],
    expect_json: Sequence[Assertion],
) -> str | None:
    """响应不满足断言的原因（接在「状态码 N，」之后）；满足时返回 None。"""
    head = response.text[:RESPONSE_PREVIEW_CHARS]
    head = f"\n\n响应开头：\n{head}" if head else ""
    if not _status_ok(response.status_code, statuses):
        expected = jsonlib.dumps(statuses, ensure_ascii=False)
        return f"不在 expect_status {expected} 中{head}"
    if not expect_json:
        return None
    if parsed is _NOT_JSON:
        return f"响应不是 JSON，无法检查 expect_json{head}"
    failures = check(parsed, expect_json)
    return describe(failures, len(expect_json)) if failures else None
