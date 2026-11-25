"""`sfly agent`：各台 Agent 的在线状态（`list`）、Agent 凭据（`credentials`）和我的开发 Agent
（`register-dev`、`revoke-dev`）。

**Agent 凭据**（`sfly_agt_` 开头，按「项目 + Agent 名字」签发，ADR 0029「凭据」，#492）：
管理员为每台 Agent 签发一个，Agent 用它连控制面、下载节点包归档、上传产物；
只对签发时指定的那个名字有效。签发的原值只在这一次的输出里出现（控制面只存哈希），所以：

- 要交给安装命令时用 `--token-only`：stdout 只有原值一行，管道交给远程机器的 `read`，
  不经过命令行参数和 shell 历史；
- 文本输出把原值单独写在一行（方便复制），别的说明写在它前后；`--json` 带 `token` 字段。

**开发 Agent**：开发机上的 Agent（联调节点包用），名字由控制面按「`dev-<登录名>-<主机>`」生成，
请求里不能给；凭据记在登录的这个人名下，要有登录（`sfly login`）或 `SFLY_API_TOKEN`，
没有时退出码 5。
"""

from __future__ import annotations

import argparse
import re
import socket
from datetime import datetime
from typing import Any

from sfly.cli.client import segment
from sfly.cli.errors import CliError
from sfly.cli.output import add_limit_option, apply_limit, format_table, more_note
from sfly.cli.run_view import parse_time
from sfly.cli.session import Session, command, common_options

# 没有登录凭据（没有 `SFLY_API_TOKEN`，凭据文件里也没有这台控制面的令牌）：
# `register-dev` 以这个退出码结束，安装脚本据此决定是走 `sfly login` 还是直接失败
# （不能和别的失败混在一起）。
EXIT_NOT_LOGGED_IN = 5
# 开发 Agent 注册到哪个项目：现在 Agent 都在默认项目里（路径带项目的命令之后随 #488 一起）。
_PROJECT = "default"
# 开发 Agent 名字里「主机」那一段的上限
# （`DEV_AGENT_HOST_MAX`，`packages/schema/src/http/agents.ts`）。
_HOST_MAX = 32


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = sub.add_parser(
        "agent",
        help="查看平台上的 sfly Agent，管理 Agent 凭据，注册我的开发 Agent",
        description="查看控制面上注册过的 sfly Agent（list）；"
        "为 Agent 签发、列出、吊销凭据（credentials，要「管理」范围）；"
        "在开发机上注册我的开发 Agent（register-dev、revoke-dev，名字由控制面生成）。"
        "默认输出精简文本，--json 输出 JSON。退出码：成功 0，命令出错 2，"
        "register-dev 没有登录凭据 5。",
    )
    group = parser.add_subparsers(dest="agent_command", required=True)
    p_list = group.add_parser(
        "list",
        parents=[common_options()],
        help="列出 sfly Agent：在线状态、版本、是否与控制面一致、运行中的任务数、对外地址",
        description="列出注册过的 sfly Agent，按名称排序。"
        "版本与控制面不一致的 Agent 不会被派新任务，它手上的任务照常跑完。"
        "刚连上、还在准备环境（准备 Python 运行环境和 SDK）的 Agent，"
        "状态写「在线（准备环境中，已 N 分 N 秒）」，这期间任务排队等它准备好；"
        "--json 的 preparing_since 是开始准备环境的时间，准备好或离线时为 null。"
        "「开发包」是用 sfly dev 在这台 Agent 上加载的节点包（包名@dev）。"
        "超过 --limit 时提示还有多少台。",
    )
    add_limit_option(p_list)
    p_list.set_defaults(func=command(_list))
    _register_credentials(group)
    _register_dev(group)


def _address(agent: dict[str, Any]) -> str | None:
    endpoint = agent["endpoint"]
    if not endpoint["address"]:
        return None
    port = endpoint["port"]
    return f"{endpoint['address']}:{port}" if port is not None else str(endpoint["address"])


def _elapsed(seconds: float) -> str:
    """`45 秒`、`2 分 10 秒`、`1 小时 2 分`：只写最大的两个单位。"""
    total = max(int(seconds), 0)
    minutes, rest = divmod(total, 60)
    if minutes == 0:
        return f"{rest} 秒"
    hours, minutes = divmod(minutes, 60)
    if hours == 0:
        return f"{minutes} 分 {rest} 秒"
    return f"{hours} 小时 {minutes} 分"


