"""平台的助手（#543）：up --assistant 怎么配控制面和助手容器、之后的命令怎么接着用、
端到端怎么检查事件。

docker 调用都换成记录，不起容器。
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Mapping
from typing import Any

import pytest
from aeval import docker as d
from aeval.e2e import check_sequence, sse_events
from aeval.env import ASSISTANT_MODEL_LABEL, DEV_AGENT, Stack

SECRET = "0123456789abcdef" * 3


class Recorder:
    """记下每次 docker 调用的参数和带进去的环境变量；容器都当作健康、在运行。"""

    def __init__(self, inspect: str = "") -> None:
        self.calls: list[tuple[tuple[str, ...], Mapping[str, str] | None]] = []
        self.inspect = inspect

    def docker(
        self, *args: str, check: bool = True, env: Mapping[str, str] | None = None, **_: Any
    ) -> subprocess.CompletedProcess[str]:
        self.calls.append((args, env))
        if args[:1] == ("inspect",) and "{{.State.Health.Status}}" in args:
            return subprocess.CompletedProcess(args, 0, "healthy\n", "")
        if args[:1] == ("inspect",) and "{{.State.Running}}" in args:
            return subprocess.CompletedProcess(args, 0, "true\n", "")
        if args[:1] == ("inspect",):
            code = 0 if self.inspect else 1
            return subprocess.CompletedProcess(args, code, self.inspect, "")
        if args[:1] == ("logs",):
            return subprocess.CompletedProcess(args, 0, "助手服务在 :8090（pi 1.6.0）\n", "")
        return subprocess.CompletedProcess(args, 0, "", "")

    def runs(self, role: str) -> list[tuple[tuple[str, ...], Mapping[str, str] | None]]:
        return [c for c in self.calls if c[0][:1] == ("run",) and f"sfly-aeval-9-{role}" in c[0]]


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    fake = Recorder()
    monkeypatch.setattr(d, "docker", fake.docker)
    return fake


def test_control_plane_is_pointed_at_the_assistant_and_the_workbench(recorder: Recorder) -> None:
    Stack(slot=9, assistant=True, assistant_secret=SECRET)._start_control_plane()
    [(args, env)] = recorder.runs("cp")
    assert "SFLY_ASSISTANT_URL=http://assistant.internal:8090" in args
    assert f"SFLY_WORKBENCH_AGENT={DEV_AGENT}" in args
    # 密钥只写名字，值经 docker 命令行进程的环境带进去：参数里（ps 看得到）没有它。
    assert "SFLY_ASSISTANT_SECRET" in args
    assert not any(SECRET in arg for arg in args)
    assert env == {"SFLY_ASSISTANT_SECRET": SECRET}


def test_control_plane_without_the_assistant_has_none_of_it(recorder: Recorder) -> None:
    Stack(slot=9)._start_control_plane()
    [(args, env)] = recorder.runs("cp")
    assert not any("SFLY_ASSISTANT" in arg or "SFLY_WORKBENCH" in arg for arg in args)
    assert not env


def test_assistant_container_gets_the_model_file_and_the_secret_by_name(
    recorder: Recorder, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    monkeypatch.setattr("aeval.env.DATA_HOME", tmp_path)
    monkeypatch.setattr(d, "exists", lambda kind, name: True)
    Stack(slot=9, assistant=True, assistant_secret=SECRET)._start_assistant()
    [(args, env)] = recorder.runs("assistant")
    assert "assistant.internal" in args
    assert "SFLY_ASSISTANT_MODEL=aeval/fake" in args
    assert f"{ASSISTANT_MODEL_LABEL}=fake" in args
    assert not any(SECRET in arg for arg in args)
    assert env == {"SFLY_ASSISTANT_SECRET": SECRET}
    mount = next(a for a in args if a.endswith(":/config/models.json:ro"))
    models = json.loads(open(mount.split(":")[0]).read())
    provider = models["providers"]["aeval"]
    # 模型文件里没有密钥：假的端点不要，真实模型的凭据由宿主机的转发口加上。
    assert provider["apiKey"] == "aeval-no-key"
    assert provider["baseUrl"] == "http://fake-model.internal:8100/v1"


def test_later_commands_adopt_the_assistant_the_slot_was_started_with(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = json.dumps(["PATH=/usr/bin", f"SFLY_ASSISTANT_SECRET={SECRET}", "X=a=b"])
    fake = Recorder(inspect=f"{env}\tupper\tsfly-assistant:dev-1\n")
    monkeypatch.setattr(d, "docker", fake.docker)
    stack = Stack(slot=9)
    assert stack.adopt_assistant()
    assert (stack.assistant, stack.assistant_model, stack.assistant_image) == (
        True,
        "upper",
        "sfly-assistant:dev-1",
    )
    assert stack.assistant_secret == SECRET
    # 槽位里没有助手容器：不是助手的槽位。
    monkeypatch.setattr(d, "docker", Recorder().docker)
    plain = Stack(slot=9)
    assert not plain.adopt_assistant()
    assert not plain.assistant


def test_isolated_slots_only_take_the_fake_model() -> None:
    with pytest.raises(d.DockerError, match="假的模型端点"):
        Stack(
            slot=9, internal=True, assistant=True, assistant_model="upper"
        ).check_assistant_model()


def test_sse_lines_become_events() -> None:
    lines = [
        ": 心跳\n",
        "event: user_message\n",
        "id: 1\n",
        'data: {"type": "user_message", "seq": 1}\n',
        "\n",
        'data: {"type": "assistant_delta",\n',
        'data:  "text": "a"}\n',
        "\n",
    ]
    assert list(sse_events(lines)) == [
        {"type": "user_message", "seq": 1},
        {"type": "assistant_delta", "text": "a"},
    ]


def _event(seq: int, type_: str, **fields: Any) -> dict[str, Any]:
    return {"seq": seq, "type": type_, **fields}


GOOD = [
    _event(1, "user_message"),
    _event(2, "turn_started", turn=1),
    {"type": "assistant_delta", "text": "看"},
    _event(3, "tool_call", call_id="c1"),
    {"type": "tool_output", "call_id": "c1"},
    _event(4, "tool_result", call_id="c1"),
    _event(5, "assistant_message"),
    _event(6, "turn_end", outcome="completed"),
]


def test_sequence_that_went_through_has_no_problems() -> None:
    assert check_sequence(GOOD) == []


@pytest.mark.parametrize(
    ("events", "problem"),
    [
        (GOOD[1:], "开头应当是"),
        ([*GOOD[:-1], _event(6, "turn_end", outcome="failed", reason="x")], "结局是 failed"),
        (GOOD[:-1], "最后应当是 turn_end"),
        ([e for e in GOOD if e.get("type") != "tool_result"], "没有结果"),
        ([e for e in GOOD if e.get("type") != "tool_call"], "没有对应的工具调用"),
        ([e for e in GOOD if e.get("type") != "assistant_message"], "没有助手的话"),
    ],
)
def test_sequence_problems_are_reported(events: list[dict[str, Any]], problem: str) -> None:
    assert any(problem in p for p in check_sequence(events))
