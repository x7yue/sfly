#!/usr/bin/env bash
# 证明每条性质都能失败：把模型里对应代码检查的那一处改坏（等于改坏代码），在指定的配置下必须被抓到。
# 用法：mutants.sh。每个变异体写成临时模型副本，不改 model/ 里的文件。
# 退出码：0 = 每个变异体都被期望的不变式抓到；1 = 有变异体没被抓到（检查失去了效力）。
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MODEL=$HERE/../model
export TMPDIR=${TMPDIR:-$HOME/.t}
WORK=$(mktemp -d "$TMPDIR/sfly-mutants-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

status=0
mutant() { # 名称 配置 期望违反的不变式 原文 替换（都是 TaskDispatch.tla 里的整行文本）
	local name=$1 cfg=$2 want=$3 from=$4 to=$5
	mkdir -p "$WORK/$name"
	FROM=$from TO=$to python3 -c '
import os, sys
s = open(sys.argv[1]).read()
f, t = os.environ["FROM"], os.environ["TO"]
if s.count(f) != 1:
    sys.exit("变异点在模型里找不到或不唯一：" + f)
open(sys.argv[2], "w").write(s.replace(f, t))
' "$MODEL/TaskDispatch.tla" "$WORK/$name/TaskDispatch.tla" || { echo "ERROR $name：模型已改动，更新变异点"; status=1; return; }
	# 只检查这个变异体针对的性质：TLC 遇到第一个违例就停，别的性质先违反会掩盖它。
	python3 -c '
import re, sys
s = open(sys.argv[1]).read()
open(sys.argv[2], "w").write(re.sub(r"INVARIANTS\n(    .*\n)+", "INVARIANTS\n    TypeOK\n    " + sys.argv[3] + "\n", s))
' "$MODEL/$cfg.cfg" "$WORK/$name/$cfg.cfg" "$want"
	"$HERE/tlc.sh" "$WORK/$name/TaskDispatch.tla" "$WORK/$name/$cfg.cfg" "$WORK/$name/out.txt"
	local got
	got=$(sed -n 's/^Error: Invariant \([A-Za-z0-9_]*\) is violated.*/\1/p' "$WORK/$name/out.txt" | head -1)
	if [[ $got == "$want" ]]; then
		echo "ok    $name（$cfg）：被 $want 抓到"
	else
		echo "MISS  $name（$cfg）：期望 $want，实际 ${got:-无违例}"
		status=1
	fi
}

# ledger.rs Ledger::abandon：Welcome 里 ABANDON 的、还在执行的任务不再被杀掉（删掉 signal(true) 与 abandoned 标记）。
mutant abandon-no-kill Safe NoUnstoppedDuplicate \
	'           kill    == {b \in welcome : b \notin AttemptsOf(unacked) /\ b \in Holding}' \
	'           kill    == {}'
# ledger.rs State::on_hand / Ledger::hello：Hello 不再上报还在安装中（执行器没启动）的任务。
mutant hello-omits-installing Safe SlotBound \
	'    /\ hello'"'"' = [held    |-> Hand,' \
	'    /\ hello'"'"' = [held    |-> HandStarted,'
# engine.ts #applyResult：不再检查任务是否还在 ON_AGENT（接受已放弃尝试的结果）。
mutant result-accepts-stale Safe AtMostOneSuccess \
	'                    /\ cp'"'"' = IF cp[m.a] \notin OnAgent THEN cp' \
	'                    /\ cp'"'"' = IF FALSE THEN cp'
# engine.ts #applyResult：不看 result.status，一律当成功。
mutant result-ignores-status Safe SuccessWasRun \
	'                             ELSE IF m.ok THEN [cp EXCEPT ![m.a] = "success"]' \
	'                             ELSE IF TRUE THEN [cp EXCEPT ![m.a] = "success"]'
# leases.ts agentLost：租约在连接正常时过期，不再强制取消旧尝试（#215）。
mutant lease-expired-no-cancel LateHeartbeats NoUnstoppedDuplicate \
	'    /\ toAgent'"'"' = IF CPConnected THEN Append(toAgent, [type |-> "cancel", as |-> {a}]) ELSE toAgent' \
	'    /\ toAgent'"'"' = toAgent'
# leases.ts agentLost：连续两次心跳都没有上报时，不再强制取消旧尝试（#215）。
mutant heartbeat-lost-no-cancel SlowDelivery NoUnstoppedDuplicate \
	'                       /\ toAgent'"'"' = IF lost = {} THEN toAgent' \
	'                       /\ toAgent'"'"' = IF TRUE THEN toAgent'
# engine.ts #dispatch：不等 Agent 准备好环境（Welcome 之后的第一次心跳）就派发（#219）。
mutant dispatch-before-ready Safe AssignOnlyWhenReady \
	$'    /\\ ready\n    /\\ cp[a] = "queued"' \
	$'    /\\ cp[a] = "queued"'
# lib.rs run() / ledger.rs replace_results_over：反过来把失败换成成功（#723）。换结果只能是成功换失败；换成成功会让一个
# 没有真正执行成功的尝试被控制面记成成功。
mutant replace-fail-to-success Safe SuccessWasRun \
	$'        /\\ r[2]\n        /\\ LET new == <<r[1], FALSE>>' \
	$'        /\\ ~r[2]\n        /\\ LET new == <<r[1], TRUE>>'
# engine.ts #resultTask：已经以 agent_lost 失败的尝试，它迟到的结果照样接受（只拒绝还没派发和已成功的）。
# 被告知停止的尝试也可能报成功（#738：取消在执行器退出之后、开始上传之前到），重试的那次又成功时，一个节点有两次成功。
mutant result-accepts-lost Safe AtMostOneSuccess \
	'                    /\ cp'"'"' = IF cp[m.a] \notin OnAgent THEN cp' \
	'                    /\ cp'"'"' = IF cp[m.a] \in {"none", "queued", "success"} THEN cp'
# released.ts（#505）：租约过期就算离手。Agent 断线时还在执行，之后重连补报，副本却已经删了。
mutant release-on-lease-expiry Safe ReleasedLeftHand \
	'    /\ rel'"'"' = rel  \* 租约过期不算离手：Agent 之后可能重连补报' \
	'    /\ rel'"'"' = [rel EXCEPT !.released = @ \cup {a}]'
# released.ts hello：Welcome 一给放弃就算离手，不等心跳不再列出它。被放弃时还在执行的尝试要等它结束。
mutant release-on-welcome Safe ReleasedLeftHand \
	'                                 !.released = @ \cup (rel.leased \ hello.held)]' \
	'                                 !.released = @ \cup (rel.leased \ hello.held) \cup abandon]'
# released.ts heartbeat：心跳里没列出的都算离手，不只是放弃过的。派发消息还在路上的尝试，Agent 收到之后才开始执行。
mutant heartbeat-releases-unlisted Safe ReleasedLeftHand \
	'                       /\ rel'"'"' = [rel EXCEPT !.released = @ \cup (rel.told \ m.held)]' \
	'                       /\ rel'"'"' = [rel EXCEPT !.released = @ \cup (rel.leased \ m.held)]'
exit $status