def _status(agent: dict[str, Any], now: datetime | None) -> str:
    """状态列：离线、在线；在线且正在准备环境时写明已准备多久（按控制面时间，没拿到控制面时间时不写时长）。"""
    if agent["status"] != "online":
        return "离线"
    since = agent["preparing_since"]
    if since is None:
        return "在线"
    if now is None:
        return "在线（准备环境中）"
    seconds = (now - parse_time(since)).total_seconds()
    return f"在线（准备环境中，已 {_elapsed(seconds)}）"


def _list(session: Session, args: argparse.Namespace) -> None:
    listing = session.client.get("/agents")
    control_plane = listing["control_plane_version"]
    agents = listing["agents"]
    now = session.client.control_plane_time
    shown, hidden = apply_limit(agents, args.limit)
    rows = [
        {
            "name": a["name"],
            "status": a["status"],
            "agent_version": a["info"]["agent_version"],
            "version_matches": not a["version_mismatch"],
            "running_tasks": len(a["running_tasks"]),
            "slots": a["info"]["slots"],
            "preparing_since": a["preparing_since"],
            "address": _address(a),
            "dev_packages": [d["name"] for d in a["dev_packages"]],
            "last_seen_at": a["last_seen_at"],
        }
        for a in shown
    ]
    if rows:
        text = format_table(
            ["Agent", "状态", "版本", "与控制面一致", "运行中任务", "对外地址", "开发包"],
            [
                [
                    r["name"],
                    _status(r, now),
                    r["agent_version"],
                    "是" if r["version_matches"] else f"否（控制面 {control_plane}）",
                    f"{r['running_tasks']}/{r['slots']}",
                    r["address"] or "-",
                    ", ".join(r["dev_packages"]) or "-",
                ]
                for r in rows
            ],
        )
    else:
        text = "还没有 sfly Agent 连接过控制面"
    session.out.emit(rows, text, note=more_note(hidden, len(agents), "台 Agent"))


# ---------------------------------------------------------------- Agent 凭据


