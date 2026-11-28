"""`sfly publish --session-build` 登记被拒时怎么分流（#795）。

只有 `conflict`（这个序号已经登记过了）换下一个序号重试；名字在公共项目和别的项目之间重了
（`package_name_taken`）重试也过不了，第一次就退出、把控制面的说明原样给用户。

构建换成一个假的（只写一个文件），控制面换成一个记下请求的替身：这里只看分流，不看构建和网络。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sfly.cli import publish as publish_module
from sfly.cli.client import ApiError
from sfly.cli.publish import PublishError, register_session_build

SESSION = "0f8c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
TAG = "s" + SESSION.replace("-", "")
TAKEN_MESSAGE = (
    "公共项目里已有节点包 demo（任何项目都能直接用它）：别的项目里不能发布同名的包，换一个名字；"
    "发布它的新版本要发布到公共项目（只有平台管理员能发布）"
)


class FakeClient:
    """登记的前几次按 `refusals` 依次拒绝，之后成功；记下每次登记的版本号。"""

    def __init__(self, refusals: list[ApiError]) -> None:
        self.session_id = SESSION
        self.refusals = refusals
        self.registered: list[str] = []

    def get(self, path: str) -> dict[str, Any]:
        assert path == f"/sessions/{SESSION}/builds"
        return {"builds": []}

    def request(self, method: str, path: str, *, raw: bytes, **_: Any) -> dict[str, Any]:
        assert (method, path) == ("POST", f"/sessions/{SESSION}/builds")
        version = raw.decode()
        self.registered.append(version)
        if self.refusals:
            raise self.refusals.pop(0)
        return {"name": "demo", "version": version}


@pytest.fixture(autouse=True)
def fake_build(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        publish_module, "load_project", lambda root: SimpleNamespace(name="demo", version="0.3.1")
    )

    def build(root: Path, out: Path, *, version: str) -> Path:
        out.mkdir(parents=True, exist_ok=True)
        archive = out / "demo.sflypkg"
        archive.write_text(version)
        return archive

    monkeypatch.setattr(publish_module, "build", build)


def test_conflict_retries_with_the_next_seq(tmp_path: Path) -> None:
    client = FakeClient(
        [ApiError(409, "conflict", "节点包 demo@0.3.1+x.1 已存在，不能覆盖已发布的版本")]
    )
    body = register_session_build(tmp_path, client)  # type: ignore[arg-type]
    assert client.registered == [f"0.3.1+{TAG}.1", f"0.3.1+{TAG}.2"]
    assert body["version"] == f"0.3.1+{TAG}.2"


def test_package_name_taken_stops_at_once_with_the_server_message(tmp_path: Path) -> None:
    client = FakeClient([ApiError(409, "package_name_taken", TAKEN_MESSAGE)] * 3)
    with pytest.raises(PublishError) as raised:
        register_session_build(tmp_path, client)  # type: ignore[arg-type]
    assert client.registered == [f"0.3.1+{TAG}.1"]
    assert "package_name_taken" in str(raised.value)
    assert TAKEN_MESSAGE in str(raised.value)
    assert "序号一直冲突" not in str(raised.value)
