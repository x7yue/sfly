"""把一次会话的事件流压成便于阅读的文字：助手说的话、每次工具调用和结果的开头几行。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aeval.classify import read_events, tool_result_text


def _short(text: str, lines: int) -> str:
    rows = text.rstrip().splitlines()
    more = f"\n    …（还有 {len(rows) - lines} 行）" if len(rows) > lines else ""
    return "\n".join("    " + r[:200] for r in rows[:lines]) + more


def render(session_dir: Path, result_lines: int = 8) -> str:
    out: list[str] = []
    turn = 0
    for event in read_events(session_dir / "events.jsonl"):
        kind = event.get("type")
        if kind == "turn_start":
            turn += 1
        elif kind == "message_end":
            message: dict[str, Any] = event.get("message") or {}
            if message.get("role") != "assistant":
                continue
            for block in message.get("content") or []:
                if block.get("type") == "text" and str(block.get("text", "")).strip():
                    out.append(f"[{turn}] 助手：{_short(str(block['text']), 12).strip()}")
            if message.get("stopReason") == "error":
                out.append(f"[{turn}] 模型出错：{message.get('errorMessage')}")
        elif kind == "tool_execution_start":
            args = json.dumps(event.get("args"), ensure_ascii=False)
            out.append(f"[{turn}] → {event.get('toolName')} {args[:400]}")
        elif kind == "tool_execution_end":
            text = tool_result_text(event.get("result"))
            mark = "✗" if event.get("isError") else "←"
            out.append(f"[{turn}] {mark}\n{_short(text, result_lines)}")
    return "\n".join(out)
