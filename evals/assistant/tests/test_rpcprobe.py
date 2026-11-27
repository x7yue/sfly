"""探针（#539）：对着录下来的观察下结论，以及容器里那半边的 RPC 读写。

夹具 `fixtures/rpcprobe/q*.json` 是 `./aeval.sh rpcprobe` 实跑的输出。q1、q9 是 #552
改用产品的远程工具扩展之后那次（2026-11-25）的，q1 对照是臂 A，
只留了工具结果和系统提示里的工具清单，长输出截短了；其余是之前用原型扩展那几次的（判法没有变，
换扩展之后各题的结论除第 8 题的探针时序外都没变，见 README「探针」一节）。
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


def test_q1_names_the_step_that_differs_from_arm_a() -> None:
    raw = fixture("q1")
    raw["rpc"][4]["result"]["content"][0]["text"] = "别的输出"
    verdict = judge("q1", raw)
    assert verdict.verdict == FAILS
    assert any("bash_cwd_env" in fact for fact in verdict.facts)


def test_q1_ignores_the_random_name_of_the_full_output_file() -> None:
    raw = fixture("q1")
    texts = [e["result"]["content"][0]["text"] for e in raw["arm_a"]]
    assert any("/tmp/pi-bash-" in t for t in texts)
    assert judge("q1", raw).verdict == HOLDS


STEP_IDS = [
    step["id"]
    for step in json.loads(
        (Path(rpcprobe.__file__).parent.parent / "container" / "toolcheck.json").read_text()
    )["steps"]
]
KNOWN_STEPS = ["bash_background_alive", "bash_setsid_alive"]


def set_remote_result(raw: dict[str, Any], step: str, text: str, error: bool = False) -> None:
    event = raw["rpc"][STEP_IDS.index(step)]
    event["result"]["content"][0]["text"] = text
    event["isError"] = error


def test_q1_lists_the_known_differences_without_failing() -> None:
    # 后台进程那两步：臂 A 本地是 200，远程的命令退出后后台进程被结束，不报错、输出里有 dead。
    verdict = judge("q1", fixture("q1"))
    assert verdict.verdict == HOLDS
    fact = next(f for f in verdict.facts if "是已知差别的步骤" in f)
    assert "bash_background_alive" in fact and "bash_setsid_alive" in fact
    assert "第 12、13 条" in fact
    assert verdict.numbers["known_differences"] == KNOWN_STEPS


@pytest.mark.parametrize("step", [s for s in STEP_IDS if s not in KNOWN_STEPS])
def test_q1_compares_every_other_step_word_for_word(step: str) -> None:
    # 不在已知差别名单上的步骤（含工具自检里没有预期的另外 5 个后台进程的步骤）：
    # 和臂 A 不同就是不成立，不论有没有预期。
    raw = fixture("q1")
    arm_a = raw["arm_a"][STEP_IDS.index(step)]["result"]["content"][0]["text"]
    set_remote_result(raw, step, arm_a + "（多了一句）")
    verdict = judge("q1", raw)
    assert verdict.verdict == FAILS
    assert any("和臂 A（本地执行）结果不同的步骤" in f and step in f for f in verdict.facts)


@pytest.mark.parametrize("step", ["bash_setsid_wait_alive", "bash_cleanup"])
def test_q1_fails_when_a_background_step_outside_the_known_two_differs(step: str) -> None:
    # 审查的探测：setsid 加等待的那一步在远程也死了；清理那一步报错。
    raw = fixture("q1")
    set_remote_result(
        raw,
        step,
        "000dead\n" if step.endswith("alive") else "pkill: 不允许",
        error=step == "bash_cleanup",
    )
    assert judge("q1", raw).verdict == FAILS


def test_q1_fails_when_the_background_process_was_never_started() -> None:
    # 起后台进程那一步根本没执行（工具报「工作台连不上」）：看起来「进程已经没了」，其实没起过。
    raw = fixture("q1")
    set_remote_result(raw, "bash_background", "工作台连不上：dev", error=True)
    assert judge("q1", raw).verdict == FAILS


@pytest.mark.parametrize("step", KNOWN_STEPS)
def test_q1_fails_when_a_known_step_is_a_tool_error(step: str) -> None:
    # 已知差别的那两步变成工具报错（不是「进程被结束了」）。
    raw = fixture("q1")
    set_remote_result(raw, step, "工作台连不上：dev（dead）", error=True)
    verdict = judge("q1", raw)
    assert verdict.verdict == FAILS
    assert any("已知差别的步骤不是预期的样子" in f and step in f for f in verdict.facts)


def test_q1_fails_when_a_known_step_does_not_say_the_process_is_gone() -> None:
    raw = fixture("q1")
    set_remote_result(raw, "bash_setsid_alive", "502")
    assert judge("q1", raw).verdict == FAILS


def test_q1_notes_a_known_difference_that_is_gone() -> None:
    # 远程里后台进程留下来了（和臂 A 一样）：不算坏事，但说一句，差别表该改了。
    raw = fixture("q1")
    arm_a = raw["arm_a"][STEP_IDS.index("bash_background_alive")]["result"]["content"][0]["text"]
    set_remote_result(raw, "bash_background_alive", arm_a)
    verdict = judge("q1", raw)
    assert verdict.verdict == HOLDS
    assert any("这次和臂 A 一样了" in f and "bash_background_alive" in f for f in verdict.facts)
    assert verdict.numbers["known_differences"] == ["bash_setsid_alive"]


def test_q1_fails_when_arm_a_is_missing_results() -> None:
    raw = fixture("q1")
    raw["arm_a"] = raw["arm_a"][:5]
    verdict = judge("q1", raw)
    assert verdict.verdict == FAILS
    assert any("臂 A 只有 5 个工具结果" in fact for fact in verdict.facts)


def test_q1_reports_the_tool_list_in_the_system_prompt() -> None:
    # 产品的扩展替换的工具带着说明：系统提示的工具清单是全的。只列了一部分时另外说一句。
    verdict = judge("q1", fixture("q1"))
    assert sorted(verdict.numbers["prompt_tools"]) == ["bash", "edit", "read", "write"]
    raw = fixture("q1")
    raw["system_prompt"] = "<tools>\n- bash: Execute bash commands\n</tools>"
    assert any("系统提示的工具清单只列了 bash" in fact for fact in judge("q1", raw).facts)


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
    assert any("助手镜像" in fact and "能跑" in fact for fact in judge("q9", raw).facts)
    raw["slim"] = {"ok": False, "error": "pi: not found"}
    assert judge("q9", raw).verdict == PARTLY
    raw["slim"] = None
    verdict = judge("q9", raw)
    assert verdict.verdict == HOLDS
    assert "助手镜像（Node 的 slim 镜像）：没有测" in verdict.facts


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


# ---- 量的是哪一份扩展（#727 审查必须改 2） ----


def test_the_assistant_image_is_the_given_one_or_the_slots_never_the_default_tag() -> None:
    from aeval.env import DEFAULT_ASSISTANT_IMAGE, Stack

    assert rpcprobe.assistant_image_choice(Stack(slot=9), "mine:1") == "mine:1"
    # 槽位里起着助手容器（make_stack 已经照它接着用）：用它的镜像。
    adopted = Stack(slot=9, assistant=True, assistant_image="slot-image:7")
    assert rpcprobe.assistant_image_choice(adopted, None) == "slot-image:7"
    assert rpcprobe.assistant_image_choice(adopted, "mine:1") == "mine:1"
    # 没给、槽位里也没有助手容器：没有答案，不退到默认标签（可能是几天前构建的旧镜像）。
    plain = Stack(slot=9)
    assert plain.assistant_image == DEFAULT_ASSISTANT_IMAGE
    assert rpcprobe.assistant_image_choice(plain, None) is None


def test_rpcprobe_without_an_assistant_image_stops_before_touching_the_environment(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from aeval import cli
    from aeval.env import Stack

    monkeypatch.setattr(cli, "_stack", lambda _args: Stack(slot=9))

    def touched(*_args: Any, **_kwargs: Any) -> int:
        raise AssertionError("动了环境")

    monkeypatch.setattr(rpcprobe, "run", touched)
    with pytest.raises(SystemExit) as raised:
        cli.main(["rpcprobe", "q1"])
    assert raised.value.code == 2
    error = capsys.readouterr().err
    assert "--assistant-image" in error and "默认标签" in error


def test_rpcprobe_uses_the_given_image(monkeypatch: pytest.MonkeyPatch) -> None:
    from aeval import cli
    from aeval.env import Stack

    stack = Stack(slot=9)
    monkeypatch.setattr(cli, "_stack", lambda _args: stack)
    seen: list[str] = []

    def fake_run(st: Stack, *_args: Any, **_kwargs: Any) -> int:
        seen.append(st.assistant_image)
        return 0

    monkeypatch.setattr(rpcprobe, "run", fake_run)
    assert cli.main(["rpcprobe", "q1", "--assistant-image", "mine:1"]) == 0
    assert seen == ["mine:1"]


class FakeDocker:
    """`copy_product_extension` 要用的 docker：`cp` 把预置的内容写到目的地，别的只记下来。"""

    def __init__(self, extension: bytes, pi_package: str, *, fail_cp: bool = False) -> None:
        self.extension, self.pi_package, self.fail_cp = extension, pi_package, fail_cp
        self.calls: list[tuple[str, ...]] = []

    def exists(self, _kind: str, _name: str) -> bool:
        return True

    def docker(self, *args: str, **_kwargs: Any) -> Any:
        import subprocess

        self.calls.append(args)
        out = ""
        if args[0] == "cp":
            if self.fail_cp:
                raise RuntimeError("cp 失败")
            source, dest = args[1], Path(args[2])
            if source.endswith("extension.mjs"):
                dest.write_bytes(self.extension)
            elif source.endswith("package.json"):
                dest.write_text(self.pi_package)
        elif args[0] == "image" and args[1] == "inspect":
            out = "sha256:" + "ab" * 32 + "\t2026-11-25T07:00:00.123Z\n"
        return subprocess.CompletedProcess(args, 0, out, "")


def patch_docker(monkeypatch: pytest.MonkeyPatch, fake: FakeDocker) -> None:
    from aeval import docker as docker_module

    monkeypatch.setattr(docker_module, "exists", fake.exists)
    monkeypatch.setattr(docker_module, "docker", fake.docker)
    monkeypatch.setattr(docker_module, "sh", lambda *_a, **_k: None)
    monkeypatch.setattr(docker_module, "copy_in", lambda *_a, **_k: None)


def test_copy_product_extension_records_which_extension_was_measured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hashlib

    from aeval.env import Stack

    fake = FakeDocker(b"export default 1;\n", json.dumps({"name": "pi", "version": "1.7.0"}))
    patch_docker(monkeypatch, fake)
    stack = Stack(slot=9, assistant_image="sfly-assistant:test")
    info = rpcprobe.copy_product_extension(stack, "probe", tmp_path)
    assert info == {
        "assistant_image": "sfly-assistant:test",
        "assistant_image_id": "sha256:" + "ab" * 32,
        "assistant_image_created": "2026-11-25T07:00:00.123Z",
        "extension_sha256": hashlib.sha256(b"export default 1;\n").hexdigest(),
        "assistant_pi": "1.7.0",
    }
    # 先清掉可能留着的同名容器，建一个不运行的，复制两个文件，删掉它，再读镜像的信息。
    assert [c[0] for c in fake.calls] == ["rm", "create", "cp", "cp", "rm", "image"]


def test_copy_product_extension_removes_the_holder_when_the_copy_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from aeval.env import Stack

    fake = FakeDocker(b"x", "{}", fail_cp=True)
    patch_docker(monkeypatch, fake)
    with pytest.raises(RuntimeError):
        rpcprobe.copy_product_extension(Stack(slot=9), "probe", tmp_path)
    assert fake.calls[-1][:2] == ("rm", "-f")


def test_render_says_which_extension_was_measured() -> None:
    versions = {
        "pi": "1.6.0",
        "node": "v26",
        "assistant_image": "sfly-assistant:test",
        "assistant_image_id": "sha256:" + "cd" * 32,
        "assistant_image_created": "2026-11-25T07:00:00Z",
        "extension_sha256": "ef" * 32,
        "assistant_pi": "1.6.0",
    }
    report = rpcprobe.render([], versions)
    assert "sfly-assistant:test" in report and "cdcdcdcdcdcd" in report
    assert "ef" * 32 in report and "2026-11-25T07:00:00Z" in report
    assert "助手镜像里的 pi 是 1.6.0" in report
    assert "提醒" not in report


def test_render_warns_when_the_two_pi_versions_differ() -> None:
    versions = {
        "pi": "1.6.0",
        "node": "v26",
        "assistant_image": "sfly-assistant:test",
        "assistant_image_id": "sha256:" + "cd" * 32,
        "assistant_pi": "1.7.0",
    }
    report = rpcprobe.render([], versions)
    assert "**提醒：**" in report
    assert "工作台镜像里的 pi 1.6.0" in report and "助手镜像里的 pi 1.7.0" in report
    assert rpcprobe.version_warnings({**versions, "assistant_pi": "1.6.0"}) == []


def test_render_warns_when_the_assistant_pi_version_is_unknown() -> None:
    versions = {"pi": "1.6.0", "assistant_image": "sfly-assistant:test"}
    warnings = rpcprobe.version_warnings(versions)
    assert len(warnings) == 1 and "没有读到助手镜像里 pi 的版本" in warnings[0]


def test_render_without_the_product_info_is_unchanged() -> None:
    report = rpcprobe.render([], {"pi": "1.6.0", "node": "v26"})
    assert "助手镜像" not in report and "提醒" not in report
