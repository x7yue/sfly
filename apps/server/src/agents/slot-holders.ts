import type { SlotHolderView } from "@sfly/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import {
	chainInstances,
	ON_AGENT,
	orchestrations,
	orchestrationVersions,
	runs,
	tasks,
} from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import { nodeNameIn, subflowNameOf } from "../runs/run-read.js";

/** 一台 Agent 的槽位现在被谁占着。 */
export interface SlotHolders {
	/** 读者的项目里占着槽位的任务，按派发顺序（`tasks.seq`）。 */
	holders: SlotHolderView[];
	/** 别的项目里占着槽位的任务数：只有数量，不给场景名、运行和节点（读者看不到别的项目的东西）。 */
	elsewhere: number;
	/** 占着槽位的任务总数（所有项目）：和派发数槽位是同一个数（`engine.ts` 的 `#dispatch`）。 */
	occupied: number;
}

/**
 * 这台 Agent 的槽位现在被哪些任务占着：派发给它、还没结束的任务（准备中、执行中，`ON_AGENT`）。
 * 要说「槽位被谁占着」的地方都用它，不各自再查一遍任务表：运行视图里排队中的尝试写明在等谁的槽位（`queue-wait.ts`），
 * 预检提示槽位不够、排队超时的报错写明是谁占着（#475）。
 *
 * 按读者的项目（`projectId`）过滤：同一台 Agent 上别的项目的任务只算进 `elsewhere` 一个数，场景名、运行编号、节点名
 * 不给出去（Agent 归属项目之前就把形状做对，#500）。只读写进 {@link SlotHolderView} 的这几样：场景名、运行、节点
 * （显示名称取自运行绑定的版本）、所在的子流程、第几次尝试和状态；进度、正在做的动作（要按运行的 secret 值打码）不读，
 * 要用时再加。`db` 可以是事务：在事务里调用时读到这个事务里的状态，所有查询一个接一个地走 `db`，不从连接池另取连接。
 */
export async function slotHolders(
	db: Db | Tx,
	agentName: string,
	projectId: ProjectId,
): Promise<SlotHolders> {
	const rows = await db
		.select({
			runId: tasks.runId,
			projectId: runs.projectId,
			orchestrationId: runs.orchestrationId,
			orchestrationName: orchestrations.name,
			versionId: runs.orchestrationVersionId,
			nodeId: tasks.nodeId,
			chainId: chainInstances.chainId,
			attempt: tasks.attempt,
			status: tasks.status,
			startedAt: tasks.startedAt,
		})
		.from(tasks)
		.innerJoin(runs, eq(runs.id, tasks.runId))
		.innerJoin(orchestrations, eq(orchestrations.id, runs.orchestrationId))
		.innerJoin(chainInstances, eq(chainInstances.id, tasks.chainInstanceId))
		.where(and(eq(tasks.agentName, agentName), inArray(tasks.status, [...ON_AGENT])))
		.orderBy(asc(tasks.seq));
	const mine = rows.filter((row) => row.projectId === projectId);
	const versionIds = [...new Set(mine.map((row) => row.versionId))];
	const documents = new Map(
		versionIds.length === 0
			? []
			: (
					await db
						.select({ id: orchestrationVersions.id, document: orchestrationVersions.document })
						.from(orchestrationVersions)
						.where(inArray(orchestrationVersions.id, versionIds))
				).map((v) => [v.id, v.document]),
	);
	return {
		holders: mine.flatMap((row) => {
			const document = documents.get(row.versionId);
			if (!document) return []; // 外键保证有版本文档
			const displayName = nodeNameIn(document, row.nodeId);
			return [
				{
					run_id: row.runId,
					orchestration_id: row.orchestrationId,
					orchestration_name: row.orchestrationName,
					node_id: row.nodeId,
					...(displayName === undefined ? {} : { display_name: displayName }),
					chain_name: subflowNameOf(document, row.chainId) ?? null,
					attempt: row.attempt,
					status: row.status as SlotHolderView["status"],
					started_at: row.startedAt?.toISOString() ?? null,
				},
			];
		}),
		elsewhere: rows.length - mine.length,
		occupied: rows.length,
	};
}
