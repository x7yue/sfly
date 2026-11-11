#!/usr/bin/env bash
# 一条命令检查任务派发协议模型：check.sh
# - Safe：心跳不迟到、投递及时时，四条性质都必须成立（期望：无违例）。
# - LateHeartbeats、SlowDelivery：当前代码的已知发现（期望：NoUnstoppedDuplicate 被违反）。
#   如果它们变成无违例，说明发现已被修复：按 SKILL.md「修复发现之后」更新 skill。
# 完整输出（含反例）写到 $SFLY_FORMAL_OUT（默认 ~/.local/state/sfly-formal/<时间>/）。
# 退出码：0 = 结果与 SKILL.md 记录的一致；1 = 不一致（新违例或发现消失）；2 = 工具或模型错误。
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MODEL=$HERE/../model
OUT=${SFLY_FORMAL_OUT:-$HOME/.local/state/sfly-formal/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"

status=0
run() { # 配置名 期望（pass | 违反的不变式名）
	local cfg=$1 want=$2 log=$OUT/$1.txt
	"$HERE/tlc.sh" "$MODEL/TaskDispatch.tla" "$MODEL/$cfg.cfg" "$log"
	local code=$?
	local got
	if ((code == 0)); then
		got=pass
	elif ((code == 12)); then
		got=$(grep -oP '^Error: Invariant \K\w+(?= is violated)' "$log" | head -1)
	else
		echo "ERROR $cfg：TLC 退出码 $code，看 $log"
		status=2
		return
	fi
	local states
	states=$(grep -oP '[0-9,]+(?= distinct states found)' "$log" | tail -1)
	if [[ $got == "$want" ]]; then
		echo "ok    $cfg：$got（${states:-?} 个不同状态）"
	else
		echo "DIFF  $cfg：期望 $want，实际 $got（反例在 $log）"
		((status < 1)) && status=1
	fi
}

run Safe pass
run LateHeartbeats NoUnstoppedDuplicate
run SlowDelivery NoUnstoppedDuplicate
echo "完整输出：$OUT"
exit $status
