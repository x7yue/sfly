"""`sfly scenario versions`：场景的版本列表（版本号、作者、时间、经哪个 AI 编程助手）。"""

from __future__ import annotations

import argparse

from sfly.cli.client import segment
from sfly.cli.output import add_limit_option, apply_limit, format_table, more_note, via_label
from sfly.cli.scenario_lookup import find_scenario
from sfly.cli.session import Session, command, common_options


def register(group: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = group.add_parser(
        "versions",
        parents=[common_options()],
        help="场景的版本列表：版本号、作者、时间、经哪个 AI 编程助手",
        description="列出场景的版本，最新的在前。「经 …」表示这个版本是通过 AI 编程助手保存的"
        "（只是标注，不是鉴权）。超过 --limit 时提示还有多少个。",
    )
    parser.add_argument("scenario", metavar="场景", help="场景 id 或准确名称")
    add_limit_option(parser)
    parser.set_defaults(func=command(_versions))


def _versions(session: Session, args: argparse.Namespace) -> None:
    scenario = find_scenario(session.client, args.scenario, command="sfly scenario versions")
    listing = session.client.get(f"/orchestrations/{segment(scenario['id'])}/versions")
    versions = listing["versions"]
    shown, hidden = apply_limit(versions, args.limit)
    rows = [
        {
            "number": v["number"],
            "author": v["author"],
            "author_via": v["author_via"],
            "created_at": v["created_at"],
        }
        for v in shown
    ]
    if rows:
        text = format_table(
            ["版本", "作者", "保存时间", "经"],
            [
                [
                    str(r["number"]),
                    r["author"],
                    r["created_at"],
                    f"经 {via_label(r['author_via'])}" if r["author_via"] else "",
                ]
                for r in rows
            ],
        )
    else:
        text = f"场景「{scenario['name']}」还没有保存过版本"
    session.out.emit(rows, text, note=more_note(hidden, len(versions), "个版本"))
