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
    verdicts = {q: judge(q, fixture(q)).verdict for q in ("q1", "q2", "q3", "q4")}
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


def test_q3_default_prompt_path_holds_in_the_recorded_run() -> None:
    verdict = judge("q3", fixture("q3"))
    assert verdict.numbers["default_extra_markers"] == []
    assert verdict.numbers["default_templates"] == []
    assert any("不放 SYSTEM.md 时（默认系统提示" in fact for fact in verdict.facts)


def test_q3_fails_when_a_default_location_reaches_the_default_prompt() -> None:
    raw = fixture("q3")
    raw["default"]["system_prompt"] += "\nMARK-AGENT-DIR-AGENTS"
    assert judge("q3", raw).verdict == FAILS


def test_q3_is_unfinished_without_the_default_prompt_run() -> None:
    raw = fixture("q3")
    del raw["default"]
    assert judge("q3", raw).verdict == UNFINISHED


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


def test_q4_counts_the_system_message_each_start_adds() -> None:
    verdict = judge("q4", fixture("q4"))
    assert verdict.numbers["system_messages"] == [1, 2]
    raw = fixture("q4")
    raw["second"]["messages_after_third"] = [
        m for m in raw["second"]["messages_after_third"] if m["role"] != "system"
    ]
    assert judge("q4", raw).verdict == PARTLY


def test_q4_is_unfinished_when_the_request_was_not_saved() -> None:
    raw = fixture("q4")
    raw["second"]["last_request_users"] = []
    assert judge("q4", raw).verdict == UNFINISHED


def test_q4_reports_the_recorded_stderr() -> None:
    raw = fixture("q4")
    raw["first"]["stderr"] = ""
    assert "第一次起时 stderr 是空的" in judge("q4", raw).facts


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


def test_q4_reports_which_context_the_resumed_session_sends() -> None:
    verdict = judge("q4", fixture("q4"))
    assert verdict.numbers["context_after_restart"] == "second"
    raw = fixture("q4")
    raw["second"]["context_after_restart"] = "first"
    assert any("会话文件里存的系统提示" in fact for fact in judge("q4", raw).facts)


# ---- 第 5 到 10 题 ----


def test_recorded_run_verdicts_for_questions_5_to_10() -> None:
    verdicts = {q: judge(q, fixture(q)).verdict for q in ("q5", "q6", "q7", "q8", "q9", "q10")}
    assert set(verdicts.values()) == {HOLDS}


def test_q5_reports_the_filled_in_tool_result_and_the_open_real_model_half() -> None:
    verdict = judge("q5", fixture("q5"))
    assert verdict.numbers["as_killed_tool_results"] == ["No result provided"]
    assert any("欠着" in fact for fact in verdict.facts)


def test_q5_fails_when_the_workbench_command_never_goes_away() -> None:
    raw = fixture("q5")
    raw["as_killed"]["workbench"] = {"seen": True, "gone_seconds": None}
    assert judge("q5", raw).verdict == FAILS


def test_q5_is_unfinished_when_the_command_was_never_sampled() -> None:
    raw = fixture("q5")
    raw["half_line"]["workbench"] = {"seen": False, "gone_seconds": None}
    verdict = judge("q5", raw)
    assert verdict.verdict == UNFINISHED
    assert any("没采到" in fact for fact in verdict.facts)


def test_q5_fails_when_the_restart_fails() -> None:
    raw = fixture("q5")
    raw["half_line"]["restart_ok"] = False
    raw["half_line"]["restart_error"] = "SyntaxError"
    assert judge("q5", raw).verdict == FAILS


def test_q6_fails_over_ten_seconds() -> None:
    raw = fixture("q6")
    raw["settled_seconds"] = 12.0
    assert judge("q6", raw).verdict == FAILS
    raw = fixture("q6")
    raw["workbench"] = {"seen": True, "gone_seconds": None}
    assert judge("q6", raw).verdict == FAILS


def test_q6_fails_when_the_turn_is_not_aborted() -> None:
    raw = fixture("q6")
    raw["settled_aborted"] = False
    assert judge("q6", raw).verdict == FAILS
    raw = fixture("q6")
    raw["tool_result"] = "slept"
    assert judge("q6", raw).verdict == FAILS


