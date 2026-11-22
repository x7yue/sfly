"""探针（#539）：对着录下来的观察下结论，以及容器里那半边的 RPC 读写。

夹具 `fixtures/rpcprobe/q*.json` 是 `./aeval.sh rpcprobe` 一次实跑的输出
（q1 只留了工具结果，长输出截短了）。
"""

from __future__ import annotations

import copy
import io
import json
import sys
from pathlib import Path
from typing import Any

import pytest
import rpcprobe_run as run
from aeval import rpcprobe
from aeval.rpcprobe import FAILS, HOLDS, PARTLY, UNFINISHED, judge

FIXTURES = Path(__file__).parent / "fixtures" / "rpcprobe"


def fixture(question: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"{question}.json").read_text())
    return data


# ---- 结论 ----


def test_recorded_run_verdicts() -> None:
    verdicts = {q: judge(q, fixture(q)).verdict for q in rpcprobe.QUESTIONS}
    assert verdicts == {"q1": HOLDS, "q2": HOLDS, "q3": PARTLY, "q4": HOLDS}


def test_q1_names_the_step_that_differs_from_json_mode() -> None:
    raw = fixture("q1")
    raw["rpc"][4]["result"]["content"][0]["text"] = "别的输出"
    verdict = judge("q1", raw)
    assert verdict.verdict == FAILS
    assert any("bash_cwd_env" in fact for fact in verdict.facts)


def test_q1_ignores_the_random_name_of_the_full_output_file() -> None:
    raw = fixture("q1")
    texts = [e["result"]["content"][0]["text"] for e in raw["json"]]
    assert any("/tmp/pi-bash-" in t for t in texts)
    assert judge("q1", raw).verdict == HOLDS


def test_q1_reports_the_tool_list_in_the_system_prompt() -> None:
    verdict = judge("q1", fixture("q1"))
    assert verdict.numbers["prompt_tools"] == ["bash"]
    assert any("系统提示的工具清单只列了 bash" in fact for fact in verdict.facts)


def test_q1_fails_when_a_file_is_written_locally() -> None:
    raw = fixture("q1")
    raw["written_locally"] = True
    assert judge("q1", raw).verdict == FAILS


def test_q2_fails_when_a_planted_extension_loads() -> None:
    raw = fixture("q2")
    raw["probe"]["markers"]["agent_dir"] = True
    verdict = judge("q2", raw)
    assert verdict.verdict == FAILS
    assert any("设置目录的 extensions/" in fact for fact in verdict.facts)


def test_q2_does_not_count_when_the_control_run_detects_nothing() -> None:
    raw = fixture("q2")
    raw["control"]["markers"] = dict.fromkeys(raw["control"]["markers"], False)
    assert judge("q2", raw).verdict == UNFINISHED


def test_q2_reports_that_a_read_only_agent_dir_does_not_work() -> None:
    verdict = judge("q2", fixture("q2"))
    assert verdict.numbers["read_only_agent_dir_ok"] is False
    fact = next(f for f in verdict.facts if "只读" in f)
    assert "auth.json" in fact and "/tmp/" not in fact


def test_q3_holds_without_the_system_md_in_the_agent_dir() -> None:
    raw = fixture("q3")
    raw["probe"]["system_prompt"] = raw["probe"]["system_prompt"].replace(
        "MARK-AGENT-DIR-SYSTEM", ""
    )
    assert judge("q3", raw).verdict == HOLDS


def test_q3_names_where_an_extra_file_came_from() -> None:
    raw = fixture("q3")
    raw["probe"]["system_prompt"] += "\nMARK-LOCAL-WS-AGENTS"
    verdict = judge("q3", raw)
    assert verdict.verdict == PARTLY
    assert any("工作目录的 AGENTS.md" in fact for fact in verdict.facts)


def test_q3_fails_when_the_given_skill_is_missing() -> None:
    raw = fixture("q3")
    raw["probe"]["system_prompt"] = raw["probe"]["system_prompt"].replace("MARK-SKILL-GIVEN", "")
    assert judge("q3", raw).verdict == FAILS


def test_q3_counts_prompt_templates() -> None:
    raw = fixture("q3")
    raw["probe"]["commands"].append({"name": "tpl", "source": "prompt", "description": "x"})
    assert judge("q3", raw).verdict == PARTLY


