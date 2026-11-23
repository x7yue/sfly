"""假的模型端点：按第一条用户消息认题，照剧本一步一步回复，最后给出文字。"""

import json
from pathlib import Path

from fake_model import chunks, next_reply


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
