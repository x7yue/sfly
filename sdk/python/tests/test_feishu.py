"""`sfly.feishu`：Markdown 卡片的请求体，以及本地调试用的文本消息组装和原始消息校验。

规则和用例与控制面共用（testdata/feishu-card-cases.json、feishu-text-cases.json、feishu-raw-cases.json，
apps/server/test/feishu-messages.test.ts 跑同一组），保证节点代码里组装的卡片和本地调试打印的消息，
与画布上的「Markdown 卡片」和控制面真正发出的请求体一致。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

import sfly
from sfly import feishu

TESTDATA = Path(__file__).resolve().parents[3] / "testdata"


def expand(value: Any) -> Any:
    """用例里的字符串可以写成 {"$repeat": 单元, "times": 次数, "suffix": 末尾}：先展开。"""
    if isinstance(value, list):
        return [expand(v) for v in value]
    if isinstance(value, dict):
        if "$repeat" in value:
            return value["$repeat"] * value["times"] + value.get("suffix", "")
        return {k: expand(v) for k, v in value.items()}
    return value


def load(name: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((TESTDATA / name).read_text(encoding="utf-8"))
    return loaded


FILE = load("feishu-card-cases.json")
CASES = [(case["name"], case) for case in FILE["cases"]]
TEXT_FILE = load("feishu-text-cases.json")
RAW_FILE = load("feishu-raw-cases.json")


def body_bytes(body: Any) -> int:
    return len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def test_the_case_file_has_content_and_a_20_kb_limit() -> None:
    assert len(CASES) > 10
    assert FILE["limit_bytes"] == 20 * 1024


@pytest.mark.parametrize("case", [c for _, c in CASES], ids=[name for name, _ in CASES])
def test_card_passes_the_shared_cases(case: dict[str, Any]) -> None:
    given = expand(case["input"])
    expected = expand(case["expected"])

    if expected == {"error": "too_large"}:
        with pytest.raises(ValueError, match="太长"):
            feishu.card(given["title"], given["markdown"], given["color"])
        return
    body = feishu.card(given["title"], given["markdown"], given["color"])
    assert body == expected["body"]
    assert body_bytes(body) <= FILE["limit_bytes"]


def test_the_text_case_file_has_content_and_a_20_kb_limit() -> None:
    assert len(TEXT_FILE["cases"]) > 10
    assert TEXT_FILE["limit_bytes"] == 20 * 1024


@pytest.mark.parametrize(
    "case",
    TEXT_FILE["cases"],
    ids=[case["name"] for case in TEXT_FILE["cases"]],
)
def test_text_message_passes_the_shared_cases(case: dict[str, Any]) -> None:
    given = expand(case["input"])
    body = feishu.text_message(given["text"], given["at_all"])
    assert body == expand(case["expected"])["body"]
    assert body_bytes(body) <= TEXT_FILE["limit_bytes"]


def test_the_raw_case_file_has_content_and_a_20_kb_limit() -> None:
    assert len(RAW_FILE["cases"]) > 20
    assert RAW_FILE["limit_bytes"] == 20 * 1024
    assert list(feishu.MSG_TYPES) == RAW_FILE["msg_types"]


@pytest.mark.parametrize(
    "case",
    RAW_FILE["cases"],
    ids=[case["name"] for case in RAW_FILE["cases"]],
)
def test_raw_message_problem_passes_the_shared_cases(case: dict[str, Any]) -> None:
    value = expand(case["input"])["value"]
    expected = expand(case["expected"])
    # 合格时没有原因（原样发出的就是 value 本身）；不合格时原因逐字相等。
    assert feishu.raw_message_problem(value) == expected.get("problem")
    if "body" in expected:
        assert expected["body"] == value


def test_card_is_available_as_sfly_feishu_card_after_import_sfly_and_defaults_to_blue() -> None:
    # 节点代码只写 `import sfly`（或 `from sfly import ...`）就能用 `sfly.feishu.card`。
    code = "import sfly; print(sfly.feishu.card('标题', '正文')['card']['header']['template'])"
    run = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=False)

    assert run.returncode == 0, run.stderr
    assert run.stdout.strip() == "blue"
    assert sfly.feishu.card("标题", "正文") == feishu.card("标题", "正文", "blue")


def test_a_huge_markdown_is_truncated_to_the_same_body_as_one_just_over_the_limit() -> None:
    assert feishu.card("T", "a" * 5_000_000, "blue") == feishu.card("T", "a" * 30_000, "blue")


@pytest.mark.parametrize("color", ["purple", "", "Blue", None])
def test_an_unknown_color_is_a_programming_error(color: Any) -> None:
    with pytest.raises(ValueError, match="color"):
        feishu.card("T", "正文", color)


@pytest.mark.parametrize(
    ("title", "markdown"),
    [(1, "正文"), ("T", None), (None, "正文"), ("T", b"bytes")],
)
def test_a_title_or_markdown_that_is_not_a_string_is_a_programming_error(
    title: Any, markdown: Any
) -> None:
    with pytest.raises(TypeError):
        feishu.card(title, markdown)
