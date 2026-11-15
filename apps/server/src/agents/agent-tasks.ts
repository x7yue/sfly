import { nodeOutsideCardText } from "@sfly/orchestration";
import type { QueuedTaskView, RunningTaskView } from "@sfly/schema";
import { eq } from "drizzle-orm";
import type { Db } from "../db/database.js";
import {
	chainInstances,
	orchestrations,
	orchestrationVersions,
	runs,
	tasks,
} from "../db/schema.js";
import { nodeNameIn, subflowNameOf } from "../engine/run-board.js";
import type { Tx } from "../engine/step.js";

/**
 * 占着或等着 Agent 槽位的任务（Agent 列表的 `running_tasks`、`queued_tasks`，立即更新返回的被终止任务）：
 * 任务行连上运行、场景、链实例和运行绑定的版本，取显示它所需的列。调用方接 `where` 和排序。
 */
export const agentTaskRows = (db: Db | Tx) =>
	db
		.select({
			agent: tasks.agentName,
			taskId: tasks.id,
			runId: tasks.runId,
			orchestrationId: runs.orchestrationId,
			orchestrationName: orchestrations.name,
			nodeId: tasks.nodeId,
			chainInstanceId: tasks.chainInstanceId,
			chainId: chainInstances.chainId,
			attempt: tasks.attempt,
			status: tasks.status,
			queuedAt: tasks.queuedAt,
			queueExpiresAt: tasks.queueExpiresAt,
			startedAt: tasks.startedAt,
			document: orchestrationVersions.document,
		})
		.from(tasks)
		.innerJoin(runs, eq(runs.id, tasks.runId))
		.innerJoin(orchestrations, eq(orchestrations.id, runs.orchestrationId))
		.innerJoin(chainInstances, eq(chainInstances.id, tasks.chainInstanceId))
		.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId));

export type AgentTaskRow = Awaited<ReturnType<typeof agentTaskRows>>[number];

/** 运行绑定的版本（不是场景现在的版本）里这个任务的节点、节点类型和所在的链。 */
function identity(t: AgentTaskRow) {
	const node = t.document.nodes.find((n) => n.id === t.nodeId);
	const displayName = nodeNameIn(t.document, t.nodeId);
	return {
		task_id: t.taskId,
		run_id: t.runId,
		orchestration_id: t.orchestrationId,
		orchestration_name: t.orchestrationName,
		node_id: t.nodeId,
		...(displayName === undefined ? {} : { display_name: displayName }),
		node_type: nodeOutsideCardText(node, node?.kind ?? "package", {}),
		chain_instance_id: t.chainInstanceId,
		chain_name: subflowNameOf(t.document, t.chainId) ?? null,
		attempt: t.attempt,
	};
}

export function runningTaskView(t: AgentTaskRow): RunningTaskView {
	return {
		...identity(t),
		status: t.status as RunningTaskView["status"],
		started_at: t.startedAt?.toISOString() ?? null,
	};
}

export function queuedTaskView(t: AgentTaskRow): QueuedTaskView {
	return {
		...identity(t),
		queued_at: t.queuedAt.toISOString(),
		queue_expires_at: t.queueExpiresAt?.toISOString() ?? null,
	};
}
