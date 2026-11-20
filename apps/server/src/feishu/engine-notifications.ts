import type { RunRow, Step } from "../engine/step.js";
import type { FeishuDelivery } from "./feishu-delivery.js";
import { enqueueRunNotification, type FocusAtRunEndDeps } from "./run-notification.js";

/** 一个 step 在事务里留下的、要等提交之后才能做的飞书通知收尾。 */
export interface PendingNotifications {
	/** 这个事务往飞书发送队列里写了消息：提交后唤醒投递。 */
	queued: boolean;
}

export const noPendingNotifications = (): PendingNotifications => ({ queued: false });

/** 运行结束了：运行和它的最终状态（「查看运行」链接、失败的节点、关注项都按这个运行读）。 */
export interface FinishedRun {
	run: RunRow;
	status: "success" | "failed" | "cancelled";
}

/**
 * 引擎推进时的飞书通知副作用（ADR 0020）：运行结束时在 step 的事务里把运行通知写进发送队列；
 * 事务提交之后唤醒投递。引擎只通过这里和飞书发送队列、投递打交道，调度的核心不跟着通知的规则一起变。
 * 通知从不改变节点、任务、链和运行的状态，也不让它们失败。
 */
export class EngineNotifications {
	constructor(
		private readonly deps: {
			/** 飞书发送队列的投递；入队后唤醒它。 */
			delivery: Pick<FeishuDelivery, "wake">;
			/** 运行通知卡片里「查看运行」的链接；没有配置 SFLY_PUBLIC_URL 时返回 undefined（卡片没有按钮）。 */
			runUrl: (runId: string) => string | undefined;
			/** 运行通知卡片里「关注项」一段的值：和 `GET /runs/:id/focus` 同一份解析，读不出来时只报告。 */
			focusDeps: FocusAtRunEndDeps;
		},
	) {}

	/**
	 * 运行刚结束（在写入运行最终状态的事务里调用）：读场景当前的运行通知设置，满足条件就写进发送队列（#232）。
	 * 调用方保证只有第一次把运行记为结束的事务调用，同一个运行不会发两张卡片。
	 */
	async runFinished(step: Step, finished: FinishedRun): Promise<void> {
		await enqueueRunNotification(step, {
			...finished,
			runUrl: this.deps.runUrl(finished.run.id),
			focusDeps: this.deps.focusDeps,
		});
	}

	/** step 的事务提交之后：唤醒投递。 */
	async committed(pending: PendingNotifications): Promise<void> {
		if (pending.queued) this.deps.delivery.wake();
	}
}
