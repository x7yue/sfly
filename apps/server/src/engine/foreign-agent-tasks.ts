import { nodeAgentNotRegistered, nodeNameWithId } from "@sfly/orchestration";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { agents, ON_AGENT, runs, tasks } from "../db/schema.js";
import { anyTask, type ChainDriver } from "./step.js";

/** 还在排队、或者已经在 Agent 手上（派发了、运行中）的任务。 */
const IN_PROGRESS = ["queued", ...ON_AGENT] as const;

/**
 * 控制面启动时（Engine.recover）：任务派发到的 Agent 注册在别的项目里的（升级前不核对项目时排上的队、派出去的），
 * 和入队、派发时一样按配置错误失败（不重试），说明和「Agent 还没有注册过」是同一句：别的项目的 Agent
 * 在这次运行所在的项目里和没有注册过一样。不让它们卡在队里或一直占着别的项目的 Agent。返回失败的任务数。
 *
 * - 已经在 Agent 手上的任务失败之后，Agent 下一次心跳时被告知放弃这次尝试（和「立即更新」终止任务一样）。
 * - 每个任务失败之前重新读它的状态：处理前一个时链往后推进，可能已经把后一个停掉，不能把已经结束的改写成失败。
 * - 排不出某个运行的计划（`driver.locate` 抛错）时跳过这个任务并交给 `onError`，不让一个历史运行挡住整个控制面启动。
 */
export async function failForeignAgentTasks(
	driver: ChainDriver,
	db: Db,
	onError: (error: unknown, task: { id: string; runId: string }) => void = () => {},
): Promise<number> {
	const foreign = and(
		inArray(tasks.status, IN_PROGRESS),
		isNotNull(tasks.agentName),
		sql`exists (
			select 1 from ${runs} inner join ${agents} on ${agents.name} = ${tasks.agentName}
			where ${runs.id} = ${tasks.runId} and ${agents.projectId} <> ${runs.projectId}
		)`,
	);
	if (!(await anyTask(db, foreign))) return 0;
	return driver.event(async (step) => {
		const rows = await step.tx
			.select()
			.from(tasks)
			.where(foreign)
			.orderBy(asc(tasks.seq))
			.for("update");
		let failed = 0;
		for (const task of rows) {
			try {
				const [current] = await step.tx
					.select({ status: tasks.status })
					.from(tasks)
					.where(eq(tasks.id, task.id));
				if (current === undefined || !(IN_PROGRESS as readonly string[]).includes(current.status)) {
					continue;
				}
				const { node } = await driver.locate(step.tx, task);
				await driver.failTask(
					step,
					task,
					"config_error",
					nodeAgentNotRegistered(nodeNameWithId(node), task.agentName ?? ""),
				);
				failed++;
			} catch (error) {
				onError(error, { id: task.id, runId: task.runId });
			}
		}
		return failed;
	});
}
