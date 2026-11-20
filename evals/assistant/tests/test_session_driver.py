"""会话驱动：按 LF 切分 JSONL、从事件流累计轮数和 token。"""

import io
import json
from typing import Any

from session_driver import Usage, split_lines


def test_split_only_on_lf() -> None:
    record = json.dumps({"text": "a b"}, ensure_ascii=False).encode()
    stream = io.BufferedReader(io.BytesIO(record + b"\n" + b'{"x": 1}'))
    assert list(split_lines(stream)) == [record, b'{"x": 1}']


def test_usage_counts_turns_tokens_and_tool_errors() -> None:
    usage = Usage()
    events: list[dict[str, Any]] = [
        {"type": "turn_start"},
        {"type": "message_end", "message": {"role": "user"}},
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": "toolUse",
                "usage": {"input": 10, "output": 5, "cacheRead": 100, "cacheWrite": 1},
            },
        },
        {"type": "tool_execution_end", "isError": True},
        {"type": "turn_start"},
        {
            "type": "message_end",
            "message": {"role": "assistant", "stopReason": "stop", "usage": {"input": 3}},
        },
    ]
    for event in events:
        usage.add(event)
    summary = usage.as_dict()
    assert summary["turns"] == 2
    assert summary["tokens"] == {"input": 13, "output": 5, "cache_read": 100, "cache_write": 1}
    assert summary["tool_calls"] == 1
    assert summary["tool_errors"] == 1
    assert summary["stop_reasons"] == {"toolUse": 1, "stop": 1}
    assert summary["last_stop_reason"] == "stop"
