"""失败分类：只看事件流、会话驱动的退出原因和控制面上的运行。"""

import json
from pathlib import Path
from typing import Any

from aeval.classify import classify


def write_events(path: Path, events: list[dict[str, Any]]) -> Path:
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n")
    return path


def tool_error(name: str, text: str, command: str = "") -> dict[str, Any]:
    return {
        "type": "tool_execution_end",
        "toolName": name,
        "args": {"command": command},
        "isError": True,
        "result": {"content": [{"type": "text", "text": text}]},
    }


def test_limit_wins(tmp_path: Path) -> None:
    events = write_events(tmp_path / "e.jsonl", [tool_error("edit", "Could not find the text")])
    result = classify(events, {"exit_reason": "turn_limit"}, [])
    assert result["primary"] == "超时"
    assert result["signals"] == {"超时": 1, "编辑替换失败": 1}


def test_edit_failure(tmp_path: Path) -> None:
    events = write_events(tmp_path / "e.jsonl", [tool_error("edit", "Could not find the text")])
    assert classify(events, {"exit_reason": "finished"}, [])["primary"] == "编辑替换失败"


def test_tool_argument_error(tmp_path: Path) -> None:
    events = write_events(
        tmp_path / "e.jsonl", [tool_error("bash", "Validation failed for tool bash: command")]
    )
    assert classify(events, {}, [])["primary"] == "工具调用格式错"


def test_same_failing_command_three_times(tmp_path: Path) -> None:
    events = write_events(tmp_path / "e.jsonl", [tool_error("bash", "exit 1", "uv run x")] * 3)
    assert classify(events, {}, [])["primary"] == "读不懂错误"


def test_retrigger_while_previous_run_still_running(tmp_path: Path) -> None:
    runs: list[dict[str, Any]] = [
        {
            "scenario": "s",
            "triggered_via": "pi",
            "started_at": "2026-01-01T00:00:00Z",
            "ended_at": None,
        },
        {
            "scenario": "s",
            "triggered_via": "pi",
            "started_at": "2026-01-01T00:01:00Z",
            "ended_at": "x",
        },
        {"scenario": "s", "triggered_via": None, "started_at": "2026-01-01T00:00:30Z"},
    ]
    result = classify(tmp_path / "missing.jsonl", {}, runs)
    assert result["primary"] == "等待时重复触发运行"


def test_nothing_detected_is_other(tmp_path: Path) -> None:
    assert (
        classify(tmp_path / "missing.jsonl", {"exit_reason": "finished"}, [])["primary"] == "其他"
    )


def test_endpoint_failure_is_infrastructure_not_the_model(tmp_path: Path) -> None:
    events = write_events(
        tmp_path / "e.jsonl",
        [
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "stopReason": "error",
                    "errorMessage": "Connection error.: connect ECONNREFUSED 192.168.65.254:18900",
                },
            }
        ],
    )
    result = classify(events, {"exit_reason": "finished"}, [])
    assert result["primary"] == "环境故障"
    assert "工具调用格式错" not in result["signals"]


def test_http_errors_from_the_endpoint_are_infrastructure(tmp_path: Path) -> None:
    for message in (
        '502 {"error":{"message":"转发到 example 失败"}}',
        "429 Too Many Requests",
        "terminated: other side closed",
        "503 upstream overloaded",
    ):
        events = write_events(
            tmp_path / "e.jsonl",
            [
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "stopReason": "error",
                        "errorMessage": message,
                    },
                }
            ],
        )
        assert classify(events, {}, [])["primary"] == "环境故障", message


def assistant_error(message: str) -> dict[str, Any]:
    return {
        "type": "message_end",
        "message": {"role": "assistant", "stopReason": "error", "errorMessage": message},
    }


def assistant_ok() -> dict[str, Any]:
    return {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop"}}


def test_auth_quota_and_timeout_errors_are_endpoint_faults(tmp_path: Path) -> None:
    for message in (
        "aeval API error (401): unauthorized",
        "aeval API error (402): insufficient_user_quota",
        "aeval API error (403): forbidden",
        "Request timed out.",
    ):
        events = write_events(tmp_path / "e.jsonl", [assistant_error(message)])
        result = classify(events, {}, [])
        assert result["invalid"] is True, message
        assert result["primary"] == "环境故障", message


def test_retried_and_recovered_session_stays_valid(tmp_path: Path) -> None:
    events = write_events(
        tmp_path / "e.jsonl",
        [
            assistant_error("aeval API error (503): unavailable"),
            {"type": "auto_retry_start", "attempt": 1, "errorMessage": "503"},
            {"type": "auto_retry_end", "success": True, "attempt": 2},
            assistant_ok(),
        ],
    )
    result = classify(events, {"exit_reason": "finished"}, [])
    assert result["invalid"] is False
    assert result["endpoint_retries"] == 1
    assert result["primary"] == "其他"


def test_exhausted_retries_void_the_session(tmp_path: Path) -> None:
    events = write_events(
        tmp_path / "e.jsonl",
        [
            {"type": "auto_retry_start", "attempt": 1},
            {"type": "auto_retry_end", "success": False, "finalError": "Connection error."},
            assistant_ok(),
        ],
    )
    result = classify(events, {}, [])
    assert result["invalid"] is True
    assert result["endpoint_error"] == "Connection error."


def test_unrecognised_error_is_not_blamed_on_the_model(tmp_path: Path) -> None:
    events = write_events(
        tmp_path / "e.jsonl", [assistant_error("aeval API error (400): bad request")]
    )
    result = classify(events, {}, [])
    assert result["invalid"] is False
    assert result["primary"] == "认不出的错误"


def test_context_overflow_is_not_an_endpoint_fault(tmp_path: Path) -> None:
    events = write_events(
        tmp_path / "e.jsonl",
        [assistant_error("aeval API error (400): prompt is too long for the context window")],
    )
    result = classify(events, {}, [])
    assert result["invalid"] is False
    assert result["primary"] == "上下文耗尽"
