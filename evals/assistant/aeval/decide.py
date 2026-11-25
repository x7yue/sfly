"""对照实验的判定（#442「pi 的循环跑在哪」、#443 的追加评论），标准是事先定下的，这里只照着算。

远程的那一臂（臂 B，#552 起是平台臂 p）和臂 A 比，同时满足下面三条才算没有明显变差：
1. 通过的题数比臂 A 少不超过 1 题；
2. 轮数的中位数不超过臂 A 的 1.3 倍；
3. 没有只在远程那一臂出现两次以上的失败类型。
臂 B 的结论是 #442 的选择：满足选方案甲（单独的助手容器加远程工具），
否则选方案乙（循环就在工作台里）。
平台臂的结论是平台内的助手比原版 pi 有没有明显变差：变差了按 #552 记到 #443，再定在产品里补什么。

「通过的题数」按通过的会话数算（同一组题、每题同样的次数，两臂可以直接比）。两臂的会话数不一样时
判定不成立，要先补齐。环境故障作废的会话不算，但两臂各作废多少要列出来：相差悬殊时提醒。
边界上：恰好少 1 次满足第一条，恰好 1.3 倍满足第二条（整数比较，不受浮点影响），
恰好 2 次算第三条里的「两次以上」。
"""

from __future__ import annotations

import statistics
from collections import Counter
from typing import Any

# 标准要求的样本：四道题，每题每臂 5 次（#443）。少于它也照算，但标明只作参考。
REQUIRED_TASKS = 4
REQUIRED_PER_TASK = 5

# 判为方案乙时还有一道前提（#443 里在臂 B 有任何真实模型的结果之前写下的说明）：越权探测发现的两件事
# （pi 的读工具读得到进程环境里的令牌、编辑工具改得了 pi 自己的文件）要先证明堵得住，且堵住之后
# 四道题的通过情况不变；堵不住就选方案甲。这里不把它算进三条标准，只在输出里提示。
OPTION_B_PREREQUISITE = "https://github.com/x7yue/sfly/issues/443#issuecomment-7049455603"

# 两臂之间已知的、可能对臂 B 有利的差别（remote-tools/README.md 的语义差别清单）。
KNOWN_B_ADVANTAGES = [
    "命令的超时：能力端口要求命令必须有超时，模型没给时臂 B 用会话的时间上限；pi 本地的命令工具"
    "没有可设的默认超时，臂 A 的命令一直等到会话被结束。两者在会话的时间上限处一起结束，"
    "臂 B 不会因此把卡住的命令提前救回来，但实现不同，列在这里。",
]


# 各臂在表格和判定里的叫法。
ARM_NAMES = {"a": "臂 A（本地）", "b": "臂 B（远程）", "p": "平台臂"}
SHORT_NAMES = {"a": "臂 A", "b": "臂 B", "p": "平台臂"}
VERDICTS = {
    "b": ("方案甲（单独的助手容器加远程工具）", "方案乙（循环就在工作台里）"),
    "p": ("平台臂没有明显变差", "平台臂明显变差（结果记到 #443，再定在产品里补什么）"),
}


def _arm(records: list[dict[str, Any]], model: str, arm: str) -> list[dict[str, Any]]:
    return [r for r in records if r["model"] == model and str(r.get("arm", "a")) == arm]


def limits_of(records: list[dict[str, Any]]) -> list[str]:
    """这些会话实际用的上限（各自 `driver.json` 里记的），去重排序。
    没记上限的会话（很早以前的记录、被结束了没写 `driver.json` 的）不算，不让它把两臂的上限变成
    「不一样」。"""
    found = set()
    for record in records:
        given = (record.get("driver") or {}).get("limits") or {}
        if given:
            found.add(f"{given.get('max_turns', '?')} 轮、{given.get('max_seconds', '?')} 秒")
    return sorted(found)


def turns_within(turns_b: float, turns_a: float) -> bool:
    """远程那一臂的轮数中位数不超过臂 A 的 1.3 倍。
    中位数是整数或 .5，乘 10 后是整数，比较是精确的。"""
    return round(10 * turns_b) <= 13 * turns_a


