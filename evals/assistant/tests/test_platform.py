"""平台臂的记录：平台的结局换成退出原因，driver.json 的字段和臂 A 的一样，内存峰值的取样，
复制哪些文件。"""

from __future__ import annotations

from typing import Any

import pytest
from aeval.platform import (
    SESSION_FILES,
    PeakSampler,
    driver_summary,
    exit_reason,
    parse_hwm,
)


@pytest.mark.parametrize(
    ("turn_end", "deadline_passed", "want"),
    [
        ({"outcome": "completed"}, False, "finished"),
        ({"outcome": "limit", "limit_kind": "model_calls"}, False, "turn_limit"),
        ({"outcome": "limit", "limit_kind": "duration"}, False, "time_limit"),
        # 评测这一侧过了时限停下的。
        ({"outcome": "stopped"}, True, "time_limit"),
        ({"outcome": "model_unavailable"}, False, "model_unavailable"),
        ({"outcome": "failed"}, False, "failed"),
        ({"outcome": "interrupted"}, False, "interrupted"),
        (None, True, "time_limit"),
        (None, False, "no_turn_end"),
    ],
)
def test_exit_reason(turn_end: dict[str, Any] | None, deadline_passed: bool, want: str) -> None:
    assert exit_reason(turn_end, deadline_passed) == want


RAW: list[dict[str, Any]] = [
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
    {"type": "tool_execution_end"},
    {"type": "turn_start"},
    {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "usage": {}}},
]


def test_driver_summary_takes_the_platform_numbers_and_counts_tools_from_pi_events() -> None:
    turn_end = {
        "outcome": "completed",
        "model_calls": 7,
        "duration_ms": 12_345,
        "usage": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4},
    }
    summary = driver_summary(turn_end, RAW, 300 * 1024, deadline_passed=False, seconds=99)
    assert summary["exit_reason"] == "finished"
    assert summary["turns"] == 7
    assert summary["tokens"] == {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4}
    assert summary["wall_seconds"] == 12.3
    assert summary["pi_peak_rss_mib"] == 300.0
    assert (summary["tool_calls"], summary["tool_errors"]) == (2, 1)
    assert summary["stop_reasons"] == {"toolUse": 1, "stop": 1}
    assert summary["last_stop_reason"] == "stop"
    # 和臂 A 的会话驱动同样的字段：report、classify 不分臂。
    assert {"exit_reason", "wall_seconds", "pi_peak_rss_mib", "limits", "turns", "tokens"} <= set(
        summary
    )


def test_without_turn_end_the_numbers_come_from_pi_events() -> None:
    summary = driver_summary(None, RAW, 0, deadline_passed=True, seconds=1260.04)
    assert summary["exit_reason"] == "time_limit"
    assert summary["turns"] == 2
    assert summary["tokens"] == {"input": 10, "output": 5, "cache_read": 100, "cache_write": 1}
    assert summary["wall_seconds"] == 1260.0


def test_parse_hwm() -> None:
    assert parse_hwm("VmHWM:\t  123456 kB\n") == 123456
    assert parse_hwm("VmRSS:\t  5 kB") == 0
    assert parse_hwm("") == 0


def test_the_sampler_matches_pi_by_its_process_name() -> None:
    # pi 把 process.title 改成 pi：按 /proc/<pid>/comm 认，命令行（被改写了）不用。
    assert '"$p/comm"' in PeakSampler.SCRIPT and "cmdline" not in PeakSampler.SCRIPT
    assert "$AEVAL_MATCH" in PeakSampler.SCRIPT and "VmHWM" in PeakSampler.SCRIPT
    assert PeakSampler.STOP_FILE in PeakSampler.SCRIPT


def test_turn_json_is_not_copied_out_of_the_assistant() -> None:
    # turn.json 是这一轮的配置，带着环境变量（含保密的）：结果目录里不能有它。
    assert "turn.json" not in SESSION_FILES
    assert "events.jsonl" in SESSION_FILES
