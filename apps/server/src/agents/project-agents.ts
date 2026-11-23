import { and, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { type AgentInfo, type AgentStatus, agents } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";

/** 一台 Agent 的登记：名称、此刻的状态和它最近上报的信息。 */
export interface AgentRecord {
	name: string;
	status: AgentStatus;
	info: AgentInfo;
	/** 被停用的时间（没停用为 null）：停用的 Agent 连不上、不参与派发，预检要说清楚。 */
	disabledAt: Date | null;
}

/**
 * 这个项目里的 Agent（按名字给出时只取这些名字里的）。场景的检查和触发前的预检、触发时的参数检查、
 * 派发时解析「Agent」类型的输入引用的 Agent，按名字找 Agent 都走这一个函数：别的项目的 Agent 和不存在一样
 * （ADR 0029），不会出现在结果里，它上报的开发版本声明、状态、地址也就带不进别的项目的检查结果。
 * Agent 没有「公共」一说，不像节点包有公共项目。`db` 由调用方传：在事务里读时传事务对象。
 */
export async function agentsInProject(
	db: Db | Tx,
	project: ProjectId,
	names?: readonly string[],
): Promise<AgentRecord[]> {
	if (names !== undefined && names.length === 0) return [];
	return db
		.select({
			name: agents.name,
			status: agents.status,
			info: agents.info,
			disabledAt: agents.disabledAt,
		})
		.from(agents)
		.where(
			and(
				eq(agents.projectId, project),
				...(names === undefined ? [] : [inArray(agents.name, [...names])]),
			),
		);
}
