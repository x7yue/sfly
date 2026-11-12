#!/usr/bin/env bash
# 一条命令检查任务派发协议模型：check.sh
# - Safe：心跳不迟到、投递及时；LateHeartbeats：连接正常时租约也可能过期；SlowDelivery：消息可能晚于两个心跳周期。
#   三个配置下四条性质都必须成立（期望：无违例）。
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
run LateHeartbeats pass
run SlowDelivery pass
echo "完整输出：$OUT"
exit $status
