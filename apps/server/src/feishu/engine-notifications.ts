import { sql } from "drizzle-orm";
import type { RunRow, Step } from "../engine/step.js";
import type { FeishuDelivery } from "./feishu-delivery.js";
import { enqueueRunNotification } from "./run-notification.js";

/** 一个 step 在事务里留下的、要等提交之后才能做的飞书通知收尾。 */
export interface PendingNotifications {
	/** 这个事务往飞书发送队列里写了消息：提交后唤醒投递。 */
	queued: boolean;
}

/** 事务还能不能继续用：一条最轻的查询。 */
async function usable(tx: Step["tx"]): Promise<boolean> {
	try {
		await tx.execute(sql`select 1`);
		return true;
	} catch {
		return false;
	}
}

export const noPendingNotifications = (): PendingNotifications => ({ queued: false });

/** 运行结束了：运行和它的最终状态（「查看运行」链接、第一个失败的节点和失败原因都按这个运行读）。 */
export interface FinishedRun {
	run: RunRow;
	status: "success" | "failed" | "cancelled";
}

/**
 * 引擎推进时的飞书通知副作用（ADR 0020）：运行失败或被取消时在 step 的事务里把运行通知写进发送队列（成功的运行不发）；
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
			/** 为这次运行准备通知时出了错，这次不发：只报告（记日志），运行照常结束。 */
			onError: (error: unknown, runId: string) => void;
		},
	) {}

	/**
	 * 运行刚结束（在写入运行最终状态的事务里调用）：读场景当前的运行通知设置，满足条件就写进发送队列（#232）。
	 * 调用方保证只有第一次把运行记为结束的事务调用，同一个运行不会发两张卡片。
	 *
	 * **通知不能拦住运行结束**（规格：飞书投递失败不影响运行状态）。投递本身在事务之外（入队之后由 {@link FeishuDelivery} 发），
	 * 但入队之前为通知做的几步查询（场景设置、第一个失败的节点、机器人是否登记）和拼卡片在这个事务里：
	 * 任何一步出错（不认识的触发条件、读取出错、卡片拼不出来）都会让整个事务回滚，运行和节点就卡在「执行中」。
	 * 所以放进保存点：出错时回到保存点（这个事务里别的写入，包括运行的最终状态，原样保留，事务还能继续用），
	 * 报告错误，这次不发。没有选择「提交之后再读再发」：那样运行已经结束了，读到的场景设置和失败原因可能已经变了，
	 * 也要另开事务写发送队列，运行结束和入队不再是一个整体（#232 定下的：同一个事务里，重启时不会漏发也不会重复发）。
	 */
	async runFinished(step: Step, finished: FinishedRun): Promise<void> {
		try {
			await step.tx.transaction(async (savepoint) => {
				await enqueueRunNotification(
					{ ...step, tx: savepoint },
					{ ...finished, runUrl: this.deps.runUrl(finished.run.id) },
				);
			});
		} catch (error) {
			// 通知自己的错：保存点已经回滚，事务还能用。连接断了这类错不是通知自己的：回滚保存点都失败，整个事务已经没了，
			// 往外抛，由已有的处理接手（事件处理失败，Agent 的流被关，它重连后重发结果）；这时不能记「这次不发」，
			// 因为运行结束的事务没有提交，不是「不发、运行照常结束」。用一条最轻的查询判断事务还能不能用。
			if (!(await usable(step.tx))) throw error;
			this.deps.onError(error, finished.run.id);
		}
	}

	/** step 的事务提交之后：唤醒投递。 */
	async committed(pending: PendingNotifications): Promise<void> {
		if (pending.queued) this.deps.delivery.wake();
	}
}
