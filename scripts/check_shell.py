#!/usr/bin/env python3
"""shell 脚本的检查（`pnpm lint:shell`，#433）：仓库里全部 `.sh` 和 `.githooks/pre-push`。

1. 变量后面紧跟着汉字（`"$name：…"`）：写成 `${name}`。macOS 自带的 bash 3.2 在 UTF-8 语言环境下
   把汉字的字节算进变量名，`set -u` 时报 unbound variable（退出码 127），只在走到那一行时才出错。
   注释行不查。
2. shellcheck：和 `pnpm lint:actions` 用同一个镜像里的那一份（`scripts/lint-actions.sh`
   的 `image=`）；没有 docker 时用本机的 shellcheck（`pnpm linux` 的镜像里有同一个版本）。
   按脚本的 shebang 定方言，`install.sh` 是 `#!/bin/sh`，按 POSIX sh 查。
   `source` 的文件跟着查（`-x`，相对脚本所在的目录）。
   要放行一处，在那一行上面写 `# shellcheck disable=SC编号 # 原因`，原因必填（这里检查）。

用法：`check_shell.py [文件...]`，不给文件时查全部。
有问题时逐条写出「文件:行:列」和怎么改，退出码 1。
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
# `$名字` 紧跟着非 ASCII 字符；`\$`、`$$` 不算。
VAR_THEN_WIDE = re.compile(r"(?<![\\$])\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])")
# 放行写法：disable 后面要有 `# 原因`。
DISABLE = re.compile(r"#\s*shellcheck\s+disable=([A-Z0-9,]+)(.*)$")


def shell_files() -> list[str]:
    listed = subprocess.run(
        ["git", "ls-files", "*.sh", ".githooks/pre-push"],
        cwd=REPO,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return listed.split()


def own_problems(path: str, text: str) -> list[str]:
    problems: list[str] = []
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.lstrip()
        disable = DISABLE.search(line)
        if disable and not re.match(r"\s*#\s*\S", disable.group(2)):
            problems.append(
                f"{path}:{number}: shellcheck disable={disable.group(1)} 没有写原因："
                "在后面接 `# 原因`"
            )
        if stripped.startswith("#"):
            continue
        for match in VAR_THEN_WIDE.finditer(line):
            name = match.group(1)
            problems.append(
                f"{path}:{number}:{match.start() + 1}: ${name} 后面紧跟着汉字，写成 ${{{name}}}"
                "（macOS 的 bash 3.2 在 UTF-8 下会把汉字的字节算进变量名，报 unbound variable）"
            )
    return problems


def shellcheck_command() -> list[str]:
    image = re.search(r"^image=(\S+)$", (REPO / "scripts/lint-actions.sh").read_text(), re.M)
    if image and shutil.which("docker"):
        info = subprocess.run(["docker", "info"], capture_output=True, check=False)
        if info.returncode == 0:
            return [
                "docker",
                "run",
                "--rm",
                "-v",
                f"{REPO}:/repo:ro",
                "-w",
                "/repo",
                "--entrypoint",
                "shellcheck",
                image.group(1),
            ]
    if shutil.which("shellcheck"):
        return ["shellcheck"]
    raise SystemExit("lint:shell：需要 docker 或 shellcheck（brew install shellcheck）")


def main(argv: list[str]) -> int:
    files = argv or shell_files()
    problems: list[str] = []
    for path in files:
        problems += own_problems(path, (REPO / path).read_text(encoding="utf-8"))
    checked = subprocess.run(
        [*shellcheck_command(), "-x", "-P", "SCRIPTDIR", "-f", "gcc", *files],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,
    )
    problems += checked.stdout.splitlines()
    if checked.returncode not in (0, 1):
        problems.append(
            f"shellcheck 没有跑完（退出码 {checked.returncode}）：{checked.stderr.strip()}"
        )
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        print(
            f"lint:shell：{len(problems)} 处要改（shellcheck 的规则见 https://www.shellcheck.net/wiki/）",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
