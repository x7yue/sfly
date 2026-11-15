import type { AgentMessage } from "@sfly/proto";
import type { ActionSummaryView } from "@sfly/schema";
import { eq } from "drizzle-orm";
import type { AgentConnection } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { taskActionSummaries, tasks } from "../db/schema.js";
import type { TaskLogs } from "../logs/task-logs.js";
import type { Topics } from "../sse/topics.js";
import { isUuid } from "../util/uuid.js";
import {
	actionSummaryView,
	parseActionSummary,
	sameCurrentAction,
	summaryOfTask,
} from "./action-summary.js";

/**
 * 任务的动作（规格 #345，docs/ARCHITECTURE.md §6.3）。目前是摘要：Agent 每个任务每秒最多转发一份 ActionSummary，
 * 这里只保留最新的一份（`task_action_summaries`），连同从里面选出的此刻在做的动作。
 *
 * 此刻在做的动作变了（换了一个，或者没有了）时发布这次运行的变化（`runChanges`，引擎的同一个主题）：运行的事件流
 * 重新推送运行视图，尝试上带着新的 `current_action`。它只在最外层、开始得最早的那个动作换了时才变：外层是
 * 「保持 4 小时」这样的长动作时很少变；每一笔都记成最外层动作的节点最多每秒变一次（摘要的频率）。
 *
 * 和日志、进度一样不经过引擎的互斥锁（不改变运行状态）；同一条连接上的消息由网关依次处理，同一个任务的摘要不会并发写入。
 */
export class TaskActions {
	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			logs: Pick<TaskLogs, "runSecrets">;
			/** 运行的变化（主题 = 运行 ID），运行的事件流订阅它。 */
			runChanges: Topics<string>;
		},
	) {}

	/** 这条 Agent 消息是否由这里处理（动作摘要）。 */
	handles(message: AgentMessage): boolean {
		return message.body.case === "actionSummary";
	}

	/**
	 * 存下一份摘要（只接受任务所在 Agent 上报的）。不是合法的摘要时丢弃：同版本的 SDK 写的总是合法的
	 * （ADR 0014），这里不再写日志。
	 */
	async onMessage(conn: AgentConnection, message: AgentMessage): Promise<void> {
		if (message.body.case !== "actionSummary") return;
		const receivedAt = this.deps.clock.now();
		const { taskId, eventJson } = message.body.value;
		const event = parseActionSummary(eventJson);
		if (!event || !isUuid(taskId)) return;
		const [task] = await this.deps.db
			.select({
				runId: tasks.runId,
				agentName: tasks.agentName,
				current: taskActionSummaries.currentAction,
			})
			.from(tasks)
			.leftJoin(taskActionSummaries, eq(taskActionSummaries.taskId, tasks.id))
			.where(eq(tasks.id, taskId));
		if (!task || task.agentName !== conn.name) return;
		const { summary, current } = actionSummaryView(
			event,
			(monotonicMs) => conn.clock.controlPlaneTime(monotonicMs, receivedAt),
			await this.deps.logs.runSecrets(task.runId),
		);
		await this.deps.db
			.insert(taskActionSummaries)
			.values({ taskId, summary, currentAction: current })
			.onConflictDoUpdate({
				target: taskActionSummaries.taskId,
				set: { summary, currentAction: current },
			});
		if (!sameCurrentAction(task.current, current)) {
			this.deps.runChanges.publish(task.runId, task.runId);
		}
	}

	/** 一个任务的动作摘要（任务结束后正在做的动作为空）；任务不存在时为 undefined。 */
	async summary(taskId: string): Promise<ActionSummaryView | undefined> {
		if (!isUuid(taskId)) return undefined;
		const [row] = await this.deps.db
			.select({ status: tasks.status, summary: taskActionSummaries.summary })
			.from(tasks)
			.leftJoin(taskActionSummaries, eq(taskActionSummaries.taskId, tasks.id))
			.where(eq(tasks.id, taskId));
		return row && summaryOfTask(row.status, row.summary);
	}
}
