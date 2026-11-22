"""环境里不起容器就能测的部分：--isolated 的网络检查。docker 调用都换成记录。"""

import argparse
import subprocess
from typing import Any

import pytest
from aeval import docker as d
from aeval.env import Stack


class FakeDocker:
    def __init__(self, internal: str | None, reachable: bool = False) -> None:
        self.internal = internal
        self.reachable = reachable
        self.calls: list[tuple[str, ...]] = []

    def docker(self, *args: str, check: bool = True, **_: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append(args)
        if args[:2] == ("network", "inspect"):
            if self.internal is None:
                return subprocess.CompletedProcess(args, 1, "", "no such network")
            return subprocess.CompletedProcess(args, 0, f"{self.internal}\n", "")
        if args[:2] == ("network", "create"):
            self.internal = "true" if "--internal" in args else "false"
        if args[:2] == ("network", "rm"):
            self.internal = None
        return subprocess.CompletedProcess(args, 0, "", "")

    def sh(self, container: str, script: str, **_: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess([script], 0 if self.reachable else 7, "", "")


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeDocker:
    docker = FakeDocker(internal="false")
    monkeypatch.setattr(d, "docker", docker.docker)
    monkeypatch.setattr(d, "sh", docker.sh)
    return docker


def test_isolated_recreates_an_existing_open_network(fake: FakeDocker) -> None:
    Stack(slot=9, internal=True).ensure_network(log=lambda _: None)
    assert ("network", "rm", "sfly-aeval-9") in fake.calls
    assert ("network", "create", "--internal", "sfly-aeval-9") in fake.calls
    assert fake.internal == "true"


def test_matching_network_is_kept(fake: FakeDocker) -> None:
    Stack(slot=9, internal=False).ensure_network(log=lambda _: None)
    assert not any(call[:2] in {("network", "rm"), ("network", "create")} for call in fake.calls)


def test_verify_isolated_fails_when_the_outside_is_reachable(fake: FakeDocker) -> None:
    fake.reachable = True
    with pytest.raises(d.DockerError):
        Stack(slot=9, internal=True).verify_isolated()


def test_verify_isolated_passes_when_nothing_is_reachable(fake: FakeDocker) -> None:
    Stack(slot=9, internal=True).verify_isolated()


def test_source_hash_changes_with_content_and_is_none_when_missing(tmp_path: Any) -> None:
    from aeval.env import source_hash

    (tmp_path / "Dockerfile").write_text("FROM a\n")
    first = source_hash([tmp_path])
    assert first == source_hash([tmp_path])
    (tmp_path / "Dockerfile").write_text("FROM b\n")
    assert source_hash([tmp_path]) != first
    assert source_hash([tmp_path / "missing"]) is None


class ImagesInUse(FakeDocker):
    """槽位里已经起好的容器用的是哪个镜像：`up` 时指定了 --server-image / --workbench-image。"""

    def __init__(self, images: dict[str, str]) -> None:
        super().__init__(internal="false")
        self.images = images

    def docker(self, *args: str, check: bool = True, **kw: Any) -> subprocess.CompletedProcess[str]:
        if args[:1] == ("inspect",) and args[-1] in self.images:
            return subprocess.CompletedProcess(args, 0, f"{self.images[args[-1]]}\n", "")
        if args[:1] == ("inspect",):
            return subprocess.CompletedProcess(args, 1, "", "no such container")
        return super().docker(*args, check=check, **kw)


def test_later_commands_keep_the_images_the_slot_was_started_with(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`up --server-image X` 之后，run、seed、reset 重建控制面和工作台时沿用 X，不退回默认镜像。"""
    from aeval.cli import _stack

    fake = ImagesInUse({"sfly-aeval-9-cp": "sfly-server:dev", "sfly-aeval-9-dev": "wb:dev"})
    monkeypatch.setattr(d, "docker", fake.docker)
    stack = _stack(argparse.Namespace(slot=9, command="run"))
    assert (stack.server_image, stack.workbench_image) == ("sfly-server:dev", "wb:dev")


def test_up_and_fresh_slots_use_what_was_given_or_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from aeval.cli import _stack
    from aeval.env import DEFAULT_SERVER_IMAGE, DEFAULT_WORKBENCH_IMAGE

    fake = ImagesInUse({"sfly-aeval-9-cp": "sfly-server:old"})
    monkeypatch.setattr(d, "docker", fake.docker)
    given = _stack(argparse.Namespace(slot=9, command="up", server_image="sfly-server:new"))
    assert given.server_image == "sfly-server:new"
    fresh = _stack(argparse.Namespace(slot=8, command="run"))
    assert (fresh.server_image, fresh.workbench_image) == (
        DEFAULT_SERVER_IMAGE,
        DEFAULT_WORKBENCH_IMAGE,
    )


def test_commands_after_up_isolated_follow_the_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """`up --isolated` 之后的命令不带 --isolated：照网络的实际情况，
    重建控制面时不在断网的网络上发布端口。"""
    import argparse

    from aeval.cli import _stack

    monkeypatch.setattr(Stack, "network_internal", lambda self: True)
    assert _stack(argparse.Namespace(command="reset", slot=3)).internal is True
    assert _stack(argparse.Namespace(command="up", slot=3, isolated=False)).internal is False
    monkeypatch.setattr(Stack, "network_internal", lambda self: None)
    assert _stack(argparse.Namespace(command="rpcprobe", slot=3)).internal is False
