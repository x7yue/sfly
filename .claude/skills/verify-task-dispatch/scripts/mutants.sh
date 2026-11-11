#!/usr/bin/env bash
# 证明每条性质都能失败：把模型里对应代码检查的那一处改坏（等于改坏代码），在 Safe 配置下必须被抓到。
# 用法：mutants.sh。每个变异体写成临时模型副本，不改 model/ 里的文件。
# 退出码：0 = 每个变异体都被期望的不变式抓到；1 = 有变异体没被抓到（检查失去了效力）。
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MODEL=$HERE/../model
export TMPDIR=${TMPDIR:-$HOME/.t}
WORK=$(mktemp -d "$TMPDIR/sfly-mutants-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

status=0
mutant() { # 名称 期望违反的不变式 原文 替换（都是 TaskDispatch.tla 里的整行文本）
	local name=$1 want=$2 from=$3 to=$4
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
' "$MODEL/Safe.cfg" "$WORK/$name/Safe.cfg" "$want"
	"$HERE/tlc.sh" "$WORK/$name/TaskDispatch.tla" "$WORK/$name/Safe.cfg" "$WORK/$name/out.txt"
	local got
	got=$(grep -oP '^Error: Invariant \K\w+(?= is violated)' "$WORK/$name/out.txt" | head -1)
	if [[ $got == "$want" ]]; then
		echo "ok    $name：被 $want 抓到"
	else
		echo "MISS  $name：期望 $want，实际 ${got:-无违例}"
		status=1
	fi
}

# lib.rs run()：Welcome 里 ABANDON 的任务不再被杀掉（删掉 cancel_task 与 abandoned.insert）。
mutant abandon-no-kill NoUnstoppedDuplicate \
	'           kill    == {b \in welcome : b \notin AttemptsOf(unacked) /\ b \in Holding}' \
	'           kill    == {}'
# lib.rs held_tasks / held_collecting：Hello 不再上报还在安装中（执行器没启动）的任务。
mutant hello-omits-installing SlotBound \
	'          /\ hello'"'"' = [held    |-> Holding \cup AttemptsOf(unacked2),' \
	'          /\ hello'"'"' = [held    |-> StartedOnAgent \cup AttemptsOf(unacked2),'
# engine.ts #applyResult：不再检查任务是否还在 ON_AGENT（接受已放弃尝试的结果）。
mutant result-accepts-stale AtMostOneSuccess \
	'                    /\ cp'"'"' = IF cp[m.a] \notin OnAgent THEN cp' \
	'                    /\ cp'"'"' = IF FALSE THEN cp'
# engine.ts #applyResult：不看 result.status，一律当成功。
mutant result-ignores-status SuccessWasRun \
	'                             ELSE IF m.ok THEN [cp EXCEPT ![m.a] = "success"]' \
	'                             ELSE IF TRUE THEN [cp EXCEPT ![m.a] = "success"]'
exit $status
