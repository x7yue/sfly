"""平台命令的外壳：公共选项（`--server`、`--nickname`、`--json`）和一次调用的上下文。

每个操作平台的命令是一个 `handler(session, args)`：用 `session.client` 访问控制面、用 `session.out`
输出，出错时抛 `CliError`；用 `command(handler)` 包成 argparse 的 `func`，由它统一创建上下文、
把 `CliError` 输出成错误并以退出码 2 结束。handler 可以返回自己的退出码（默认 0）。
"""

from __future__ import annotations

import argparse
from collections.abc import Callable
from dataclasses import dataclass

from sfly.cli.client import Client
from sfly.cli.errors import EXIT_ERROR, CliError
from sfly.cli.home import DEFAULT_SERVER
from sfly.cli.output import Output


@dataclass(frozen=True)
class Session:
    client: Client
    out: Output


Handler = Callable[[Session, argparse.Namespace], int | None]


def common_options() -> argparse.ArgumentParser:
    """所有平台命令共有的选项，用 `add_parser(..., parents=[common_options()])` 加上。"""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--server",
        help="控制面 HTTP 地址（默认 $SFLY_SERVER，其次 $SFLY_HOME/agent.env 的 "
        f"SFLY_CONTROL_PLANE_URL，都没有时 {DEFAULT_SERVER}）",
    )
    parser.add_argument(
        "--nickname",
        help="昵称，写操作记在版本和运行上（默认 $SFLY_NICKNAME，其次系统用户名）",
    )
    parser.add_argument("--json", action="store_true", help="输出 JSON，不输出文本")
    return parser


def command(handler: Handler) -> Callable[[argparse.Namespace], int]:
    """把 handler 包成 argparse 的 `func`。"""

    def run(args: argparse.Namespace) -> int:
        out = Output(json_mode=args.json)
        try:
            client = Client.from_options(args.server, args.nickname)
            return handler(Session(client, out), args) or 0
        except CliError as error:
            out.error(error)
            return EXIT_ERROR

    return run