def test_q6_reports_the_next_turn_after_abort() -> None:
    verdict = judge("q6", fixture("q6"))
    # 这次实跑：会话里留着那条空的 assistant 消息，发给模型的请求里 pi 把它去掉了。
    assert verdict.numbers["after_abort_session_keeps_empty_assistant"] is True
    assert verdict.numbers["after_abort_empty_assistant"] == 0
    assert any("abort 之后同一个进程再发一轮" in fact for fact in verdict.facts)
    raw = fixture("q6")
    raw["next_turn"]["prompt_ok"] = False
    raw["next_turn"]["prompt_error"] = "rejected"
    assert judge("q6", raw).verdict == FAILS
    raw = fixture("q6")
    raw["next_turn"]["request"] = []
    assert judge("q6", raw).verdict == UNFINISHED
    raw = fixture("q6")
    del raw["next_turn"]
    assert judge("q6", raw).verdict == UNFINISHED


def test_q7_fails_when_the_steer_is_sent_before_the_tool_result() -> None:
    raw = fixture("q7")
    second = raw["during_tool"]["requests"][1]
    second[-2], second[-1] = second[-1], second[-2]
    assert judge("q7", raw).verdict == FAILS


def test_q7_fails_when_a_cleared_steer_still_reaches_the_model() -> None:
    raw = fixture("q7")
    raw["clear_then_abort"]["requests"].append([{"role": "user", "text": "插话：顺便看一下日志"}])
    assert judge("q7", raw).verdict == FAILS


def test_q7_fails_when_the_steering_queue_never_empties() -> None:
    raw = fixture("q7")
    for update in raw["during_tool"]["queue_updates"]:
        update["steering"] = ["插话：顺便看一下日志"]
    assert judge("q7", raw).verdict == FAILS


def test_q7_needs_the_steer_as_a_user_message_after_the_queue_empties() -> None:
    assert judge("q7", fixture("q7")).numbers["steer_user_message_after_empty"] is True
    raw = fixture("q7")
    raw["during_tool"]["user_messages"] = []
    assert judge("q7", raw).verdict == FAILS


def test_q7_is_unfinished_when_the_requests_were_not_saved() -> None:
    raw = fixture("q7")
    raw["during_tool"]["requests"] = []
    assert judge("q7", raw).verdict == UNFINISHED


def test_q8_expects_the_running_command_to_be_aborted() -> None:
    verdict = judge("q8", fixture("q8"))
    for variant, _ in rpcprobe.Q8_VARIANTS:
        assert verdict.numbers[f"{variant}_outcome"] == "中止"
    raw = fixture("q8")
    raw["mid_turn"]["tool_result"] = "slept"
    raw["mid_turn"]["session_tail"] = ['{"type":"message","message":{"content":"slept"}}']
    raw["mid_turn"]["session_tool_result"] = "slept"
    verdict = judge("q8", raw)
    assert verdict.numbers["mid_turn_outcome"] == "等做完"
    assert verdict.verdict == FAILS


def test_q6_is_partly_when_the_next_request_carries_the_empty_assistant_message() -> None:
    raw = fixture("q6")
    request = raw["next_turn"]["request"]
    request.insert(len(request) - 1, {"role": "assistant", "text": ""})
    verdict = judge("q6", raw)
    assert verdict.verdict == PARTLY
    assert verdict.numbers["after_abort_empty_assistant"] == 1


def test_q8_judges_the_whole_session_line_not_the_truncated_tail() -> None:
    raw = fixture("q8")
    for variant, _ in rpcprobe.Q8_VARIANTS:
        # 截短的那几行里看不到结果，容器里对整行判断的结果为准。
        raw[variant]["tool_result"] = ""
        raw[variant]["session_tail"] = ['{"type":"message"' + "x" * 300]
        raw[variant]["session_tool_result"] = "aborted"
    assert {rpcprobe.q8_outcome(raw[v]) for v, _ in rpcprobe.Q8_VARIANTS} == {"中止"}
    raw["mid_turn"]["session_tool_result"] = "slept"
    assert judge("q8", raw).verdict == FAILS


