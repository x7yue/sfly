"""助手够得着的容器里，来自评测集的东西不能指向答案或判分：
复制进去的脚本（内容和文件名）、放它们的路径、给助手的命令带上的环境变量。"""

import re

import pytest
from aeval.env import ASSISTANT_SCRIPTS, EVALS_DIR, OPT
from aeval.session import ASSISTANT_ENV, SESSION_DIR

# 出现在这些地方就等于给了提示：题目、答案、判分、看不到的断言、期望的输出。
BANNED = re.compile(
    r"题目|缺陷|答案|判分|断言|看不到|期望|怪癖|参考|"
    r"\bhidden\b|\breference\b|\bsolve\b|\bgrad(e|er|ing)\b|\bexpected\b|\bfixtures?\b|\bselfcheck\b",
    re.IGNORECASE,
)


@pytest.mark.parametrize("name", sorted({n for names in ASSISTANT_SCRIPTS.values() for n in names}))
def test_scripts_in_assistant_containers_have_no_hints(name: str) -> None:
    text = (EVALS_DIR / "container" / name).read_text()
    found = sorted({m.group(0) for m in BANNED.finditer(text)})
    assert not found, f"{name} 里有 {found}"
    assert not BANNED.search(name)


def test_paths_and_environment_have_no_hints() -> None:
    for text in (OPT, SESSION_DIR, *ASSISTANT_ENV, *ASSISTANT_ENV.values()):
        assert not BANNED.search(text), text
