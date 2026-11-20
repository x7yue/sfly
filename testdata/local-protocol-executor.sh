#!/bin/sh
# 假执行器：本地协议（docs/ARCHITECTURE.md §5.4）的用例表（local-protocol-cases.json）用它做「执行器那一端」，
# Agent 和本地调试各自读它留下的东西。读取端把它当 Python 启动（`<根目录>/bin/python -u -m sfly.runner`），参数不看。
#
# 根目录（这个文件的链接所在的 bin/ 的上一级）里的 case/ 有什么就做什么，没有的跳过：
#   events.jsonl      一次写进事件管道（$SFLY_EVENTS）
#   stdout / stderr   原样写到标准输出 / 标准错误
#   output.json       写成 $SFLY_OUTPUT
#   exit-code         退出码，没有时是 0
dir=$(cd "$(dirname "$0")/.." && pwd)/case
[ -f "$dir/events.jsonl" ] && cat "$dir/events.jsonl" >"$SFLY_EVENTS"
[ -f "$dir/stdout" ] && cat "$dir/stdout"
[ -f "$dir/stderr" ] && cat "$dir/stderr" >&2
[ -f "$dir/output.json" ] && cat "$dir/output.json" >"$SFLY_OUTPUT"
exit "$(cat "$dir/exit-code" 2>/dev/null || echo 0)"