def decide(records: list[dict[str, Any]], model: str, remote: str = "b") -> dict[str, Any]:
    """records 是全部会话（作废的也在里面，用来数作废次数），判定只用有效的。
    `remote` 是和臂 A 比的那一臂。
    结果里按臂的字母分开（`a` 和 `remote`）。"""
    name = SHORT_NAMES[remote]
    all_b = _arm(records, model, remote)
    tasks = sorted({r["task"] for r in all_b})
    # 只比两臂都跑了的题：臂 A 里多出来的题（例如只在第一轮跑过的）不算。
    all_a = [r for r in _arm(records, model, "a") if r["task"] in tasks]
    invalid = {
        "a": sum(1 for r in all_a if r.get("invalid")),
        remote: sum(1 for r in all_b if r.get("invalid")),
    }
    a = [r for r in all_a if not r.get("invalid")]
    b = [r for r in all_b if not r.get("invalid")]
    counts_a = Counter(r["task"] for r in a)
    counts_b = Counter(r["task"] for r in b)
    balanced = bool(tasks) and counts_a == counts_b
    passed_a = sum(r["grade"]["passed"] for r in a)
    passed_b = sum(r["grade"]["passed"] for r in b)
    turns_a = statistics.median(r["driver"]["turns"] for r in a) if a else None
    turns_b = statistics.median(r["driver"]["turns"] for r in b) if b else None
    fail_a = Counter((r.get("failure") or {}).get("primary") for r in a if not r["grade"]["passed"])
    fail_b = Counter((r.get("failure") or {}).get("primary") for r in b if not r["grade"]["passed"])
    only_b = {kind: n for kind, n in fail_b.items() if n >= 2 and not fail_a.get(kind)}
    criteria = {
        "通过的题数比臂 A 少不超过 1 题": passed_a - passed_b <= 1,
        "轮数的中位数不超过臂 A 的 1.3 倍": (
            turns_a is not None and turns_b is not None and turns_within(turns_b, turns_a)
        ),
        # 中文和字母之间留空格：「臂 B 出现」「平台臂出现」。
        f"没有只在{name}{' ' if name[-1].isascii() else ''}出现两次以上的失败类型": not only_b,
    }
    verdict = None
    if balanced:
        good, bad = VERDICTS[remote]
        verdict = good if all(criteria.values()) else bad
    limits = {"a": limits_of(a), remote: limits_of(b)}
    # 远程那一臂没通过的会话里，主类是平台故障的有几次（有效的会话）；未归类的会话作废了，另数。
    platform_faults = sum(
        1
        for r in b
        if not r["grade"]["passed"] and (r.get("failure") or {}).get("primary") == "平台故障"
    )
    unclassified = sum(
        1 for r in all_b if r.get("invalid") and (r.get("failure") or {}).get("primary") == "未归类"
    )
    enough = len(tasks) >= REQUIRED_TASKS and all(n >= REQUIRED_PER_TASK for n in counts_b.values())
    return {
        "model": model,
        "remote": remote,
        "tasks": tasks,
        "sessions": {"a": dict(counts_a), remote: dict(counts_b)},
        "balanced": balanced,
        "enough_samples": balanced and enough,
        "invalid": invalid,
        "passed": {"a": passed_a, remote: passed_b},
        "turns_median": {"a": turns_a, remote: turns_b},
        "failures": {"a": dict(fail_a), remote: dict(fail_b)},
        "only_in_remote": only_b,
        "limits": limits,
        "limits_match": limits["a"] == limits[remote],
        "platform_faults": platform_faults,
        "unclassified": unclassified,
        "criteria": criteria,
        "verdict": verdict,
    }


def invalid_lopsided(invalid: dict[str, int]) -> bool:
    """两臂作废的次数相差悬殊：差 2 次以上，而且多的是少的两倍以上。"""
    low, high = sorted(invalid.values())
    return high - low >= 2 and high >= 2 * low


def render_decision(result: dict[str, Any]) -> str:
    sessions = result["sessions"]
    b = str(result["remote"])
    lines = [
        f"**对照实验：{result['model']}，臂 A 对{ARM_NAMES[b]}**"
        f"（题目：{'、'.join(result['tasks'])}）",
        "",
        f"| | {ARM_NAMES['a']} | {ARM_NAMES[b]} |",
        "|---|---|---|",
        f"| 有效会话数 | {sum(sessions['a'].values())} | {sum(sessions[b].values())} |",
        f"| 作废（环境故障、未归类） | {result['invalid']['a']} | {result['invalid'][b]} |",
        f"| 通过 | {result['passed']['a']} | {result['passed'][b]} |",
        f"| 轮数中位数 | {result['turns_median']['a']} | {result['turns_median'][b]} |",
        f"| 失败分类 | {_counts(result['failures']['a'])} | {_counts(result['failures'][b])} |",
        "",
    ]
    for name, ok in result["criteria"].items():
        lines.append(f"- {'满足' if ok else '不满足'}：{name}")
    if result["verdict"] is None:
        lines.append("- 两臂每道题的有效会话数不一样，判定不成立，先补齐")
    else:
        caveats = []
        if not result["limits_match"]:
            caveats.append(
                f"两臂的上限不一样，臂 A {'、'.join(result['limits']['a'])}，"
                f"{SHORT_NAMES[b]} {'、'.join(result['limits'][b])}，轮数和超时不可比"
            )
        if result["unclassified"]:
            caveats.append(
                f"{SHORT_NAMES[b]}有 {result['unclassified']} 次会话未归类"
                "（作废，见上面的未归类表）"
            )
        caveat = f"（只作参考：{'；'.join(caveats)}）" if caveats else ""
        lines.append(f"- 按事先定下的标准：{result['verdict']}{caveat}")
        if result["platform_faults"]:
            lines.append(
                f"- {SHORT_NAMES[b]}没通过的会话里有 {result['platform_faults']} 次是平台故障"
                "（平台这一侧出的问题，逐次见上面的平台故障表）"
            )
        if not result["enough_samples"]:
            lines.append(
                f"- 样本不足：标准要求 {REQUIRED_TASKS} 道题、每题每臂 {REQUIRED_PER_TASK} 次，"
                "这里不够，结果只作参考"
            )
        if b == "b" and result["verdict"].startswith("方案乙"):
            lines.append(
                "- 注意：三条标准只回答「远程工具会不会让模型明显变差」。"
                "选方案乙之前，还要证明越权探测发现的两件事堵得住、"
                "堵住之后四道题的通过情况不变，堵不住就选方案甲，"
                f"见 {OPTION_B_PREREQUISITE}"
            )
    if invalid_lopsided(result["invalid"]):
        lines.append(
            "- 提醒：两臂作废的次数相差悬殊，上游的状态可能偏向了某一臂，看一下作废的时间和原因"
        )
    if b == "b":
        lines.append("- 对臂 B 有利的已知差别：")
        lines.extend(f"  - {item}" for item in KNOWN_B_ADVANTAGES)
    return "\n".join(lines)


def _counts(counter: dict[str, int]) -> str:
    return "、".join(f"{k} {v}" for k, v in counter.items()) or "-"
