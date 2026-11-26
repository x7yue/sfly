"""`sfly login` / `sfly logout`：用账号密码换一个个人令牌存在本机，之后平台命令都带着它
（ADR 0029「凭据」）。

- `sfly login`：问控制面地址、登录名和密码，向控制面换一个个人令牌，写进
  `$SFLY_HOME/credentials.json`（权限 0600，见 `credentials.py`）。密码不出现在命令行参数里
  （进程列表和 shell 历史里看得见）：在终端里不回显地输入，
  脚本里用 `--password-stdin` 从标准输入读一行。
  令牌的原值不打印。这台控制面已经存过令牌时，**先换到新的、存好，再把旧的吊销**（重新登录不会越攒越多；
  密码输错或换令牌失败时，原来有效的登录原封不动）。旧令牌占着默认名称时，新令牌的名称带一个后缀。
- `sfly logout`：让令牌吊销它自己（个人令牌只能吊销它自己），再删掉本机的这一条凭据。
  吊销没成功（连不上控制面、403、500……）就不删，免得本机以为登出了、令牌还有效，并说明
  令牌没有被吊销、本机的凭据保留着；`--local` 只删本机的。控制面说 401 时（令牌已失效：
  别处吊销了、过期了）本机的凭据照样删，但如实说「令牌没有被这次登出吊销」。账号被停用时令牌照样能吊销它自己
  （停用期间别的请求都拒绝，吊销自己的凭据例外），所以 401 不是因为账号被停用。
  `SFLY_API_TOKEN` 环境变量里的令牌不归它管。

控制面上令牌的范围不超过登录人此刻的角色；这里不限定项目（选项目的 `--project`
留给之后的多项目命令，不在同一个版本里换意思），要限定项目、范围用控制台的「令牌」页。
"""

from __future__ import annotations

import argparse
import getpass
import os
import socket
import sys
from collections.abc import Callable
from typing import Any

from sfly.cli import credentials
from sfly.cli.client import ApiError, Client, check_address, resolve_nickname, without_userinfo
from sfly.cli.errors import EXIT_ERROR, CliError
from sfly.cli.home import DEFAULT_SERVER, control_plane_url
from sfly.cli.output import Output

_NAME_MAX = 64


def _server_help() -> str:
    return (
        "控制面 HTTP 地址（默认 $SFLY_SERVER，其次 $SFLY_HOME/agent.env 的 "
        f"SFLY_CONTROL_PLANE_URL，都没有时 {DEFAULT_SERVER}）"
    )


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    login = sub.add_parser(
        "login",
        help="登录：用账号密码换一个个人令牌，存在本机（$SFLY_HOME/credentials.json，权限 0600）",
        description="问控制面地址、登录名和密码（密码在终端里不回显；"
        "脚本里用 --password-stdin 从标准输入读一行，"
        "密码不能写在命令行参数里），换一个个人令牌写进 $SFLY_HOME/credentials.json（权限 0600），"
        "之后 sfly 的平台命令（scenario、run、agent、package、api）都带着它。令牌的原值不打印。"
        "环境变量 SFLY_API_TOKEN 优先于这个文件（脚本、CI 里直接设它，不用登录）。"
        "这台控制面已经存过令牌时先换到新的、存好，再吊销旧的。"
        "退出码：成功 0，失败 2。",
    )
    login.add_argument("--server", help=_server_help())
    login.add_argument("--login-name", help="登录名（不给时在终端里问）")
    login.add_argument(
        "--password-stdin",
        action="store_true",
        help="从标准输入读一行密码（脚本用；密码不能写在命令行参数里）",
    )
    login.add_argument(
        "--name",
        help="令牌的名称（默认 sfly-cli@<主机名>）；记在你触发的运行和版本上的「经」字段里",
    )
    login.add_argument(
        "--scope",
        action="append",
        metavar="范围",
        help="令牌的范围（read、run、edit、session_build、publish、manage），可以重复给出；"
        "不给就是你此刻能有的全部范围；不能超过你此刻的角色",
    )
    login.add_argument(
        "--expires-in-days", type=int, metavar="天数", help="令牌多少天后过期（不给就不过期）"
    )
    login.add_argument("--json", action="store_true", help="输出 JSON，不输出文本")
    login.set_defaults(func=_run(_login))

    logout = sub.add_parser(
        "logout",
        help="登出：让本机存的令牌吊销它自己，并删掉本机的凭据",
        description="让 sfly login 存下的令牌吊销它自己（控制面上立即失效），"
        "再删掉本机凭据文件里这台控制面的那一条。"
        "吊销没成功（连不上控制面、控制面回 403、500……）时不删本机的凭据，并说明令牌没有被吊销、"
        "本机的凭据保留着；控制面回 401（令牌已经失效）时照样删本机的，并说明这次没有吊销。"
        "加 --local 只删本机的。"
        "SFLY_API_TOKEN 环境变量里的令牌不归它管。退出码：成功 0，失败 2。",
    )
    logout.add_argument("--server", help=_server_help())
    logout.add_argument(
        "--local",
        action="store_true",
        help="只删本机的凭据，不去控制面吊销（控制面不可达、或者吊销一直失败时用）",
    )
    logout.add_argument("--json", action="store_true", help="输出 JSON，不输出文本")
    logout.set_defaults(func=_run(_logout))


