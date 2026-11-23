"""平台的助手（#543）：up --assistant 怎么配控制面和助手容器、之后的命令怎么接着用、
端到端怎么检查事件。

docker 调用都换成记录，不起容器。
"""

from __future__ import annotations

import argparse
import json
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from aeval import docker as d
from aeval import e2e
from aeval.cli import _stack
from aeval.e2e import check_sequence, sse_events
from aeval.env import ASSISTANT_MODEL_LABEL, DEV_AGENT, Stack
from aeval.tasks import Check, Task

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


def _renumber(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**e, "seq": i + 1} for i, e in enumerate(events)]


GOOD = [
    _event(1, "user_message"),
    _event(2, "turn_started", turn=1),
    _event(3, "tool_call", call_id="c1"),
    _event(4, "tool_result", call_id="c1"),
    _event(5, "tool_call", call_id="c2"),
    _event(6, "tool_result", call_id="c2"),
    _event(7, "assistant_message"),
    _event(8, "turn_end", outcome="completed"),
]


def test_sequence_that_went_through_has_no_problems() -> None:
    assert check_sequence(GOOD) == []


def _without(kind: str) -> list[dict[str, Any]]:
    return _renumber([e for e in GOOD if e["type"] != kind])


@pytest.mark.parametrize(
    ("events", "problem"),
    [
        (_renumber(GOOD[1:]), "开头应当是"),
        ([*GOOD[:-1], _event(8, "turn_end", outcome="failed", reason="x")], "结局是 failed"),
        (GOOD[:-1], "没有 turn_end"),
        (_renumber([*GOOD[:5], *GOOD[6:]]), "没有结果"),
        (_without("tool_call"), "没有对应的工具调用"),
        (_without("assistant_message"), "之后没有助手的话"),
        # 助手的话在工具调用之前、之后再也没有。
        (
            _renumber([GOOD[0], GOOD[1], GOOD[6], *GOOD[2:6], GOOD[7]]),
            "之后没有助手的话",
        ),
        # 中间多一个 turn_started。
        (_renumber([*GOOD[:4], _event(0, "turn_started"), *GOOD[4:]]), "turn_started 出现了 2 次"),
        # 序号跳号（少了一个）。
        ([*GOOD[:4], *GOOD[5:]], "不跳号"),
        # turn_end 之后还有事件。
        ([*GOOD, _event(9, "assistant_message")], "turn_end 之后还有事件"),
    ],
)
def test_sequence_problems_are_reported(events: list[dict[str, Any]], problem: str) -> None:
    assert any(problem in p for p in check_sequence(events)), check_sequence(events)


class FakeTask(Task):
    id = "fake-task"
    workspace = "/work/pkg"

    def __init__(self, passed: bool = True) -> None:
        self.passed = passed

    def prompt(self) -> str:
        return "做一件事"

    def seed(self, stack: Stack) -> None:
        pass

    def grade(self, stack: Stack) -> list[Check]:
        return [Check("做成了", self.passed)]


class FakeControlPlane:
    """e2e 经它建会话、读事件、停会话；follow 给什么由用例定。"""

    def __init__(
        self,
        monkeypatch: pytest.MonkeyPatch,
        followed: tuple[list[dict[str, Any]], str | None],
        persisted: list[dict[str, Any]],
        create_error: str | None = None,
    ) -> None:
        self.calls: list[tuple[str, str]] = []
        self.persisted = persisted
        self.create_error = create_error
        monkeypatch.setattr(e2e, "_request", self.request)
        monkeypatch.setattr(e2e, "follow", lambda stack, session_id, deadline: followed)
        monkeypatch.setattr(Stack, "reset", lambda self: None)

    def request(self, stack: Stack, method: str, path: str, body: Any = None) -> Any:
        self.calls.append((method, path))
        if path == "/projects/default/sessions":
            if self.create_error:
                raise e2e.ControlPlaneError(self.create_error)
            return {"id": "s1"}
        if method == "GET" and path.startswith("/sessions/s1"):
            return {"events": self.persisted, "has_more": False}
        return None


def _run(tmp_path: Path, task: Task) -> tuple[int, dict[str, Any], Path]:
    stack = Stack(slot=9, assistant=True, assistant_secret=SECRET)
    code = e2e.run(stack, task, tmp_path)
    [out] = list(tmp_path.iterdir())
    return code, json.loads((out / "e2e.json").read_text()), out


