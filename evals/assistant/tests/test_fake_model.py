"""假的模型端点：按第一条用户消息认题，照剧本一步一步回复，最后给出文字。"""

import json
from pathlib import Path

from fake_model import _substitute, chunks, next_reply


def tasks_dir(tmp_path: Path) -> Path:
    (tmp_path / "write").mkdir()
    (tmp_path / "write" / "prompt.md").write_text("写一个节点\n")
    return tmp_path


def test_plays_the_script_by_counting_tool_results(tmp_path: Path) -> None:
    root = tasks_dir(tmp_path)
    user = {"role": "user", "content": [{"type": "text", "text": "写一个节点"}]}
    first = next_reply({"messages": [user]}, root)
    assert first == {"tool": "bash", "arguments": '{"command": "ls -la"}', "call_id": "call_1"}
    tool = {"role": "tool", "content": "ok"}
    second = next_reply({"messages": [user, {"role": "assistant"}, tool]}, root)
    assert json.loads(second["arguments"]) == {
        "command": 'cd "$(cat /tmp/aeval-reference/workdir 2>/dev/null || pwd)" '
        "&& bash /tmp/aeval-reference/solve.sh"
    }
    done = next_reply({"messages": [user, tool, tool]}, root)
    assert done == {"text": "完成。"}


def test_unknown_prompt_does_nothing(tmp_path: Path) -> None:
    reply = next_reply({"messages": [{"role": "user", "content": "别的事"}]}, tasks_dir(tmp_path))
    assert "text" in reply


def test_tool_call_chunks_end_with_tool_calls() -> None:
    events = chunks({"tool": "bash", "arguments": '{"command": "ls"}', "call_id": "c1"}, "fake")
    call = events[0]["choices"][0]["delta"]["tool_calls"][0]
    assert call["function"] == {"name": "bash", "arguments": '{"command": "ls"}'}
    assert events[-1]["choices"][0]["finish_reason"] == "tool_calls"
    assert "usage" in events[-1]


def test_toolcheck_substitutes_the_full_output_path(tmp_path: Path) -> None:
    from fake_model import toolcheck_steps

    steps = toolcheck_steps()
    index = next(i for i, s in enumerate(steps) if "{full_output}" in str(s["args"]))
    user = {"role": "user", "content": "AEVAL-TOOLCHECK"}
    tools = [{"role": "tool", "content": "x"}] * (index - 1)
    last = {"role": "tool", "content": "…[Showing lines 1-10. Full output: /tmp/pi-bash-1.log]"}
    reply = next_reply({"messages": [user, *tools, last]}, tmp_path)
    assert reply["tool"] == "read"
    assert "/tmp/pi-bash-1.log" in reply["arguments"]


# ---- 544-B 的探针用到的几样 ----


def _script(name: str) -> dict[str, str]:
    return {"role": "user", "content": f"AEVAL-SCRIPT:{name} 照剧本做。"}


def test_text_streams_in_pieces_with_the_given_usage(tmp_path: Path) -> None:
    reply = next_reply({"messages": [_script("rpcprobe-midstream")]}, tmp_path)
    assert (reply["pieces"], reply["interval"]) == (30, 0.3)
    events = chunks(reply, "fake")
    texts = [e["choices"][0]["delta"].get("content") for e in events[:-1]]
    assert len(texts) == 30
    assert "".join(texts) == reply["text"]
    assert events[-1]["choices"][0]["finish_reason"] == "stop"
    near_full = {**reply, "pieces": 1, "prompt_tokens": 120000}
    assert chunks(near_full, "fake")[-1]["usage"]["prompt_tokens"] == 120000


def test_overflow_then_summary_then_the_scripts_ending(tmp_path: Path) -> None:
    from fake_model import COMPACTED, OVERFLOW_MESSAGE, SUMMARIZATION

    tool = {"role": "tool", "content": "aaa"}
    prompt = _script("rpcprobe-compact")
    assert next_reply({"messages": [prompt, tool, tool]}, tmp_path) == {
        "error": 400,
        "message": OVERFLOW_MESSAGE,
    }
    summary = next_reply(
        {"messages": [{"role": "system", "content": f"{SUMMARIZATION}. Do it."}, prompt]}, tmp_path
    )
    assert COMPACTED in summary["text"]
    assert "AEVAL-SCRIPT:rpcprobe-compact" in summary["text"]
    after = {"role": "user", "content": summary["text"]}
    assert next_reply({"messages": [after, tool]}, tmp_path) == {"text": "压缩之后做完了。"}


def test_thinking_comes_first_as_reasoning_content() -> None:
    for reply in (
        {"text": "好了", "thinking": "先想一想", "thinking_delay": 2.0},
        {"tool": "bash", "arguments": "{}", "call_id": "call_1", "thinking": "先想一想"},
    ):
        events = chunks(reply, "fake")
        assert events[0]["choices"][0]["delta"] == {
            "role": "assistant",
            "reasoning_content": "先想一想",
        }
        assert all("reasoning_content" not in e["choices"][0]["delta"] for e in events[1:])
    plain = chunks({"text": "好了"}, "fake")
    assert all("reasoning_content" not in e["choices"][0]["delta"] for e in plain)


def test_last_user_is_the_latest_thing_the_user_said() -> None:
    messages = [
        {"role": "user", "content": "第一句"},
        {"role": "tool", "content": "结果"},
        {"role": "user", "content": '插话："顺便看一下"'},
    ]
    assert json.loads(_substitute('"收到：{last_user}"', messages)) == '收到：插话："顺便看一下"'
