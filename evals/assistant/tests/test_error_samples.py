"""模型错误样本的共用夹具（fixtures/error-samples.json，#548）：评测集的分类对每一条给出夹具里写的类别。

产品（apps/assistant/src/upstream-error.ts）按另一套规则给上游的错误分类；产品的测试
（apps/assistant/test/error-samples.test.ts）用同一份夹具，断言产品的类别对应到同一个评测集类别，
例外在那个测试里逐条列出。这里守的是夹具这一半：评测集的规则改了，夹具和产品的测试跟着改，
不会各改各的。
"""

import json
from pathlib import Path
from typing import Any

import pytest
from aeval.classify import classify

SAMPLES: list[dict[str, str]] = json.loads(
    (Path(__file__).parent / "fixtures" / "error-samples.json").read_text()
)["samples"]


def assistant_error(message: str) -> dict[str, Any]:
    return {
        "type": "message_end",
        "message": {"role": "assistant", "stopReason": "error", "errorMessage": message},
    }


@pytest.mark.parametrize("sample", SAMPLES, ids=[s["name"] for s in SAMPLES])
def test_classify_matches_the_shared_fixture(tmp_path: Path, sample: dict[str, str]) -> None:
    events = tmp_path / "e.jsonl"
    events.write_text(json.dumps(assistant_error(sample["message"])) + "\n")
    assert classify(events, {}, [])["primary"] == sample["eval"]


def test_fixture_has_no_duplicate_names() -> None:
    names = [s["name"] for s in SAMPLES]
    assert len(names) == len(set(names))
