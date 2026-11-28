"""命令行的开发版本号和控制面的是同一个值（#434）：读 `@sfly/schema` 的源码对拍。"""

import re
from pathlib import Path

from sfly.cli.dev_version import DEV_VERSION

SCHEMA = Path(__file__).resolve().parents[3] / "packages/schema/src/package-metadata.ts"


def test_dev_version_matches_the_control_plane() -> None:
    match = re.search(r'export const DEV_VERSION = "([^"]+)";', SCHEMA.read_text(encoding="utf-8"))
    assert match is not None, "packages/schema/src/package-metadata.ts 里找不到 DEV_VERSION"
    assert match.group(1) == DEV_VERSION