def test_e2e_passes_only_with_the_right_sequence_and_a_full_score(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    FakeControlPlane(monkeypatch, (GOOD, None), GOOD)
    code, record, out = _run(tmp_path, FakeTask())
    assert code == 0
    assert record["problems"] == [] and record["session"] == "s1"
    assert json.loads((out / "persisted.json").read_text()) == GOOD
    assert len((out / "events.jsonl").read_text().splitlines()) == len(GOOD)


def test_e2e_fails_when_the_score_is_not_full(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    FakeControlPlane(monkeypatch, (GOOD, None), GOOD)
    code, record, _ = _run(tmp_path, FakeTask(passed=False))
    assert code == 1
    assert record["grade"]["score"] == 0.0


def test_e2e_checks_the_persisted_events_not_just_the_stream(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """事件流在 turn_end 就停了；之后再来的事件只在控制面存下的那份里看得到。"""
    FakeControlPlane(monkeypatch, (GOOD, None), [*GOOD, _event(9, "assistant_message")])
    code, record, _ = _run(tmp_path, FakeTask())
    assert code == 1
    assert any("turn_end 之后还有事件" in p for p in record["problems"])


def test_e2e_keeps_what_it_got_and_stops_the_session_when_the_turn_does_not_end(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    partial = GOOD[:4]
    control = FakeControlPlane(
        monkeypatch, (partial, "在时限内没有等到 turn_end（收到 4 个事件）"), []
    )
    code, record, out = _run(tmp_path, FakeTask())
    assert code == 1
    assert record["sequence"] == ["user_message", "turn_started", "tool_call", "tool_result"]
    assert len((out / "events.jsonl").read_text().splitlines()) == 4
    assert ("POST", "/sessions/s1/stop") in control.calls


def test_e2e_reports_a_refused_session_in_one_line_and_still_writes_the_record(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    error = 'POST /projects/default/sessions 返回 503：{"error":{"code":"workbench_offline"}}'
    FakeControlPlane(monkeypatch, ([], None), [], create_error=error)
    code, record, _ = _run(tmp_path, FakeTask())
    assert code == 1
    assert record["problems"] == [error] and record["session"] is None
    assert "Traceback" not in capsys.readouterr().out


def test_reset_and_other_commands_adopt_the_assistant(monkeypatch: pytest.MonkeyPatch) -> None:
    """up 之后的命令（reset、seed、e2e……）重建控制面时，照着助手容器接着用：
    不然控制面丢了那三个变量。"""
    env = json.dumps([f"SFLY_ASSISTANT_SECRET={SECRET}"])
    fake = Recorder(inspect=f"{env}\tfake\tsfly-assistant:dev\n")
    monkeypatch.setattr(d, "docker", fake.docker)
    for command in ("reset", "seed", "e2e"):
        stack = _stack(argparse.Namespace(slot=9, command=command))
        assert stack.assistant and stack.assistant_secret == SECRET, command
    up = _stack(argparse.Namespace(slot=9, command="up", assistant=False))
    assert not up.assistant


def _quiet_up(monkeypatch: pytest.MonkeyPatch, recorder: Recorder) -> list[str]:
    """把 up、reset 里起容器、装 Agent 的那些步骤换成什么都不做，只留下对助手容器的处理。"""
    for name in (
        "ensure_images",
        "ensure_network",
        "_start_postgres",
        "_start_control_plane",
        "_install_agents",
        "start_agents",
        "stop_agents",
        "wait_agents",
        "start_service",
        "wait_assistant_ready",
        "check_assistant_model",
    ):
        monkeypatch.setattr(Stack, name, lambda self, *a, **k: None)
    monkeypatch.setattr("aeval.env.copy_scripts", lambda *a, **k: None)
    monkeypatch.setattr(d, "sh", lambda *a, **k: subprocess.CompletedProcess(a, 0, "", ""))
    started: list[str] = []
    monkeypatch.setattr(Stack, "_start_assistant", lambda self: started.append(self.slot))
    return started  # type: ignore[return-value]


def test_up_without_the_assistant_removes_one_left_behind(
    monkeypatch: pytest.MonkeyPatch, recorder: Recorder
) -> None:
    _quiet_up(monkeypatch, recorder)
    Stack(slot=9).up(log=lambda _: None)
    assert ("rm", "-f", "sfly-aeval-9-assistant") in [c[0] for c in recorder.calls]


def test_up_with_the_assistant_starts_it_and_never_prints_the_secret(
    monkeypatch: pytest.MonkeyPatch, recorder: Recorder
) -> None:
    started = _quiet_up(monkeypatch, recorder)
    waited: list[int] = []
    monkeypatch.setattr(Stack, "wait_assistant_ready", lambda self: waited.append(self.slot))
    printed: list[str] = []
    stack = Stack(slot=9, assistant=True)
    stack.up(log=printed.append)
    assert started == [9]
    # up 完就能用：等到控制面说助手就绪才结束。
    assert waited == [9]
    assert stack.assistant_secret and len(stack.assistant_secret) >= 32
    assert not any(stack.assistant_secret in line for line in printed)
    assert ("rm", "-f", "sfly-aeval-9-assistant") not in [c[0] for c in recorder.calls]


def test_reset_rebuilds_the_assistant_container(
    monkeypatch: pytest.MonkeyPatch, recorder: Recorder
) -> None:
    started = _quiet_up(monkeypatch, recorder)
    Stack(slot=9, assistant=True, assistant_secret=SECRET).reset()
    assert started == [9]
    Stack(slot=9).reset()
    assert started == [9]


def test_old_control_plane_without_sessions_fails_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def sh(*args: Any, **_: Any) -> subprocess.CompletedProcess[str]:
        calls.append(args[1])
        return subprocess.CompletedProcess(args, 0, '{"error":{}}\n404', "")

    monkeypatch.setattr(d, "sh", sh)
    with pytest.raises(d.DockerError, match="源码构建的控制面镜像"):
        Stack(slot=9, assistant=True).wait_assistant_ready(timeout=60)
    assert len(calls) == 1
