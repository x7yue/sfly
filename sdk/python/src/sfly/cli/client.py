"""命令行访问控制面的公共部分：地址、昵称、`x-sfly-client`、HTTP 请求（只用标准库）和错误解析。

所有操作平台的命令都经 `Client` 发请求，不各自拼请求头、不各自处理错误：
- 地址：`--server` > `SFLY_SERVER` > `$SFLY_HOME/agent.env` 的 `SFLY_CONTROL_PLANE_URL` > 默认地址，
  和 `sfly publish` 共用 `home.control_plane_url`；
- 令牌：`SFLY_API_TOKEN` > 凭据文件里这台控制面的（`sfly login` 写的，见 `credentials.py`），
  放进 `Authorization: Bearer`；有令牌时身份由令牌决定，不再发昵称，`--nickname`、`SFLY_NICKNAME`
  被忽略并提示一次；
- 昵称（没有令牌时）：`--nickname` > `SFLY_NICKNAME` > 系统登录用户名，放进
  `x-sfly-nickname`（URL 编码）；
- 每个请求都带 `x-sfly-client: sfly-cli/<版本>`；在 AI 编程助手里运行时再追加 ` agent/<名称>`；
- 控制面在所有响应上带 `x-sfly-time`（控制面的当前时间，ADR 0018）；
  `Client.control_plane_time` 是最近一次响应带来的，命令里要算「已多久」时用它，不用本机时间；
- 控制面在所有响应上带 `x-sfly-version`；与命令行版本不一致时在 stderr 告警一次，命令照常执行；
- 连不上控制面抛 `CliError("unreachable", …)`，控制面返回错误抛 `ApiError`（沿用控制面的错误码）；
  401（没有登录、令牌失效或被吊销）的错误信息写明 `sfly login`，下一步也是它。
"""

from __future__ import annotations

import getpass
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from datetime import datetime
from email.message import Message
from http.client import HTTPException, HTTPResponse
from typing import IO, Any

from sfly import __version__
from sfly.cli import credentials
from sfly.cli.errors import CliError
from sfly.cli.home import control_plane_url

CLIENT_HEADER = "x-sfly-client"
NICKNAME_HEADER = "x-sfly-nickname"
VERSION_HEADER = "x-sfly-version"
TIME_HEADER = "x-sfly-time"

# 控制面不可达、版本告警提示里引用的取值说明。
ADDRESS_HELP = (
    "地址按 --server、SFLY_SERVER、$SFLY_HOME/agent.env 的 SFLY_CONTROL_PLANE_URL 的顺序取值"
)

_AGENT_NAME_MAX = 64

# 401 的提示：没有登录、令牌失效或被吊销时都是它。
LOGIN_HINT = "sfly login"
UNAUTHORIZED_TIP = (
    "没有登录，或者令牌已失效、已被吊销：运行 sfly login 登录"
    "（脚本、CI 里设置环境变量 SFLY_API_TOKEN）"
)

# 读响应（下载、事件流、接口原样输出）时每次读多少字节。
READ_CHUNK = 64 * 1024


def detect_ai_agent(environ: Mapping[str, str]) -> str | None:
    """当前是否在 AI 编程助手里运行，返回它的名称（规则与 gh 一致）：`AI_AGENT` 有值时用它；
    `CLAUDECODE` 表示 `claude-code`；`CODEX_` 开头的环境变量表示 `codex`；都没有时为 None。
    名称会被整理成请求头里安全的短标识（只留字母、数字、`.`、`_`、`-`）。"""
    if name := _header_token(environ.get("AI_AGENT", "")):
        return name
    if environ.get("CLAUDECODE"):
        return "claude-code"
    if any(key.startswith("CODEX_") for key in environ):
        return "codex"
    return None


