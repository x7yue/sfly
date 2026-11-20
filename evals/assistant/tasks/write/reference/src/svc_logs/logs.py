"""统计日志文件里各级别的行数。"""

from pathlib import Path
from typing import Annotated, TypedDict

from sfly import Context, Doc, node

LEVELS = ("INFO", "WARN", "ERROR")


class LevelCounts(TypedDict):
    total: Annotated[int, Doc("非空行的行数")]
    counts: Annotated[dict[str, int], Doc("INFO、WARN、ERROR 各自的行数，没有的为 0")]
    error_ratio: Annotated[float, Doc("ERROR 行数占非空行的比例，0 到 1，保留 4 位小数")]


@node(title="统计日志级别")
def level_counts(
    ctx: Context,
    path: Annotated[str, Doc("日志文件在本机上的绝对路径")],
) -> LevelCounts:
    """按行统计一个日志文件里 INFO、WARN、ERROR 各有多少行。

    每行的格式是「时间 级别 消息」，级别取第二个字段；别的级别和不合格式的行只计入总行数。

    失败：文件不存在或读不了。
    """
    file = Path(path)
    counts = dict.fromkeys(LEVELS, 0)
    total = 0
    with ctx.action("读取日志", 路径=path):
        if not file.is_file():
            raise FileNotFoundError(f"日志文件不存在：{path}")
        with file.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                fields = line.split()
                if not fields:
                    continue
                total += 1
                if len(fields) > 1 and fields[1] in counts:
                    counts[fields[1]] += 1
    ratio = round(counts["ERROR"] / total, 4) if total else 0.0
    ctx.log.info("%s 共 %d 行，ERROR %d 行", path, total, counts["ERROR"])
    return {"total": total, "counts": counts, "error_ratio": ratio}