def test_q4_fails_when_the_restart_does_not_resume() -> None:
    raw = fixture("q4")
    raw["second"]["messages_on_start"] = raw["second"]["messages_on_start"][:1]
    assert judge("q4", raw).verdict == FAILS


def test_q4_fails_when_the_model_does_not_get_the_earlier_turns() -> None:
    raw = fixture("q4")
    raw["second"]["last_request_users"] = ["第三句"]
    assert judge("q4", raw).verdict == FAILS


def test_unfinished_question() -> None:
    verdict = judge("q2", {"ok": False, "error": "TimeoutError: 没有等到记录"})
    assert verdict.verdict == UNFINISHED
    assert "TimeoutError" in verdict.facts[0]


def test_render_lists_every_question() -> None:
    verdicts = [judge(q, fixture(q)) for q in rpcprobe.QUESTIONS]
    report = rpcprobe.render(verdicts, {"pi": "1.6.0", "node": "v26"})
    assert "| 3 |" in report and "部分成立" in report
    assert "pi 1.6.0，Node v26" in report


def test_models_json_points_at_the_local_fake_endpoint() -> None:
    config = json.loads(rpcprobe.models_json())
    provider = config["providers"]["aeval"]
    assert provider["baseUrl"] == f"http://127.0.0.1:{rpcprobe.FAKE_PORT}/v1"


# ---- 容器里的那一半 ----


def test_split_lines_only_on_lf_and_strips_cr() -> None:
    record = json.dumps({"text": "a b c"}, ensure_ascii=False).encode()
    stream = io.BufferedReader(io.BytesIO(record + b"\r\n" + b'{"x": 1}'))
    assert list(run.split_lines(stream)) == [record, b'{"x": 1}']


def test_rpc_command_is_the_assistant_service_command() -> None:
    cmd = run.rpc_command("s1")
    for flag in (
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-approve",
        "--offline",
    ):
        assert flag in cmd
    assert cmd[cmd.index("--session-id") + 1] == "s1"
    assert cmd[cmd.index("--tools") + 1] == "read,bash,edit,write"
    control = run.rpc_command("s1", drop=("--no-skills",), add=("--approve",))
    assert "--no-skills" not in control and control[-1] == "--approve"


FAKE_PI = """
import json, sys
for line in sys.stdin:
    command = json.loads(line)
    reply = {"type": "response", "id": command["id"], "command": command["type"], "success": True}
    if command["type"] == "prompt":
        reply["data"] = {"disposition": "started"}
        print(json.dumps(reply), flush=True)
        print(json.dumps({"type": "agent_settled", "aborted": False, "text": "a b"}), flush=True)
    else:
        print(json.dumps(reply), flush=True)
"""


def test_rpc_pi_talks_to_a_process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run, "ROOT", tmp_path)
    pi = run.RpcPi([sys.executable, "-c", FAKE_PI], cwd=str(tmp_path), stderr=tmp_path / "e.log")
    assert pi.prompt_and_settle("你好", timeout=10)["data"] == {"disposition": "started"}
    state = pi.call({"type": "get_state"}, timeout=10)
    assert state["success"] is True and state["id"] == "probe-2"
    seconds = pi.close(timeout=10)
    assert seconds is not None
    kinds = [r["type"] for r in pi.events()]
    assert kinds == ["response", "agent_settled", "response"]
    assert all("_t" in r for r in pi.events())


def test_rpc_pi_wait_times_out(tmp_path: Path) -> None:
    pi = run.RpcPi(
        [sys.executable, "-c", "import sys; sys.stdin.read()"],
        cwd=str(tmp_path),
        stderr=tmp_path / "e.log",
    )
    with pytest.raises(TimeoutError):
        pi.wait_for(lambda r: True, timeout=0.3)
    pi.close(timeout=10)


def test_fixture_copies_are_independent() -> None:
    # 各个用例改的是自己的那份夹具。
    a, b = fixture("q3"), fixture("q3")
    a["probe"]["system_prompt"] = ""
    assert b["probe"]["system_prompt"] and copy.deepcopy(b) == b
