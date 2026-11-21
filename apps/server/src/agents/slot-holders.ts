import type { RunningTaskView } from "@sfly/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { ON_AGENT, tasks } from "../db/schema.js";
import { loadAgentTasks } from "./agent-tasks.js";

/**
 * 这台 Agent 的槽位现在被哪些任务占着：派发给它、还没结束的任务（准备中、执行中），按派发顺序。
 * 每个任务写明场景、运行、节点（显示名称）、所在的链和第几次尝试，和 Agent 列表的 `running_tasks` 是同一份视图。
 *
 * 要说「槽位被谁占着」的地方都用它，不各自再查一遍任务表：运行视图里排队中的尝试写明在等谁的槽位（`queue-wait.ts`），
 * 预检提示槽位不够、排队超时的报错写明是谁占着（#475）。`db` 可以是事务：在事务里调用时读到这个事务里的状态，
 * 所有查询一个接一个地走 `db`，不从连接池另取连接。
 */
export async function slotHolders(db: Db | Tx, agentName: string): Promise<RunningTaskView[]> {
	const { running } = await loadAgentTasks(
		db,
		and(eq(tasks.agentName, agentName), inArray(tasks.status, [...ON_AGENT])),
	);
	return running.map((task) => task.view);
}
