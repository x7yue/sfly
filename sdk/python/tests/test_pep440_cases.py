"""共用用例表 `testdata/pep440-cases.json`。

控制面里判断「是不是同一个版本」的实现（apps/server/src/packages/pep440.ts，
包索引核对 wheel 和归档的版本，#556）对着 Python 的 `packaging` 写。
这里检查这张表本身和 `packaging` 一致；TypeScript 一侧（apps/server/test/pep440.test.ts）
用同一张表检查实现。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from packaging.version import InvalidVersion, Version

CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "testdata" / "pep440-cases.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("group", CASES["equal"], ids=lambda group: " = ".join(group))
def test_equal_groups_are_one_version(group: list[str]) -> None:
    assert len({Version(version) for version in group}) == 1


@pytest.mark.parametrize("pair", CASES["different"], ids=lambda pair: " != ".join(pair))
def test_different_pairs_are_different_versions(pair: list[str]) -> None:
    left, right = pair
    assert Version(left) != Version(right)


@pytest.mark.parametrize("text", CASES["invalid"], ids=repr)
def test_invalid_versions_are_rejected(text: str) -> None:
    with pytest.raises(InvalidVersion):
        Version(text)
