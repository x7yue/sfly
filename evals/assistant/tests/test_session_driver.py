"""会话驱动：按 LF 切分 JSONL、从事件流累计轮数和 token。"""

import io
import json
import os
from pathlib import Path
from typing import Any

import pytest
from session_driver import Usage, main, split_lines


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


def test_at_the_turn_limit_the_turns_are_the_limit_like_the_platform(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 假的 pi：发 5 次 turn_start（上限是 3），之后等着被结束。
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "pi"
    fake.write_text(
        '#!/bin/sh\nfor i in 1 2 3 4 5; do echo \'{"type": "turn_start"}\'; done\nexec sleep 30\n'
    )
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    (tmp_path / "prompt.md").write_text("题目")
    out = tmp_path / "out"
    code = main(
        ["--cwd", str(tmp_path), "--prompt-file", str(tmp_path / "prompt.md")]
        + ["--provider", "p", "--model", "m", "--max-turns", "3", "--out", str(out)]
    )
    summary = json.loads((out / "driver.json").read_text())
    assert code == 0
    assert summary["exit_reason"] == "turn_limit"
    assert summary["turns"] == 3
