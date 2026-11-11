"""sfly 命令行入口：init / build / publish / dev / run / skill update。

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


def _init(args: argparse.Namespace) -> int:
    from sfly.cli.init import InitError, init

    try:
        project = init(
            Path(args.directory), args.name, control_plane_url(args.server, DEFAULT_SERVER)
        )
    except InitError as error:
        print(f"初始化失败：{error}", file=sys.stderr)
        return 2 if error.usage else 1
    print(f"已创建节点包项目 {project}")
    print(f"下一步：cd {project} && uv sync && uv run pytest")
    return 0


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


def _run(args: argparse.Namespace) -> int:
    from sfly.cli.build import BuildError
    from sfly.cli.run import EXIT_INVALID, RunError, run

    try:
        downloads = {ref: Path(path).absolute() for ref, path in args.download or []}
        return run(
            Path(args.project).resolve(), args.node, args.params, args.grace, downloads=downloads
        )
    except RunError as error:
        print(error, file=sys.stderr)
        return EXIT_INVALID
    except BuildError as error:
        print(f"扫描节点失败：{error}", file=sys.stderr)
        return 1


def _skill_update(args: argparse.Namespace) -> int:
    from sfly.cli.skill import SkillError, update

    try:
        target = update(Path(args.project).resolve(), force=args.force)
    except SkillError as error:
        print(error, file=sys.stderr)
        return 2 if error.usage else 1
    print(f"已更新节点开发 skill（sfly {__version__}）：{target}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sfly", description="sfly 节点包开发工具")
    parser.add_argument("--version", action="version", version=f"sfly {__version__}")
    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser(
        "init",
        help="创建节点包项目（uv 项目 + 控制面的镜像与 sfly 索引配置 + 示例节点 + 节点开发 skill）",
        description="用 uv init --lib --python 3.13 创建项目，"
        "写入控制面的 PyPI 镜像、Python 下载镜像和 sfly 索引，"
        "加开发依赖（sfly[cli]、pytest、ruff）、一个示例节点及其单元测试，"
        "以及给 AI 编程助手的节点开发 skill"
        "（.agents/skills/sfly-node-dev/，.claude/skills/ 下是软链接）。"
        "退出码：成功 0，失败 1，包名不合法或目录非空 2。",
    )
    p_init.add_argument("directory", help="项目目录（不存在或为空）")
    p_init.add_argument(
        "--name",
        help="包名（默认为目录名）：小写字母、数字、- 和 _，以字母或数字开头",
    )
    p_init.add_argument(
        "--server",
        help="控制面 HTTP 地址（默认 $SFLY_SERVER，其次 $SFLY_HOME/agent.env 的 "
        f"SFLY_CONTROL_PLANE_URL，都没有时 {DEFAULT_SERVER}）",
    )
    p_init.set_defaults(func=_init)

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
        help="本机 Agent 的本地 socket（默认与 Agent 相同：SFLY_DEV_SOCKET，"
        "其次工作目录 SFLY_WORK_DIR 下的 agent.sock，环境变量优先于 $SFLY_HOME/agent.env；"
        "都没有时 $SFLY_HOME/work/agent.sock）",
    )
    p_dev.set_defaults(func=_dev)

    p_run = sub.add_parser(
        "run",
        help="本地调试：在当前项目环境里执行一个节点，打印输出、日志和指标",
        description="在当前项目环境里用 Agent 同一个执行器执行一个节点（不经过控制面和 Agent）。"
        "产物和工作文件放在 <项目>/.sfly/runs/<时间>-<节点>/。Ctrl-C 取消，再按一次立即杀掉。"
        "退出码：成功 0，节点失败 1，参数不合法 2，取消 130。",
    )
    p_run.add_argument("node", help="节点名（@node 的 name，默认为函数名）")
    p_run.add_argument("--params", default="{}", help="节点的输入，JSON 对象（默认 {}）")
    p_run.add_argument("--project", default=".", help="项目目录（默认当前目录）")
    p_run.add_argument(
        "--download",
        nargs=2,
        action="append",
        metavar=("产物引用", "文件"),
        help="节点用 ctx.artifacts.download 下载这个产物引用时，得到这个本地文件的内容"
        "（不访问网络）；可以重复给出",
    )
    p_run.add_argument(
        "--grace",
        type=float,
        default=10.0,
        help="取消时从 SIGTERM 到强制杀掉的宽限期，秒（默认 10）",
    )
    p_run.set_defaults(func=_run)

    p_skill = sub.add_parser("skill", help="管理项目里给 AI 编程助手的节点开发 skill")
    skill_sub = p_skill.add_subparsers(dest="skill_command", required=True)
    p_skill_update = skill_sub.add_parser(
        "update",
        help="把节点开发 skill 换成当前 SDK 版本的内容",
        description="用当前 SDK 版本带的内容整个替换 .agents/skills/sfly-node-dev/"
        "（.claude/skills/sfly-node-dev 是指向它的软链接，不存在时一并创建）。"
        "目录内容和上次写入的不同时不覆盖，加 --force 才覆盖。"
        "退出码：成功 0，目录改动过 1，不是项目目录 2。",
    )
    p_skill_update.add_argument(
        "--force", action="store_true", help="目录改动过也覆盖（改动会丢失）"
    )
    p_skill_update.add_argument("--project", default=".", help="项目目录（默认当前目录）")
    p_skill_update.set_defaults(func=_skill_update)

    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    code: int = args.func(args)
    return code