def _run(
    handler: Callable[[argparse.Namespace, Output], int],
) -> Callable[[argparse.Namespace], int]:
    def run(args: argparse.Namespace) -> int:
        out = Output(json_mode=args.json)
        try:
            return handler(args, out)
        except CliError as error:
            out.error(error)
            return EXIT_ERROR

    return run


def _interactive() -> bool:
    return sys.stdin.isatty()


def _ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        return ""


def _read_password(args: argparse.Namespace) -> str:
    if args.password_stdin:
        line = sys.stdin.readline().rstrip("\r\n")
        if not line:
            raise CliError("missing_password", "--password-stdin 没有从标准输入读到密码")
        return line
    if not _interactive():
        raise CliError(
            "missing_password",
            "没有终端可以输入密码：脚本里用 --password-stdin 从标准输入读，"
            "或者直接设环境变量 SFLY_API_TOKEN",
        )
    return getpass.getpass("密码：")


def _anonymous(url: str) -> Client:
    """换令牌用的客户端：不带令牌（`SFLY_API_TOKEN` 不该被发给控制面去换令牌）；发出去的是账号密码，
    往不是本机的 `http://` 地址发之前提示一次（明文）。"""
    return Client(url, resolve_nickname(None), sends_password=True)


def _login(args: argparse.Namespace, out: Output) -> int:
    server = args.server
    if server is None and _interactive():
        default = control_plane_url(None)
        server = _ask(f"控制面地址 [{without_userinfo(default)}]：") or default
    url = control_plane_url(server)
    check_address(url)
    login_name = (args.login_name or "").strip()
    if not login_name:
        if not _interactive():
            raise CliError("missing_login_name", "没有给登录名：加 --login-name，或在终端里运行")
        login_name = _ask("登录名：")
        if not login_name:
            raise CliError("missing_login_name", "登录名不能为空")
    # 这次换令牌发出去的是账号密码：地址是不是明文的 `http://`，在读密码之前就告诉他（交互时先出提示、再问密码，
    # 想放弃的人不用输完密码才知道）；客户端记着已经提示过，发请求时不再重复。
    client = _anonymous(url)
    client.note_plain_http()
    password = _read_password(args)
    name = (args.name or f"sfly-cli@{socket.gethostname()}")[:_NAME_MAX]

    # 这台控制面已经存过令牌：**先换到新的、存好，再吊销旧的**。
    # 反过来的话，密码输错、被限速、连不上的时候，
    # 原来有效的登录没了、新的又没签出来，之后的命令全是 401。
    previous = credentials.load(url)

    body: dict[str, Any] = {"name": name, "login_name": login_name, "password": password}
    if args.scope:
        body["scopes"] = list(args.scope)
    if args.expires_in_days is not None:
        body["expires_in_days"] = args.expires_in_days
    try:
        issued = _issue(client, body, retry_suffix=previous is not None)
    except ApiError as error:
        raise _login_error(error) from None
    path = credentials.save(
        url,
        credentials.StoredCredential(
            token=issued["token"],
            token_id=issued["id"],
            login_name=login_name,
            name=issued["name"],
            saved_at=credentials.now_iso(),
        ),
    )
    summary = {
        "server": url,
        "login_name": login_name,
        "token_name": issued["name"],
        "token_id": issued["id"],
        "prefix": issued["prefix"],
        "scopes": issued["scopes"],
        "expires_at": issued["expires_at"],
        "credentials_file": str(path),
    }
    # 新的已经存好了：吊销这台控制面上原来的那个（重新登录不会越攒越多）；
    # 失败（已失效、连不上）不挡着登录。
    if previous is not None:
        try:
            Client(url, resolve_nickname(None), token=previous.token).request(
                "DELETE", f"/account/tokens/{previous.token_id}"
            )
        except (CliError, OSError):
            pass
    expires = issued["expires_at"] or "不过期"
    out.emit(
        summary,
        f"已登录 {url}（{login_name}）：令牌 {issued['name']}（{issued['prefix']}…），"
        f"范围 {'、'.join(issued['scopes'])}，过期时间 {expires}\n凭据存在 {path}（权限 0600）",
    )
    return 0