def _header_token(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-")[:_AGENT_NAME_MAX]


def client_tag(ai_agent: str | None) -> str:
    """`x-sfly-client` 的值：`sfly-cli/<版本>`，在 AI 编程助手里时追加 ` agent/<名称>`。"""
    tag = f"sfly-cli/{__version__}"
    return f"{tag} agent/{ai_agent}" if ai_agent else tag


def resolve_nickname(nickname: str | None, environ: Mapping[str, str] = os.environ) -> str:
    """昵称：`--nickname` > `SFLY_NICKNAME` > 系统登录用户名（取不到时为 `sfly-cli`）。"""
    if name := (nickname or environ.get("SFLY_NICKNAME") or "").strip():
        return name
    try:
        return getpass.getuser().strip() or "sfly-cli"
    except (KeyError, OSError, ImportError):
        return "sfly-cli"


class ApiError(CliError):
    """控制面返回了错误响应。`code`、`message` 来自响应体 `{ error: { code, message, details? } }`，
    不是这个格式时为 `http_<状态码>`；`details` 是响应体里的 details（没有时为 None）。"""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Any = None,
        next: str | None = None,
    ) -> None:
        super().__init__(code, message, next)
        self.status = status
        self.details = details

    def replace(self, *, message: str | None = None, next: str | None = None) -> ApiError:
        """换掉说明或下一步的副本（状态码、错误码、details 不变）；没给的字段沿用原来的。"""
        return ApiError(
            self.status,
            self.code,
            self.message if message is None else message,
            self.details,
            self.next if next is None else next,
        )


