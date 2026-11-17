import type { QueuedTaskView } from "@sfly/schema";
import { QUEUED_LABEL } from "#/lib/copy";
import { formatElapsed } from "#/lib/format";

/**
 * 排队任务的一行时间说明：「排队 1m 05s · 8m 55s 后超时」。`now` 是控制面时间（毫秒）。
 * 过了排队超时、控制面还没扫到时写「即将超时」；没有设置排队超时的任务只写排队了多久。
 */
export function queueTiming(
	task: Pick<QueuedTaskView, "queued_at" | "queue_expires_at">,
	now: number,
): string {
	const waited = `${QUEUED_LABEL} ${formatElapsed(now - new Date(task.queued_at).getTime())}`;
	if (task.queue_expires_at === null) return waited;
	const remaining = new Date(task.queue_expires_at).getTime() - now;
	return `${waited} · ${remaining > 0 ? `${formatElapsed(remaining)} 后超时` : "即将超时"}`;
}
