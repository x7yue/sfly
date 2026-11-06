"""sfly 命令行入口：build / publish / dev。

CLI 在开发者机器上运行，可以使用 `sfly[cli]` extra 中的第三方依赖；
这些依赖只在子命令执行时才导入，`import sfly.cli` 本身只用标准库。
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from sfly import __version__
from sfly.cli.home import control_plane_url, dev_socket

DEFAULT_SERVER = "http://127.0.0.1:8080"


def _build(args: argparse.Namespace) -> int:
    from sfly.cli.build import BuildError, build

    try:
        archive = build(
            Path(args.project).resolve(), Path(args.out).resolve() if args.out else None
        )
    except BuildError as error:
        print(f"构建失败：{error}", file=sys.stderr)
        return 1
    print(f"已生成节点包 {archive}")
    return 0


def _publish(args: argparse.Namespace) -> int:
    from sfly.cli.build import BuildError, build
    from sfly.cli.publish import PublishError, publish

    path = Path(args.path).resolve()
    try:
        archive = build(path) if path.is_dir() else path
        result = publish(archive, control_plane_url(args.server, DEFAULT_SERVER))
    except BuildError as error:
        print(f"构建失败：{error}", file=sys.stderr)
        return 1
    except (PublishError, OSError) as error:
        print(f"发布失败：{error}", file=sys.stderr)
        return 1
    print(f"已发布 {result['name']}@{result['version']}（sha256 {result['sha256']}）")
    return 0


def _dev(args: argparse.Namespace) -> int:
    from sfly.cli.build import BuildError
    from sfly.cli.dev import DevError, dev

    try:
        reply = dev(Path(args.project).resolve(), dev_socket(args.socket))
    except BuildError as error:
        print(f"构建失败：{error}", file=sys.stderr)
        return 1
    except (DevError, OSError) as error:
        output = getattr(error, "output", "")
        if output:
            print(output.rstrip(), file=sys.stderr)
        print(f"加载开发版本失败：{error}", file=sys.stderr)
        return 1
    print(reply.get("message", "已加载开发版本"))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sfly", description="sfly 节点包开发工具")
    parser.add_argument("--version", action="version", version=f"sfly {__version__}")
    sub = parser.add_subparsers(dest="command")

    p_build = sub.add_parser("build", help="扫描 @node，构建 .sflypkg 节点包")
    p_build.add_argument("project", nargs="?", default=".", help="项目目录（默认当前目录）")
    p_build.add_argument("--out", help="输出目录（默认 <项目>/dist）")
    p_build.set_defaults(func=_build)

    p_publish = sub.add_parser("publish", help="把节点包发布到控制面")
    p_publish.add_argument(
        "path",
        nargs="?",
        default=".",
        help=".sflypkg 文件，或项目目录（先构建再发布，默认当前目录）",
    )
    p_publish.add_argument(
        "--server",
        help="控制面 HTTP 地址（默认 $SFLY_SERVER，其次 $SFLY_HOME/agent.env 的 "
        f"SFLY_CONTROL_PLANE_URL，都没有时 {DEFAULT_SERVER}）",
    )
    p_publish.set_defaults(func=_publish)

    p_dev = sub.add_parser("dev", help="让本机 Agent 以可编辑方式加载本地源码目录，注册为 包名@dev")
    p_dev.add_argument("project", nargs="?", default=".", help="项目目录（默认当前目录）")
    p_dev.add_argument(
        "--socket",
        help="本机 Agent 的本地 socket（默认 $SFLY_DEV_SOCKET，其次 $SFLY_HOME/agent.env 的 "
        "SFLY_DEV_SOCKET，都没有时 $SFLY_HOME/work/agent.sock）",
    )
    p_dev.set_defaults(func=_dev)

    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    code: int = args.func(args)
    return code