class Client:
    def __init__(
        self,
        server: str,
        nickname: str,
        *,
        token: str | None = None,
        nickname_ignored: bool = False,
        ai_agent: str | None = None,
        stderr: IO[str] | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.server = server.rstrip("/")
        self.nickname = nickname
        self.token = token
        """有令牌时身份由它决定：请求带 `Authorization: Bearer`，不再带昵称。"""
        self.ai_agent = ai_agent
        self.timeout = timeout
        self._stderr = stderr
        self._warned_version = False
        # 用户明确给了昵称（`--nickname`、`SFLY_NICKNAME`），而这次用的是令牌：提示一次「被忽略」。
        self._nickname_ignored_pending = nickname_ignored and token is not None
        self._owner_name: str | None = None
        self.control_plane_time: datetime | None = None
        """最近一次响应的 `x-sfly-time`（控制面时间）；还没有响应或响应不带它时为 None。"""

    @classmethod
    def from_options(
        cls,
        server: str | None,
        nickname: str | None,
        *,
        environ: Mapping[str, str] = os.environ,
    ) -> Client:
        """按命令行选项、环境变量、凭据文件和 `agent.env` 创建（取值顺序见模块说明）。"""
        url = control_plane_url(server)
        resolved = credentials.resolve_token(url, environ)
        given_nickname = bool((nickname or "").strip() or environ.get("SFLY_NICKNAME", "").strip())
        return cls(
            url,
            resolve_nickname(nickname, environ),
            token=resolved.token if resolved else None,
            nickname_ignored=given_nickname,
            ai_agent=detect_ai_agent(environ),
        )

    def headers(self) -> dict[str, str]:
        """每个请求都带的请求头：有令牌时是 `Authorization: Bearer`，
        身份由令牌决定、不发昵称；没有令牌时是昵称。"""
        headers = {CLIENT_HEADER: client_tag(self.ai_agent), "Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        else:
            headers[NICKNAME_HEADER] = urllib.parse.quote(self.nickname, safe="")
        return headers

    def owner_name(self) -> str:
        """「自己」在运行记录里的名字（`latest` 用它找自己触发的最近一次运行）：没有令牌时是昵称，
        有令牌时是令牌所属用户的显示名（问控制面一次，之后记着）；
        项目令牌没有用户，抛 `CliError`。"""
        if not self.token:
            return self.nickname
        if self._owner_name is None:
            try:
                listing = self.get("/account/tokens")
            except ApiError as error:
                if error.status == 403:
                    raise CliError(
                        "token_without_user",
                        "这个令牌没有所属的用户（项目令牌），没有「自己触发的运行」可言："
                        "给出运行的 id，或用 sfly login 换成个人令牌",
                    ) from None
                raise
            self._owner_name = str(listing["user"]["display_name"])
        return self._owner_name

    def _note_nickname_ignored(self) -> None:
        if not self._nickname_ignored_pending:
            return
        self._nickname_ignored_pending = False
        print(
            "提示：身份由令牌决定，--nickname 和 SFLY_NICKNAME 被忽略。",
            file=self._stderr or sys.stderr,
        )

    def url(self, path: str, query: Mapping[str, Any] | None = None) -> str:
        """控制面上 `path`（以 `/` 开头，参数已编码）加查询参数的完整地址；值为 None 的参数省略。"""
        url = f"{self.server}{path}"
        pairs = {k: _query_value(v) for k, v in (query or {}).items() if v is not None}
        return f"{url}?{urllib.parse.urlencode(pairs)}" if pairs else url

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
    ) -> Any:
        """发一个 JSON 请求，返回解析后的响应体（没有响应体时为 None）。"""
        with self.open(method, path, query=query, body=body) as response:
            try:
                raw = response.read()
            except (OSError, HTTPException) as error:
                raise self._unreachable(error) from None
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            raise CliError(
                "invalid_response",
                f"控制面的响应不是 JSON（{method} {path}）",
                next=f"curl {self.url('/health')}",
            ) from None

    def get(self, path: str, query: Mapping[str, Any] | None = None) -> Any:
        return self.request("GET", path, query=query)

    def open(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> HTTPResponse:
        """发请求并返回打开的响应（调用方负责关闭），给流式读取（SSE、下载）用；
        失败时抛 `CliError`（连不上）或 `ApiError`（错误响应）。"""
        data = None
        self._note_nickname_ignored()
        send = {**self.headers(), **(headers or {})}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            send["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.url(path, query), data=data, method=method, headers=send
        )
        try:
            response: HTTPResponse = urllib.request.urlopen(
                request, timeout=timeout or self.timeout
            )
        except urllib.error.HTTPError as error:
            self._observe(error.headers)
            raise self._unauthorized(self._api_error(error)) from None
        except (urllib.error.URLError, OSError, HTTPException, ValueError) as error:
            reason = error.reason if isinstance(error, urllib.error.URLError) else error
            raise self._unreachable(reason) from None
        self._observe(response.headers)
        return response

    def _unreachable(self, reason: object) -> CliError:
        return CliError(
            "unreachable",
            f"无法连接控制面 {self.server}：{reason}\n{ADDRESS_HELP}",
            next=f"curl {self.url('/health')}",
        )

    def _observe(self, headers: Message[str, str]) -> None:
        """记下控制面时间；控制面版本和命令行不一致时在 stderr 告警一次（命令照常执行）。"""
        if sent := headers.get(TIME_HEADER):
            try:
                self.control_plane_time = datetime.fromisoformat(sent.replace("Z", "+00:00"))
            except ValueError:
                pass
        server_version = headers.get(VERSION_HEADER)
        if not server_version or server_version == __version__ or self._warned_version:
            return
        self._warned_version = True
        print(
            f"警告：sfly 命令行（{__version__}）与控制面（{server_version}）版本不一致，"
            "可能不兼容。升级：重新运行 install.sh --dev，"
            f'或在项目里 uv add --dev "sfly[cli]=={server_version}"',
            file=self._stderr or sys.stderr,
        )

    def _api_error(self, error: urllib.error.HTTPError) -> ApiError:
        text = error.read().decode("utf-8", "replace")
        status = error.code
        next_command = f"curl {self.url('/health')}" if status >= 500 else None
        if parsed := parse_error_body(text):
            code, message, details = parsed
            return ApiError(status, code, message, details, next_command)
        snippet = text.strip()[:200]
        detail = f"：{snippet}" if snippet else ""
        return ApiError(
            status, f"http_{status}", f"控制面返回 HTTP {status}{detail}", None, next_command
        )

    def _unauthorized(self, error: ApiError) -> ApiError:
        """401：没有登录、令牌失效或被吊销，错误信息和下一步都写明 `sfly login`。
        登录名或密码不对（`invalid_credentials`）是另一回事，`sfly login` 自己处理，
        不加这条提示。"""
        if error.status != 401 or error.code == "invalid_credentials":
            return error
        return error.replace(message=f"{error.message}。{UNAUTHORIZED_TIP}", next=LOGIN_HINT)


def parse_error_body(text: str) -> tuple[str, str, Any] | None:
    """解析控制面的错误响应体 `{ error: { code, message, details? } }`，
    返回 (code, message, details)；不是这个格式时返回 None。"""
    try:
        error = json.loads(text).get("error")
    except (ValueError, AttributeError):
        return None
    if not isinstance(error, dict):
        return None
    code, message = error.get("code"), error.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        return None
    return code, message, error.get("details")


def segment(value: str) -> str:
    """路径里的一段（场景 id、运行 id……）编码后再拼进 `Client` 的 `path`。"""
    return urllib.parse.quote(value, safe="")


def _query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)
