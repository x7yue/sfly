"""按 id 或准确名称找场景：所有要指定场景的命令共用。"""

from __future__ import annotations

import shlex
import uuid
from typing import Any

from sfly.cli.client import ApiError, Client, segment
from sfly.cli.errors import CliError


def find_scenario(client: Client, ref: str, *, command: str) -> dict[str, Any]:
    """`ref` 是场景 id 或准确名称：先按 id 找，找不到再按名称找（已归档的场景不参与名称匹配）。
    返回控制面的场景对象（至少有 `id`、`name`、`description`、`head_version`、`archived_at`）。

    名称对应多个场景时抛 `scenario_ambiguous`，列出每个候选的 id 和最新版本号；
    找不到时抛 `scenario_not_found`。`command` 是用户接下来重试用的命令前缀（例如
    `sfly scenario show`），错误里的下一步写成 `<command> <候选 id>`。
    """
    if _is_uuid(ref):
        try:
            found: dict[str, Any] = client.get(f"/orchestrations/{segment(ref)}")
            return found
        except ApiError as error:
            if error.status != 404:
                raise

    listing = client.get("/orchestrations", {"q": ref})
    matches = [s for s in listing["orchestrations"] if s["name"] == ref]
    if len(matches) == 1:
        found = matches[0]
        return found
    if matches:
        candidates = "\n".join(
            f"  {s['id']}  最新版本 {s['head_version'] or '无'}" for s in matches
        )
        raise CliError(
            "scenario_ambiguous",
            f"名称「{ref}」对应 {len(matches)} 个场景，用 id 指定其中一个：\n{candidates}",
            next=f"{command} {matches[0]['id']}",
        )
    archived = listing["archived_count"]
    hint = f"（另有 {archived} 个已归档的场景，不参与名称匹配）" if archived else ""
    raise CliError(
        "scenario_not_found",
        f"没有 id 或名称是「{ref}」的场景{hint}",
        next=f"sfly scenario list --search {shlex.quote(ref)}",
    )


def _is_uuid(text: str) -> bool:
    try:
        uuid.UUID(text)
    except ValueError:
        return False
    return True
