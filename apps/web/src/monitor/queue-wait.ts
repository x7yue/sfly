import type { QueueWaitView, SlotHolderView } from "@sfly/schema";
import { queueTiming } from "#/agents/queue-timing";
import { runNodeName } from "#/components/node-name";
import { moreLabel, QUEUE_WAIT } from "#/lib/copy";
import { formatElapsed } from "#/lib/format";

/** 排队中的节点最多列出几个占着槽位的任务，其余写「还有 N 个」。 */
export const MAX_SLOT_HOLDERS = 3;

/**
 * 排队中的节点在等什么，拆成界面上的几段（运行视图里排队中的尝试的 `queue_wait`，写法见 `QUEUE_WAIT`）：
 * 「等 agent-a」后面括号里这台 Agent 现在的情况、「排队 3m 05s · 6m 55s 后超时」，以及槽位占满时占着槽位的任务。
 * `now` 是控制面时间（毫秒）：页面上的时钟按控制面时间走（ADR 0018），不用浏览器的时钟推算。
 */
export function queueWaitParts(wait: QueueWaitView, queuedAt: string, now: number) {
	const since = wait.since === null ? null : formatElapsed(now - Date.parse(wait.since));
	const situation = {
		offline: QUEUE_WAIT.offline(since),
		preparing: QUEUE_WAIT.preparing(since),
		version_mismatch: QUEUE_WAIT.versionMismatch,
		slots_full: QUEUE_WAIT.slotsFull(wait.slots ?? 0),
		dispatching: QUEUE_WAIT.dispatching,
	}[wait.state];
	return {
		situation,
		timing: queueTiming({ queued_at: queuedAt, queue_expires_at: wait.expires_at }, now),
		holders: wait.holders.slice(0, MAX_SLOT_HOLDERS).map(holderLabel),
		moreHolders: Math.max(wait.holders.length - MAX_SLOT_HOLDERS, 0),
	};
}

/** 占着槽位的任务：「压测 的 核对结果（verify）」，子流程里的节点前面写子流程名称。 */
export function holderLabel(holder: SlotHolderView): string {
	const chain = holder.chain_name === null ? "" : `${holder.chain_name} / `;
	return `${holder.orchestration_name} 的 ${chain}${runNodeName(holder)}`;
}

/** 只放得下一句话的地方（读屏名称、空状态里的一行）：整句话写成一段文字。 */
export function queueWaitText(wait: QueueWaitView, queuedAt: string, now: number): string {
	const { situation, timing, holders, moreHolders } = queueWaitParts(wait, queuedAt, now);
	const base = `${QUEUE_WAIT.waitingFor} ${wait.agent}（${situation}）· ${timing}`;
	if (holders.length === 0) return base;
	const more = moreHolders > 0 ? `，${moreLabel(moreHolders)}` : "";
	return `${base}；${QUEUE_WAIT.holders}：${holders.join("、")}${more}`;
}
