"""`sfly run artifacts`：列出一次运行各任务上传的产物，并可以下载到本地目录。

列表里是产物的名称、大小和 sha256；下载后会按列表里的 sha256 校验每个文件。
下载的文件放在 `<目录>/<任务 id>/<产物名称>`：
重试过的节点每次尝试可能有同名的产物，按任务分开不会互相覆盖。
"""

from __future__ import annotations

import argparse
import hashlib
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from sfly.cli.client import Client, segment
from sfly.cli.errors import CliError
from sfly.cli.output import format_table
from sfly.cli.run_logs import RunIndex, RunNode, fetch_run
from sfly.cli.session import Session, command, common_options

_CHUNK = 64 * 1024
# 还没开始、不会有产物的任务不用请求。
_NO_ARTIFACTS_YET = {"queued", "skipped"}


def register(sub: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = sub.add_parser(
        "artifacts",
        parents=[common_options()],
        help="列出运行各任务的产物，可以下载",
        description="列出一次运行里各任务上传的产物（名称、大小、sha256）。--download <目录> 把它们"
        "下载到 <目录>/<任务 id>/<产物名称>，并按 sha256 校验。"
        "退出码：成功 0，命令出错（运行不存在、下载失败、校验不一致……）2。",
    )
    parser.add_argument("run", metavar="运行", help="运行 id")
    parser.add_argument(
        "--task",
        action="append",
        metavar="任务",
        help="只看这个任务：任务 id，或「链:节点」（这个节点的所有尝试）、「链:节点#尝试」；"
        "可以重复给出。主链写 main，子流程写它的名称",
    )
    parser.add_argument("--download", metavar="目录", help="把列出的产物下载到这个目录")
    parser.set_defaults(func=command(_artifacts))


class _Task:
    def __init__(self, node: RunNode, attempt: Mapping[str, Any], label: str) -> None:
        self.node = node
        self.attempt = attempt
        self.label = label

    @property
    def id(self) -> str:
        return str(self.attempt["task_id"])


def _tasks(index: RunIndex) -> list[_Task]:
    return [
        _Task(node, attempt, index.describe(node, attempt))
        for node in index.nodes
        if node.kind == "package"
        for attempt in node.attempts
        if attempt["status"] not in _NO_ARTIFACTS_YET
    ]


def _select(tasks: Sequence[_Task], refs: Sequence[str] | None) -> list[_Task]:
    if not refs:
        return list(tasks)
    chosen: list[_Task] = []
    for ref in refs:
        found = [
            t
            for t in tasks
            if ref == t.id or ref == t.node.label or ref == f"{t.node.label}#{t.attempt['attempt']}"
        ]
        if not found:
            listing = "\n".join(f"  {t.label}  {t.id}" for t in tasks[:30])
            raise CliError(
                "task_not_found",
                f"运行里没有任务 {ref}，任务写成任务 id、「链:节点」或「链:节点#尝试」，"
                f"有产物可能的任务：\n{listing or '  （没有）'}",
            )
        chosen.extend(t for t in found if t not in chosen)
    return chosen


def _artifacts(session: Session, args: argparse.Namespace) -> None:
    client, out = session.client, session.out
    run = fetch_run(client, args.run)
    tasks = _select(_tasks(RunIndex.of(run)), args.task)

    rows: list[dict[str, Any]] = []
    expired = False
    for task in tasks:
        listing = client.get(f"/tasks/{segment(task.id)}/artifacts")
        expired = expired or listing["expired"]
        for artifact in listing["artifacts"]:
            rows.append(
                {
                    "task_id": task.id,
                    "chain": task.node.chain,
                    "node": task.node.node_id,
                    "attempt": task.attempt["attempt"],
                    "name": artifact["name"],
                    "size": artifact["size"],
                    "sha256": artifact["sha256"],
                    "created_at": artifact["created_at"],
                    "agent_modified_at": artifact["agent_modified_at"],
                    "url": artifact["url"],
                }
            )

    labels = {t.id: t.label for t in tasks}
    if args.download and rows:
        directory = Path(args.download).expanduser().resolve()
        for row in rows:
            row["path"] = str(_download(client, directory, row))

    headers = ["任务", "名称", "大小", "sha256"] + (["保存到"] if args.download else [])
    table = [
        [labels[r["task_id"]], r["name"], f"{r['size']} 字节", r["sha256"]]
        + ([r["path"]] if args.download else [])
        for r in rows
    ]
    if table:
        text = format_table(headers, table)
    elif expired:
        text = "运行已超过保留期，产物已被清理"
    else:
        text = "所选任务没有产物" if args.task else "这次运行没有产物"
    note = None
    if rows and expired:
        note = "部分任务所在的运行已超过保留期，产物已被清理"
    out.emit(rows, text, note=note)


def _download(client: Client, directory: Path, row: Mapping[str, Any]) -> Path:
    """下载一个产物到 `<目录>/<任务 id>/<名称>`，按列表里的大小和 sha256 校验后才放到最终位置。"""
    name = str(row["name"])
    parts = name.split("/")
    if name.startswith("/") or any(part in ("", ".", "..") for part in parts):
        raise CliError("unsafe_artifact_name", f"产物名称 {name!r} 不是目录内的相对路径，没有下载")
    target: Path = directory / str(row["task_id"]) / Path(*parts)
    temp = target.with_name(f"{target.name}.part")
    path = f"/tasks/{segment(row['task_id'])}/artifacts/{'/'.join(segment(p) for p in parts)}"
    digest = hashlib.sha256()
    size = 0
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with client.open("GET", path) as response, temp.open("wb") as file:
            while chunk := response.read(_CHUNK):
                file.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        if digest.hexdigest() != row["sha256"] or size != row["size"]:
            raise CliError(
                "artifact_mismatch",
                f"下载的 {name} 和列表里的不一致（sha256 {digest.hexdigest()}，{size} 字节；"
                f"列表里是 {row['sha256']}，{row['size']} 字节），已丢弃",
            )
        os.replace(temp, target)
    except OSError as error:
        raise CliError("download_failed", f"下载 {name} 到 {target} 失败：{error}") from None
    finally:
        temp.unlink(missing_ok=True)
    return target
