"""探针（#539）第 11 题：跨两次命令依赖后台进程的会话记录。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aeval import bgcheck


def _session(root: Path, name: str, commands: list[tuple[str, str]], **record: Any) -> None:
    folder = root / name
    folder.mkdir(parents=True)
    events = []
    for tool, text in commands:
        args = {"command": text} if tool == "bash" else {"path": text}
        events.append({"type": "tool_execution_start", "toolName": tool, "args": args})
        events.append({"type": "tool_execution_end", "toolName": tool, "result": {}})
    (folder / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    (folder / "session.json").write_text(
        json.dumps({"session": name, "task": "write", "arm": "a", "tier": "上限", **record})
    )


def test_one_cross_command_dependency_and_one_in_the_same_command(tmp_path: Path) -> None:
    _session(
        tmp_path / "run",
        "cross",
        [
            ("bash", "nohup python3 -m http.server 18080 > /tmp/srv.log 2>&1 &"),
            ("read", "/work/a.py"),
            ("bash", "curl -s http://127.0.0.1:18080/health"),
            ("bash", "ls"),
        ],
    )
    _session(
        tmp_path / "run",
        "same",
        [("bash", "python3 -m http.server 18081 & sleep 1; curl -s localhost:18081/")],
    )
    result = bgcheck.scan([tmp_path])
    assert result["sessions"] == 2
    assert result["background_commands"] == 2
    assert result["findings"] == 1
    finding = result["details"][0]
    assert finding["session"] == "cross" and finding["how"] == "端口 18080"
    assert [s["index"] for s in finding["around"]] == [1, 3]
    assert "跨两次工具调用依赖后台进程 1 处" in bgcheck.render(result)
    # 起后台进程的命令逐条列出来供人工看（识别是启发式的）。
    assert [(b["session"], b["index"]) for b in result["background"]] == [
        ("cross", 0),
        ("same", 0),
    ]
    assert "`python3 -m http.server 18081 & sleep 1; curl -s localhost:18081/`" in bgcheck.render(
        result
    )


def test_known_misses_are_listed_for_a_human(tmp_path: Path) -> None:
    # 认不出来的一种：起服务时没写端口，之后连默认端口。不算一处，但起后台进程的命令列出来了。
    _session(
        tmp_path / "run",
        "default-port",
        [("bash", "python3 -m http.server &"), ("bash", "curl -s localhost:8000/")],
    )
    result = bgcheck.scan([tmp_path])
    assert result["findings"] == 0
    assert result["background"] == [
        {"session": "default-port", "index": 0, "text": "python3 -m http.server &"}
    ]


def test_reading_the_output_file_counts(tmp_path: Path) -> None:
    _session(
        tmp_path,
        "log",
        [
            ("bash", "setsid ./worker > /tmp/worker.log 2>&1 < /dev/null &"),
            ("bash", "tail -n 20 /tmp/worker.log"),
        ],
    )
    assert bgcheck.scan([tmp_path])["details"][0]["how"] == "输出文件 /tmp/worker.log"


def test_fake_and_invalid_sessions_are_skipped(tmp_path: Path) -> None:
    commands = [("bash", "nohup srv --port 9001 &"), ("bash", "curl localhost:9001")]
    _session(tmp_path, "fake", commands, model="fake")
    _session(tmp_path, "void", commands, invalid=True)
    assert bgcheck.scan([tmp_path])["sessions"] == 0
    assert bgcheck.scan([tmp_path], include_fake=True)["findings"] == 1


def test_what_counts_as_backgrounding() -> None:
    assert bgcheck.backgrounds("srv &")
    assert bgcheck.backgrounds("nohup srv")
    assert bgcheck.backgrounds("tmux new -s a -d 'srv'")
    assert not bgcheck.backgrounds("make && make test")
    assert not bgcheck.backgrounds("cmd > out 2>&1")
    assert not bgcheck.backgrounds("cmd &> out")
    assert bgcheck.output_files("nohup srv &") == {"nohup.out"}
    assert bgcheck.output_files("srv > /dev/null 2>&1 &") == set()
    assert bgcheck.ports("curl http://sut:9000/x") == {"9000"}
