import type { QueueWaitView, SlotHolderView } from "@sfly/schema";
import { queueTiming } from "#/agents/queue-timing";
import { runNodeName } from "#/components/node-name";
import { moreLabel, QUEUE_WAIT } from "#/lib/copy";
import { formatElapsed, shortId } from "#/lib/format";

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
		disabled: QUEUE_WAIT.disabled(since),
		offline: QUEUE_WAIT.offline(since),
		preparing: QUEUE_WAIT.preparing(since),
		version_mismatch: QUEUE_WAIT.versionMismatch,
		slots_full: QUEUE_WAIT.slotsFull(wait.slots ?? 0),
		dispatching: QUEUE_WAIT.dispatching,
	}[wait.state];
	return {
		situation,
		timing: queueTiming({ queued_at: queuedAt, queue_expires_at: wait.expires_at }, now),
		holders: wait.holders.slice(0, MAX_SLOT_HOLDERS),
		moreHolders: Math.max(wait.holders.length - MAX_SLOT_HOLDERS, 0),
		otherProjects: wait.other_project_holders,
	};
}

/** 占着槽位的任务的场景名和运行：「压测（运行 5e2d1c7a）」。 */
export const holderRunLabel = (holder: SlotHolderView): string =>
	`${holder.orchestration_name}（${QUEUE_WAIT.holderRun(shortId(holder.run_id))}）`;

/** 占着槽位的任务里的节点：「核对结果（verify）」，子流程里的节点前面写子流程名称。 */
export function holderNodeLabel(holder: SlotHolderView): string {
	const chain = holder.chain_name === null ? "" : `${holder.chain_name} / `;
	return `${chain}${runNodeName(holder)}`;
}

/** 占着槽位的任务写成一段文字：「压测（运行 5e2d1c7a）的 核对结果（verify）」。 */
export const holderLabel = (holder: SlotHolderView): string =>
	`${holderRunLabel(holder)}的 ${holderNodeLabel(holder)}`;

/**
 * 占着槽位的任务之后的说明：列不下的「还有 N 个」，和别的项目的任务个数（「另有别的项目的任务 2 个」）。
 * 没有要说的时候是空串。
 */
export function holdersRest(
	parts: { moreHolders: number; otherProjects: number },
	afterOwn: boolean,
) {
	const rest = [
		parts.moreHolders > 0 ? moreLabel(parts.moreHolders) : "",
		parts.otherProjects > 0 ? QUEUE_WAIT.otherProjects(parts.otherProjects, afterOwn) : "",
	].filter(Boolean);
	return rest.join("，");
}

/** 只放得下一句话的地方（读屏名称、空状态里的一行）：整句话写成一段文字。 */
export function queueWaitText(wait: QueueWaitView, queuedAt: string, now: number): string {
	const parts = queueWaitParts(wait, queuedAt, now);
	const base = `${QUEUE_WAIT.waitingFor} ${wait.agent}（${parts.situation}）· ${parts.timing}`;
	const own = parts.holders.map(holderLabel).join("、");
	const rest = holdersRest(parts, own !== "");
	if (own === "" && rest === "") return base;
	return `${base}；${QUEUE_WAIT.holders}：${own}${own && rest ? "，" : ""}${rest}`;
}
