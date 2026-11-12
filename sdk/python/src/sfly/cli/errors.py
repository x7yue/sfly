"""平台命令的统一错误：原因、错误码，以及可以接着执行的下一步命令。"""

from __future__ import annotations

# 命令本身出错（参数不对、连不上控制面、接口返回错误……）的退出码。
EXIT_ERROR = 2


class CliError(Exception):
    """命令没能完成。`code` 是机器可读的错误码：控制面返回的错误码原样沿用，命令行自己产生的错误
    用 snake_case 的短名；`next` 是用户（或 AI 编程助手）接下来可以执行的命令，没有时为 None。
    `message` 可以有多行：第一行写原因，后面是细节（例如候选列表）。"""

    def __init__(self, code: str, message: str, next: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.next = next