def _register_credentials(group: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    creds = group.add_parser(
        "credentials",
        help="Agent 凭据：为一台 Agent 签发、列出、吊销（要「管理」范围）",
        description="Agent 凭据（sfly_agt_ 开头）按台签发：只对签发时指定的名字有效，"
        "Agent 用它连控制面、"
        "下载节点包、上传产物。同一台 Agent 可以同时有几个有效的凭据（轮换：先签发新的、"
        "换进那台 Agent 的 agent.env、重启它，再吊销旧的）。"
        "第一次给 Agent 签发之前要先有管理员账号并登录（sfly login）。",
    )
    sub = creds.add_subparsers(dest="credentials_command", required=True)

    issue = sub.add_parser(
        "issue",
        parents=[common_options()],
        help="为一台 Agent 签发一个凭据（原值只显示这一次）",
        description="为名为 <名称> 的 Agent 签发一个凭据。"
        "原值只在这次的输出里出现（控制面只存哈希，丢了只能重新签发）。"
        "交给安装命令时不要写在命令行参数里（进程列表、shell 历史里看得见）："
        "用 --token-only 往 stdout 只写原值一行，"
        "管道交给安装命令读，例如 "
        "sfly agent credentials issue worker-1 --token-only | ssh worker-1 "
        "'read -r SFLY_TOKEN && export SFLY_TOKEN && "
        "curl -fsSL <控制面>/install.sh | sh -s -- --name worker-1'。"
        "退出码：成功 0，失败 2。",
    )
    issue.add_argument("name", metavar="名称", help="Agent 的名称（凭据只对这个名字有效）")
    issue.add_argument(
        "--token-only",
        action="store_true",
        help="stdout 只写凭据原值一行（给管道用），别的说明写到 stderr；不能和 --json 一起用",
    )
    issue.set_defaults(func=command(_issue))

    listing = sub.add_parser(
        "list",
        parents=[common_options()],
        help="列出一台 Agent 的凭据（前缀、状态、最后使用时间，不含原值）",
        description="列出名为 <名称> 的 Agent 的全部凭据（含已吊销的），从新到旧。"
        "不含原值：前缀只够认出是哪一个。",
    )
    listing.add_argument("name", metavar="名称", help="Agent 的名称")
    listing.set_defaults(func=command(_list_credentials))

    revoke = sub.add_parser(
        "revoke",
        parents=[common_options()],
        help="吊销一台 Agent 的一个凭据（立即失效，用它连着的连接断开）",
        description="吊销名为 <名称> 的 Agent 的凭据 <id>"
        "（sfly agent credentials list <名称> 里看 id）：立即失效，"
        "用它连着的 Agent 连接被断开，那台 Agent 手上的任务的任务凭据也立刻不认。"
        "已经吊销的再吊销不变。轮换时先让新凭据连上，再吊销旧的。",
    )
    revoke.add_argument("name", metavar="名称", help="Agent 的名称")
    revoke.add_argument("id", metavar="凭据 id", help="凭据的 id（credentials list 里的第一列）")
    revoke.set_defaults(func=command(_revoke))


def _one_form(args: argparse.Namespace, flag: str) -> None:
    """`--json` 和 `--token-only`、`--env` 是三种不同的输出格式，只能选一种。"""
    if args.json and getattr(args, flag.lstrip("-").replace("-", "_")):
        raise CliError("invalid_arguments", f"--json 和 {flag} 是两种输出格式，只能给一个")


def _issue(session: Session, args: argparse.Namespace) -> None:
    _one_form(args, "--token-only")
    issued = session.client.request("POST", f"/agents/{segment(args.name)}/credentials", body={})
    token = issued["token"]
    if args.token_only:
        # 原值一行写到 stdout，别的话写到 stderr：管道里只有原值。
        print(token, file=session.out.stdout)
        prefix = issued["credential"]["prefix"]
        print(
            f"已为 {args.name} 签发凭据 {prefix}…（原值只显示这一次，已经写到 stdout）",
            file=session.out.stderr,
        )
        return
    install = (
        f"curl -fsSL {session.client.url('/install.sh')} | sh -s -- --name {_quote(args.name)}"
    )
    text = "\n".join(
        [
            f"已为 {args.name} 签发凭据 {issued['credential']['prefix']}…",
            "凭据（原值只显示这一次，控制面只存哈希，丢了只能重新签发）：",
            token,
            "装到这台 Agent 上，用环境变量传凭据（不要写在命令行参数里）：",
            "  read -rs SFLY_TOKEN && export SFLY_TOKEN",
            f"  {install}",
            "批量或远程安装时用 --token-only 经管道交给远程的 read，"
            "见 sfly agent credentials issue --help",
        ]
    )
    session.out.emit({"name": args.name, **issued}, text)


def _quote(value: str) -> str:
    """shell 单引号写法（名字里有特殊字符时，打印出来的命令可以直接复制运行）。"""
    if re.fullmatch(r"[A-Za-z0-9._/@:+=-]+", value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


def _credential_state(credential: dict[str, Any]) -> str:
    return "已吊销" if credential["revoked_at"] else "有效"


def _list_credentials(session: Session, args: argparse.Namespace) -> None:
    listing = session.client.get(f"/agents/{segment(args.name)}/credentials")
    credentials_ = listing["credentials"]
    if credentials_:
        text = format_table(
            ["id", "前缀", "状态", "创建时间", "最后使用", "所属用户"],
            [
                [
                    c["id"],
                    c["prefix"] + "…",
                    _credential_state(c),
                    c["created_at"],
                    c["last_used_at"] or "从未使用",
                    c["user"] or "-",
                ]
                for c in credentials_
            ],
        )
    else:
        text = f"{args.name} 还没有凭据：sfly agent credentials issue {_quote(args.name)}"
    session.out.emit(credentials_, text)


def _revoke(session: Session, args: argparse.Namespace) -> None:
    session.client.request("DELETE", f"/agents/{segment(args.name)}/credentials/{segment(args.id)}")
    session.out.emit(
        {"name": args.name, "id": args.id, "revoked": True},
        f"已吊销 {args.name} 的凭据 {args.id}：用它连着的连接已断开，之后它连不上来",
    )


# ---------------------------------------------------------------- 我的开发 Agent


def _register_dev(group: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    register_dev = group.add_parser(
        "register-dev",
        parents=[common_options()],
        help="在开发机上注册我的开发 Agent（名字由控制面生成：dev-<登录名>-<主机>）",
        description="为这台开发机注册一台属于你的开发 Agent："
        "名字由控制面按 dev-<登录名>-<主机> 生成"
        "（登录名来自你的登录，不能自己给名字），凭据记在你名下。"
        "要先登录（sfly login）或设置 SFLY_API_TOKEN"
        "（没有时退出码 5）。同一个人在同一个项目里用同一个主机名只能注册一次，重名时换 --host。"
        "凭据原值只显示这一次；--env 往 stdout 写两行 SFLY_AGENT_NAME=…、SFLY_TOKEN=…"
        "（安装脚本读它写进 agent.env，"
        "原值不经过命令行参数）。安装开发机用 install.sh --dev，它会替你调用这条命令。",
    )
    register_dev.add_argument(
        "--host",
        metavar="主机名",
        help="名字里「主机」那一段：小写字母、数字、连字符，最长 32 个字符"
        "（默认取本机的主机名，不带域名，不合格的字符换成连字符）",
    )
    register_dev.add_argument(
        "--env",
        action="store_true",
        help="stdout 写两行 SFLY_AGENT_NAME=…、SFLY_TOKEN=…（给安装脚本读）；不能和 --json 一起用",
    )
    register_dev.set_defaults(func=command(_register_dev_agent))

    revoke_dev = group.add_parser(
        "revoke-dev",
        parents=[common_options()],
        help="吊销我的开发 Agent 的凭据",
        description="吊销名为 <名称> 的开发 Agent 的凭据：要是你自己的，或者有「管理」范围。"
        "吊销之后同一个人可以重新注册（register-dev）。",
    )
    revoke_dev.add_argument("name", metavar="名称", help="开发 Agent 的名称（dev-<登录名>-<主机>）")
    revoke_dev.set_defaults(func=command(_revoke_dev))


def default_host() -> str:
    """本机的主机名，规整成开发 Agent 名字里「主机」那一段：不带域名、小写、只留字母数字和连字符、
    不以连字符开头或结尾、最长 32 个字符；规整之后是空的返回空串。"""
    host = socket.gethostname().split(".")[0].lower()
    host = re.sub(r"[^a-z0-9-]", "-", host)[:_HOST_MAX].strip("-")
    return host


def _register_dev_agent(session: Session, args: argparse.Namespace) -> int:
    _one_form(args, "--env")
    # 没有登录凭据：用专门的退出码告诉调用方（安装脚本据此决定走 sfly login 还是失败），不发请求。
    if not session.client.token:
        session.out.error(
            CliError(
                "not_logged_in",
                "没有登录凭据：注册开发 Agent 要用你自己的身份（登录或个人令牌）",
                next="sfly login（脚本里设环境变量 SFLY_API_TOKEN）",
            )
        )
        return EXIT_NOT_LOGGED_IN
    host = args.host if args.host is not None else default_host()
    if not host:
        raise CliError(
            "invalid_host",
            f"取不到合格的主机名（本机主机名是 {socket.gethostname()!r}）",
            next="sfly agent register-dev --host <主机名>",
        )
    try:
        created = session.client.request(
            "POST", f"/projects/{_PROJECT}/dev-agents", body={"host": host}
        )
    except CliError as error:
        if error.code == "dev_agent_exists":
            raise CliError(
                error.code,
                error.message,
                next="sfly agent register-dev --host <另一个主机名>",
            ) from None
        raise
    name, token = created["name"], created["token"]
    if args.env:
        print(f"SFLY_AGENT_NAME={name}", file=session.out.stdout)
        print(f"SFLY_TOKEN={token}", file=session.out.stdout)
        print(f"已注册开发 Agent {name}（凭据只写到 stdout 这一次）", file=session.out.stderr)
        return 0
    text = "\n".join(
        [
            f"已注册开发 Agent {name}",
            "凭据（原值只显示这一次，控制面只存哈希，丢了要先 sfly agent revoke-dev 再重新注册）：",
            token,
            "写进 agent.env（SFLY_AGENT_NAME、SFLY_TOKEN）后启动 Agent；"
            "install.sh --dev 会替你做这些",
        ]
    )
    session.out.emit(created, text)
    return 0


def _revoke_dev(session: Session, args: argparse.Namespace) -> None:
    session.client.request("DELETE", f"/projects/{_PROJECT}/dev-agents/{segment(args.name)}")
    session.out.emit(
        {"name": args.name, "revoked": True},
        f"已吊销开发 Agent {args.name} 的凭据：之后可以重新注册（sfly agent register-dev）",
    )
