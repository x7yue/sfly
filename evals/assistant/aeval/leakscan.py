"""上传结果目录之前扫一遍凭据（#552）：CI 把结果目录作为产物上传，产物公开可下载。

认两样：
- 按值：评测自己知道原值的 secret（初始管理员的密码、控制面和助手服务共用的密钥）；
- 按格式：令牌（`TOKEN_PREFIXES` 加一串令牌字符：会话令牌、Agent 凭据……）和登录 Cookie
  （`sfly_login=` 加值）。会话令牌评测拿不到原值，登录 Cookie 只在会话驱动的进程里，所以按格式认；
  格式认的是任何一枚，不只这一次的。

只认完整的出现（#529 的规矩）：被打码、被截断的不算。报的是文件和种类，不报原值。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path

# 和 packages/schema/src/http/tokens.ts 的 TOKEN_PREFIXES 同一份（tests/test_leakscan.py 对照）。
TOKEN_PREFIXES = ("sfly_pat_", "sfly_prj_", "sfly_ses_", "sfly_tsk_", "sfly_agt_")
SHAPES = {
    "令牌": re.compile(("(?:" + "|".join(TOKEN_PREFIXES) + r")[A-Za-z0-9_-]{16,}").encode()),
    "登录 Cookie": re.compile(rb"sfly_login=[A-Za-z0-9_-]{16,}"),
}
VALUE = "secret 值"


def scan(root: Path, values: Iterable[str | None]) -> list[tuple[str, str]]:
    """root 下每个文件里出现的凭据：（相对路径，种类），按路径排好。不跟随符号链接。"""
    wanted = [value.encode() for value in values if value]
    found: list[tuple[str, str]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        data = path.read_bytes()
        kinds = [VALUE] if any(value in data for value in wanted) else []
        kinds += [kind for kind, shape in SHAPES.items() if shape.search(data)]
        found += [(str(path.relative_to(root)), kind) for kind in kinds]
    return found
