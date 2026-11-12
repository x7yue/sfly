import type { FeishuNotifyNode, ResolveScope } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { tasks } from "../db/schema.js";
import type { ChainRow, RunRow, Step } from "../engine/step.js";
import { firstAttempt } from "../engine/step.js";
import type { TaskLogs } from "../logs/task-logs.js";
import { feishuBotGone, registeredBots } from "./bot-checks.js";
import type { FeishuDelivery } from "./feishu-delivery.js";
import { enqueueFeishuMessage } from "./feishu-queue.js";
import { prepareNotification } from "./notify-node.js";
import { enqueueRunNotification } from "./run-notification.js";

/** 一个 step 在事务里留下的、要等提交之后才能做的飞书通知收尾。 */
export interface PendingNotifications {
	/** 提交后写进任务日志的控制面日志行（source system）：日志文件不在事务里，事务回滚时不该留下它们。 */
	logs: Array<{ taskId: string; level: "info" | "warn"; text: string }>;
	/** 这个事务往飞书发送队列里写了消息：提交后唤醒投递。 */
	queued: boolean;
}

export const noPendingNotifications = (): PendingNotifications => ({ logs: [], queued: false });

/** 运行结束了：运行的最终状态，以及用它算「查看运行」链接、失败的节点的运行和文档。 */
export interface FinishedRun {
	run: RunRow;
	status: "success" | "failed" | "cancelled";
	document: OrchestrationDocument;
}

/**
 * 引擎推进时的飞书通知副作用（ADR 0020）：飞书通知节点轮到执行、运行结束，都在 step 的事务里把消息写进发送队列；
 * 事务提交之后写任务日志、唤醒投递。引擎只通过这里和飞书发送队列、投递打交道，调度的核心不跟着通知的规则一起变。
 * 通知从不改变节点、任务、链和运行的状态，也不让它们失败。
 */
export class EngineNotifications {
	constructor(
		private readonly deps: {
			/** 控制面自己写任务日志（飞书通知节点的告警）。 */
			logs: Pick<TaskLogs, "appendSystem">;
			/** 飞书发送队列的投递；入队后唤醒它。 */
			delivery: Pick<FeishuDelivery, "wake">;
			/** 运行通知卡片里「查看运行」的链接；没有配置 SFLY_PUBLIC_URL 时返回 undefined（卡片没有按钮）。 */
			runUrl: (runId: string) => string | undefined;
		},
	) {}

	/**
	 * 飞书通知节点（docs/SEMANTICS.md §1.3）：解析输入、组装请求体、写进发送队列，在同一个事务里把节点记为成功
	 * （没有输出）；投递是之后的事，结果只写进这个节点的日志（ADR 0020）。
	 * 解析或组装出错、机器人不存在时节点同样成功，消息不发送，原因在节点日志里写一条 warning：通知不会成为失败的原因。
	 * `scope` 是节点能引用的值（调用方按 always 节点的规则给出：缺失的输出取 null）。
	 */
	async node(
		step: Step,
		input: { run: RunRow; chain: ChainRow; node: FeishuNotifyNode; scope: ResolveScope },
	): Promise<void> {
		const { run, chain, node, scope } = input;
		const prepared = prepareNotification(node, scope);
		let problem = prepared.ok ? undefined : prepared.problem;
		if (prepared.ok && !(await registeredBots(step.tx, [prepared.bot])).has(prepared.bot)) {
			problem = feishuBotGone(prepared.bot);
		}
		const [task] = await step.tx
			.insert(tasks)
			.values({
				...firstAttempt(run, chain, node.id, step.now),
				status: "success",
				inputs: prepared.inputs,
				outputs: {},
				startedAt: step.now,
				endedAt: step.now,
			})
			.onConflictDoNothing()
			.returning();
		// 重放时任务已经存在：消息已经入队（或告警已经写过）。
		if (!task) return;
		if (prepared.ok && problem === undefined) {
			await enqueueFeishuMessage(step.tx, {
				botName: prepared.bot,
				source: "node",
				runId: run.id,
				taskId: task.id,
				body: prepared.body,
				now: step.now,
			});
			step.notifications.queued = true;
		} else {
			step.notifications.logs.push({
				taskId: task.id,
				level: "warn",
				text: `消息没有发送：${problem}`,
			});
		}
	}

	/**
	 * 运行刚结束（在写入运行最终状态的事务里调用）：读场景当前的运行通知设置，满足条件就写进发送队列（#232）。
	 * 调用方保证只有第一次把运行记为结束的事务调用，同一个运行不会发两张卡片。
	 */
	async runFinished(step: Step, finished: FinishedRun): Promise<void> {
		await enqueueRunNotification(step, {
			...finished,
			runUrl: this.deps.runUrl(finished.run.id),
		});
	}

	/** step 的事务提交之后：写任务日志（只是记录，写不进去不影响已经提交的状态迁移），唤醒投递。 */
	async committed(pending: PendingNotifications): Promise<void> {
		for (const { taskId, level, text } of pending.logs) {
			await this.deps.logs.appendSystem(taskId, level, text).catch(() => {});
		}
		if (pending.queued) this.deps.delivery.wake();
	}
}