def _issue(client: Client, body: dict[str, Any], *, retry_suffix: bool) -> dict[str, Any]:
    """用账号密码换一个令牌。已经有同名的有效令牌（`token_name_taken`）、而且本机原来存着一个（多半就是它占着默认名称）时，
    带一个后缀再换一次：旧的要等新的存好才吊销，这时两个同时存在。"""
    try:
        issued: dict[str, Any] = client.request("POST", "/account/tokens", body=body)
        return issued
    except ApiError as error:
        if not (retry_suffix and error.code == "token_name_taken"):
            raise
    suffix = "·新"
    renamed = {**body, "name": f"{str(body['name'])[: _NAME_MAX - len(suffix)]}{suffix}"}
    issued = client.request("POST", "/account/tokens", body=renamed)
    return issued


def _login_error(error: ApiError) -> CliError:
    """换令牌失败：登录名或密码不对、被限速、没有可签发的范围……各自说清楚怎么办。"""
    if error.code == "invalid_credentials":
        return CliError("invalid_credentials", "登录名或密码不对（账号被停用时也是这条）")
    if error.status == 429:
        return CliError("too_many_attempts", f"{error.message}", next="稍后再运行 sfly login")
    if error.code == "token_name_taken":
        return CliError(error.code, error.message, next="sfly login --name <另一个名字>")
    return CliError(error.code, error.message, error.next)


def _logout(args: argparse.Namespace, out: Output) -> int:
    url = control_plane_url(args.server)
    stored = credentials.load(url)
    from_env = bool(os.environ.get(credentials.TOKEN_ENV, "").strip())
    if stored is None:
        message = f"本机没有登录过 {without_userinfo(url)}（凭据文件里没有这台控制面的令牌）"
        if from_env:
            message += f"；环境变量 {credentials.TOKEN_ENV} 里的令牌不归 sfly logout 管"
        out.emit({"server": without_userinfo(url), "logged_out": False}, message)
        return 0
    revoked = False
    rejected = False
    if not args.local:
        try:
            Client(url, resolve_nickname(None), token=stored.token).request(
                "DELETE", f"/account/tokens/{stored.token_id}"
            )
            revoked = True
        except ApiError as error:
            # 401：令牌已经失效（别处吊销了、过期了）。账号被停用时令牌也能吊销它自己
            # （控制面对吊销自己的凭据不看停用），所以不是这个原因。本机的凭据照样删，
            # 但如实说令牌没有被这次登出吊销。别的错误（403、500……）照实说，不删本机的。
            if error.status == 401:
                rejected = True
            else:
                raise CliError(
                    error.code,
                    f"{error.message}\n令牌没有被吊销，本机的凭据保留着",
                    next="sfly logout --local（只删本机的凭据，令牌之后在控制台的「令牌」页吊销）",
                ) from None
        except CliError as error:
            raise CliError(
                error.code,
                f"{error.message}\n令牌没有被吊销，本机的凭据保留着",
                next="sfly logout --local（只删本机的凭据，令牌之后在控制台的「令牌」页吊销）",
            ) from None
    credentials.delete(url)
    note = (
        f"；环境变量 {credentials.TOKEN_ENV} 里的令牌不归 sfly logout 管，它还在用"
        if from_env
        else ""
    )
    text = (
        f"已登出 {without_userinfo(url)}："
        + ("令牌已吊销，" if revoked else "")
        + "本机的凭据已删除"
        + note
    )
    if rejected:
        text += (
            "\n注意：控制面拒绝了这次吊销（401）：令牌已经失效，或者已经被吊销了，这次登出没有吊销它。"
            "不放心的话，到控制台的「令牌」页（账号菜单里）核对，或者请管理员处理"
        )
    out.emit(
        {
            "server": without_userinfo(url),
            "logged_out": True,
            "revoked": revoked,
            "rejected": rejected,
        },
        text,
    )
    return 0
