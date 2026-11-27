import { nodeOutsideCardText } from "@sfly/orchestration";
import type { QueuedTaskView, RunningTaskView, StoredOrchestrationDocument } from "@sfly/schema";
import { asc, eq, inArray, type SQL } from "drizzle-orm";
import { currentActionOfTask } from "../actions/action-summary.js";
import type { Db, Tx } from "../db/database.js";
import {
	chainInstances,
	orchestrations,
	orchestrationVersions,
	runs,
	taskActionSummaries,
	tasks,
} from "../db/schema.js";
import { NO_SECRETS, type SecretSet } from "../logs/secrets.js";
import { runSecretValues, taskProgressView } from "../logs/task-logs.js";
import { nodeNameIn, subflowNameOf } from "../runs/run-read.js";

/** 占着槽位或排队等 Agent 的任务视图，连同它所属的 Agent（任务都已指定 Agent）。 */
export interface AgentTasks {
	/** 占着槽位的（准备中、执行中），按派发顺序（`tasks.seq`）。 */
	running: Array<{ agent: string; view: RunningTaskView }>;
	/** 排队的，按排队顺序（`queued_at`，同一时刻按创建顺序），也就是派发时的先后。 */
	queued: Array<{ agent: string; view: QueuedTaskView }>;
}

/**
 * 符合 `where` 的任务（Agent 列表的 `running_tasks`、`queued_tasks`，立即更新返回的被终止任务）：
 * 任务行连上运行、场景和链实例，节点的显示名称、节点类型和子流程名称取自运行绑定的版本（不是场景现在的版本），
 * 占着槽位的任务带上存下的此刻在做的动作（src/actions/）和最新进度，两者都按运行此刻的 secret 值再打一遍码
 * （写入时按那一刻已知的打过；运行视图同一个口径）。
 * 版本文档按版本只读一次：排队的任务很多时，不会每个任务带一份文档。
 */
export async function loadAgentTasks(db: Db | Tx, where: SQL | undefined): Promise<AgentTasks> {
	const rows = await db
		.select({
			agent: tasks.agentName,
			taskId: tasks.id,
			runId: tasks.runId,
			orchestrationId: runs.orchestrationId,
			orchestrationName: orchestrations.name,
			versionId: runs.orchestrationVersionId,
			maskedOnWrite: runs.maskedOnWrite,
			nodeId: tasks.nodeId,
			chainInstanceId: tasks.chainInstanceId,
			chainId: chainInstances.chainId,
			attempt: tasks.attempt,
			status: tasks.status,
			queuedAt: tasks.queuedAt,
			queueExpiresAt: tasks.queueExpiresAt,
			startedAt: tasks.startedAt,
			currentAction: taskActionSummaries.currentAction,
			progress: tasks.progress,
		})
		.from(tasks)
		.leftJoin(taskActionSummaries, eq(taskActionSummaries.taskId, tasks.id))
		.innerJoin(runs, eq(runs.id, tasks.runId))
		.innerJoin(orchestrations, eq(orchestrations.id, runs.orchestrationId))
		.innerJoin(chainInstances, eq(chainInstances.id, tasks.chainInstanceId))
		.where(where)
		.orderBy(asc(tasks.seq));
	const versionIds = [...new Set(rows.map((r) => r.versionId))];
	const documents = new Map<string, StoredOrchestrationDocument>(
		versionIds.length === 0
			? []
			: (
					await db
						.select({ id: orchestrationVersions.id, document: orchestrationVersions.document })
						.from(orchestrationVersions)
						.where(inArray(orchestrationVersions.id, versionIds))
				).map((v) => [v.id, v.document]),
	);

	// 占着槽位的任务的进度说明和正在做的动作按运行此刻的 secret 值打码（和运行视图同一个口径）；写入时打码的运行（#505）不用再打。
	const occupied = new Map(
		rows
			.filter((r) => r.status !== "queued" && !r.maskedOnWrite)
			.map((r) => [r.runId, documents.get(r.versionId)]),
	);
	const secrets = await runSecretValues(
		db,
		[...occupied].flatMap(([runId, document]) => (document ? [{ runId, document }] : [])),
	);
	// 每个运行一份预算（完整的出现的段数，{@link SecretSet.withBudget}）：一个运行用光了预算，也只盖住它自己的内容，不牵连别的运行
	// （Agent 列表里可能是别的项目的运行）。
	const views = new Map<string, SecretSet>();
	const secretsOf = (runId: string): SecretSet => {
		let view = views.get(runId);
		if (!view) {
			view = (secrets.get(runId) ?? NO_SECRETS).withBudget();
			views.set(runId, view);
		}
		return view;
	};

	/** 没有 Agent（不会出现）或版本文档（外键保证有）的任务不列。 */
	const identity = (row: (typeof rows)[number]) => {
		const document = documents.get(row.versionId);
		if (!row.agent || !document) return undefined;
		const node = document.nodes.find((n) => n.id === row.nodeId);
		const displayName = nodeNameIn(document, row.nodeId);
		return {
			agent: row.agent,
			fields: {
				task_id: row.taskId,
				run_id: row.runId,
				orchestration_id: row.orchestrationId,
				orchestration_name: row.orchestrationName,
				node_id: row.nodeId,
				...(displayName === undefined ? {} : { display_name: displayName }),
				node_type: nodeOutsideCardText(node, node?.kind ?? "package", {}),
				chain_instance_id: row.chainInstanceId,
				chain_name: subflowNameOf(document, row.chainId) ?? null,
				attempt: row.attempt,
			},
		};
	};
	// 排序是稳定的：同一时刻排队的任务保持创建顺序。
	const queuedRows = rows
		.filter((r) => r.status === "queued")
		.sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime());
	return {
		running: rows
			.filter((r) => r.status !== "queued")
			.flatMap((row) => {
				const found = identity(row);
				if (!found) return [];
				const view: RunningTaskView = {
					...found.fields,
					status: row.status as RunningTaskView["status"],
					started_at: row.startedAt?.toISOString() ?? null,
					current_action: currentActionOfTask(row.status, row.currentAction, secretsOf(row.runId)),
					progress: row.progress ? taskProgressView(row.progress, secretsOf(row.runId)) : null,
				};
				return [{ agent: found.agent, view }];
			}),
		queued: queuedRows.flatMap((row) => {
			const found = identity(row);
			if (!found) return [];
			const view: QueuedTaskView = {
				...found.fields,
				queued_at: row.queuedAt.toISOString(),
				queue_expires_at: row.queueExpiresAt?.toISOString() ?? null,
			};
			return [{ agent: found.agent, view }];
		}),
	};
}