def test_tool_result_in_session_reads_whole_lines(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    call = {
        "type": "message",
        "message": {
            "role": "assistant",
            "content": [{"type": "toolCall", "arguments": {"command": "sleep 6; echo slept"}}],
        },
    }
    result = {
        "type": "message",
        "message": {
            "role": "toolResult",
            "content": [{"type": "text", "text": "x" * 400 + "Command aborted"}],
        },
    }
    path.write_text(json.dumps(call) + "\n")
    assert run.tool_result_in_session(path) is None  # 命令原文里的 slept 不算
    path.write_text(json.dumps(call) + "\n" + json.dumps(result) + "\n")
    assert run.tool_result_in_session(path) == "aborted"
    assert run.tool_result_in_session(tmp_path / "missing.jsonl") is None


def test_q8_checks_the_session_file_ends_with_a_whole_line() -> None:
    raw = fixture("q8")
    raw["sigterm_only"]["session_last_line_json"] = False
    assert judge("q8", raw).verdict == PARTLY


def test_q8_is_unfinished_without_the_sigterm_only_run() -> None:
    raw = fixture("q8")
    del raw["sigterm_only"]
    assert judge("q8", raw).verdict == UNFINISHED


def test_q9_reports_the_slim_image() -> None:
    raw = fixture("q9")
    assert any("slim" in fact and "能跑" in fact for fact in judge("q9", raw).facts)
    raw["slim"] = {"ok": False, "error": "pi: not found"}
    assert judge("q9", raw).verdict == PARTLY
    raw["slim"] = None
    verdict = judge("q9", raw)
    assert verdict.verdict == HOLDS
    assert "Node 26 的 slim 镜像：没有测" in verdict.facts


def test_q10_fails_when_the_prompt_keeps_the_local_directory() -> None:
    raw = fixture("q10")
    raw["probe"] = raw["control"]
    assert judge("q10", raw).verdict == FAILS


def test_gone_after_takes_the_first_sample_without_the_command() -> None:
    samples = rpcprobe.parse_watch(
        "10.0 sleep 601|\n10.2 sleep 601|\n10.4 \n10.6 sleep 601|\nbad line\n"
    )
    gone = rpcprobe.gone_after(samples, "sleep 601", 10.1)
    assert gone["seen"] is True and gone["gone_seconds"] == pytest.approx(0.3)


def test_gone_after_does_not_count_a_command_that_was_never_sampled() -> None:
    # 从头到尾没采到这条命令（模式写错、命令名变了）：不是「0.1 秒内消失」。
    samples = rpcprobe.parse_watch("10.0 \n10.2 \n10.4 \n")
    assert rpcprobe.gone_after(samples, "sleep 601", 10.1) == {
        "seen": False,
        "after": True,
        "gone_seconds": None,
    }
    # 只在 since 之后才采到的也不算：结束之前它得在跑。
    samples = rpcprobe.parse_watch("10.0 \n10.2 sleep 601|\n10.4 \n")
    assert rpcprobe.gone_after(samples, "sleep 601", 10.1)["seen"] is False


def test_gone_after_without_samples_after_the_end_is_unfinished() -> None:
    samples = rpcprobe.parse_watch("10.0 sleep 601|\n10.1 sleep 601|\n")
    gone = rpcprobe.gone_after(samples, "sleep 601", 10.15)
    assert gone == {"seen": True, "after": False, "gone_seconds": None}
    raw = fixture("q6")
    raw["workbench"] = gone
    assert judge("q6", raw).verdict == UNFINISHED


def test_gone_after_reports_a_command_that_stays() -> None:
    samples = rpcprobe.parse_watch("10.0 sleep 601|\n10.2 sleep 601|\n")
    assert rpcprobe.gone_after(samples, "sleep 601", 10.1) == {
        "seen": True,
        "after": True,
        "gone_seconds": None,
    }


def test_rpcprobe_rejects_an_unknown_question_before_touching_the_environment(
    capsys: pytest.CaptureFixture[str],
) -> None:
    from aeval import cli

    with pytest.raises(SystemExit) as raised:
        cli.main(["rpcprobe", "q99"])
    assert raised.value.code == 2
    assert "q99" in capsys.readouterr().err


def test_verdict_only_gets_worse() -> None:
    verdict = rpcprobe.Verdict("q", "t", FAILS)
    verdict.worsen(PARTLY)
    assert verdict.verdict == FAILS


def test_fake_model_follows_a_named_script(tmp_path: Path) -> None:
    import fake_model

    body = {"messages": [{"role": "user", "content": "AEVAL-SCRIPT:rpcprobe-steer 照剧本做。"}]}
    first = fake_model.next_reply(body, tmp_path)
    assert first["tool"] == "bash" and "sleep 6" in first["arguments"]
    body["messages"].append({"role": "tool", "content": "slept"})
    assert fake_model.next_reply(body, tmp_path) == {"text": "命令执行完了。", "delay": 0.0}
    slow = {"messages": [{"role": "user", "content": "AEVAL-SCRIPT:rpcprobe-slow-text"}]}
    assert fake_model.next_reply(slow, tmp_path)["delay"] == 4.0


# ---- 544-B 先测的七题（第 11 到 17 题）----


def test_recorded_544b_run_holds() -> None:
    questions = ("q11", "q12", "q13", "q14", "q15", "q16", "q17")
    assert {q: judge(q, fixture(q)).verdict for q in questions} == dict.fromkeys(questions, HOLDS)


def test_q11_fails_when_the_next_turn_does_not_finish() -> None:
    raw = fixture("q11")
    raw["next_turn"]["stop_reason"] = "error"
    assert judge("q11", raw).verdict == FAILS


def test_q11_unfinished_when_aborted_before_any_output() -> None:
    raw = fixture("q11")
    raw["deltas_before_abort"] = 0
    assert judge("q11", raw).verdict == UNFINISHED


def test_q12_fails_when_a_steer_reaches_the_next_turn() -> None:
    raw = fixture("q12")
    raw["rounds"][3]["next_turn_request"].append({"role": "user", "text": rpcprobe.STEER_A})
    verdict = judge("q12", raw)
    assert verdict.verdict == FAILS
    assert any("第 4 遍" in fact for fact in verdict.facts)


def test_q12_fails_when_clear_queue_misses_a_steer() -> None:
    raw = fixture("q12")
    raw["rounds"][0]["clear_queue"]["steering"] = []
    assert judge("q12", raw).verdict == FAILS


def test_q13_fates() -> None:
    raw = fixture("q13")
    fates = [rpcprobe.q13_fate(r) for r in raw["rounds"]]
    assert set(fates) <= {"这一轮里送到", "清掉", "留在队列里"}
    # 命令执行中、同一次写：abort 收尾时成了这一轮的一条用户消息。
    assert fates[0] == "这一轮里送到"
    # 模型输出到一半、同一次写：留在 pi 的队列里，下一轮之前的 clear_queue 取回。
    assert fates[25] == "留在队列里"


def test_q13_leak_when_the_steer_left_in_the_queue_reaches_the_next_turn() -> None:
    raw = fixture("q13")
    left = raw["rounds"][25]
    left["pre_clear_got"]["steering"] = []
    left["next_turn_request"].append({"role": "user", "text": rpcprobe.STEER_B})
    assert rpcprobe.q13_fate(left) == "漏"
    assert judge("q13", raw).verdict == FAILS


def test_q13_leak_when_the_steer_shows_up_after_agent_settled() -> None:
    raw = fixture("q13")
    first = raw["rounds"][0]
    first["settled_t"] = min(m["t"] for m in first["turn_user_messages"]) - 1
    assert rpcprobe.q13_fate(first) == "漏"


def test_q14_fails_when_the_two_steers_go_out_separately() -> None:
    raw = fixture("q14")
    prompt = {"role": "user", "text": "AEVAL-SCRIPT:rpcprobe-steer 照剧本做。"}
    a = {"role": "user", "text": rpcprobe.STEER_A}
    b = {"role": "user", "text": rpcprobe.STEER_B}
    reply = {"role": "assistant", "text": "好"}
    raw["all"]["requests"] = [[prompt], [prompt, a], [prompt, a, reply, b]]
    assert judge("q14", raw).verdict == FAILS


def test_q15_fails_when_two_steers_are_merged_into_one_message() -> None:
    raw = fixture("q15")
    raw["same"]["user_messages"] = raw["same"]["user_messages"][:1]
    assert judge("q15", raw).verdict == FAILS


def test_q16_fails_when_the_handled_steer_is_queued() -> None:
    raw = fixture("q16")
    raw["handled"]["data"]["disposition"] = "queued"
    assert judge("q16", raw).verdict == FAILS


def test_q17_fails_on_an_extra_user_message_and_is_unfinished_without_compaction() -> None:
    raw = fixture("q17")
    extra = copy.deepcopy(raw)
    timeline = extra["overflow"]["timeline"]
    timeline.insert(-1, {"type": "message_end", "role": "user", "text": "别的"})
    assert judge("q17", extra).verdict == FAILS
    missing = copy.deepcopy(raw)
    missing["threshold"]["timeline"] = [
        e for e in missing["threshold"]["timeline"] if e["type"] != "compaction_end"
    ]
    assert judge("q17", missing).verdict == UNFINISHED
