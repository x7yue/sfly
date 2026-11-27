import type { QueueWaitView } from "@sfly/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { agents } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import type { AgentConnection } from "./agent-hub.js";
import { connectionBlock, dispatchBlock } from "./dispatch-gate.js";
import { slotHolders } from "./slot-holders.js";

/**
 * 排队中的任务在等的那台 Agent 现在为什么没接它（运行视图里排队中的尝试的 `queue_wait`，除了 `expires_at` 都在这里）。
 * 判断的是控制面派发时的条件，顺序和 `engine.ts` 的派发一致：已被停用 → 不在线 → 在线但还没准备好环境 →
 * 版本与控制面不一致 → 槽位用满 → 都满足，正在派发。已停用排在最前：停用是管理员的决定，不是掉线了，
 * 停用到连接真的关掉之间有一瞬还在线，也写已停用（停用的 Agent 不参与派发，ADR 0029「迁移与过渡」）。
 */
export type AgentWait = Omit<QueueWaitView, "expires_at">;

/** 判断要用到的连接状态：Agent 注册表（`AgentHub`）的一部分。 */
export interface QueueWaitHub {
	connection(name: string): Pick<AgentConnection, "ready" | "info"> | undefined;
	preparingSince(name: string): Date | undefined;
	versionMismatch(info: { agent_version: string }): boolean;
	/** 现在的控制面时间（读取这一刻）。 */
	now(): Date;
}

/**
 * 一批 Agent 此刻的等待状态，按 Agent 名称作键。Agent 的在线、准备环境、槽位占用都是读取这一刻的状态，
 * 不在数据库里记着；停用的时间、不在线的 Agent 最后在线的时间取自 agents 表（只看读运行的人所在的项目里的 Agent，一次查询）。
 * `db` 可以是事务（只读，一个接一个地查）。
 */
export async function agentWaits(
	db: Db | Tx,
	hub: QueueWaitHub,
	names: readonly string[],
	/** 读运行的人所在的项目：占着槽位的任务只写这个项目的，别的项目的只给个数（`slotHolders`）。 */
	projectId: ProjectId,
): Promise<Map<string, AgentWait>> {
	const unique = [...new Set(names)];
	const rows =
		unique.length === 0
			? []
			: await db
					.select({
						name: agents.name,
						lastSeenAt: agents.lastSeenAt,
						disabledAt: agents.disabledAt,
					})
					.from(agents)
					.where(and(eq(agents.projectId, projectId), inArray(agents.name, unique)));
	const known = new Map(rows.map((row) => [row.name, row]));
	const waits = new Map<string, AgentWait>();
	const now = hub.now().toISOString();
	for (const agent of unique) {
		const conn = hub.connection(agent);
		const wait = (
			partial: Omit<AgentWait, "agent" | "now" | "holders" | "other_project_holders"> & {
				holders?: AgentWait["holders"];
				other_project_holders?: number;
			},
		) => waits.set(agent, { agent, now, holders: [], other_project_holders: 0, ...partial });
		const row = known.get(agent);
		// 停用最先：停用的 Agent 不参与派发，不管它此刻连着没有。
		if (row?.disabledAt) {
			wait({ state: "disabled", since: row.disabledAt.toISOString(), slots: null });
			continue;
		}
		// 派发的闸门（dispatch-gate.ts）先看只靠连接的三条；连接都满足了才去数占着槽位的任务。
		const block = connectionBlock(conn, conn ? hub.versionMismatch(conn.info) : false);
		if (block === "offline" || !conn) {
			wait({ state: "offline", since: row?.lastSeenAt.toISOString() ?? null, slots: null });
		} else if (block === "preparing") {
			wait({
				state: "preparing",
				since: hub.preparingSince(agent)?.toISOString() ?? null,
				slots: conn.info.slots,
			});
		} else if (block === "version_mismatch") {
			wait({ state: "version_mismatch", since: null, slots: conn.info.slots });
		} else {
			const { holders, elsewhere, occupied } = await slotHolders(db, agent, projectId);
			if (dispatchBlock(conn, false, occupied) === "slots_full") {
				wait({
					state: "slots_full",
					since: null,
					slots: conn.info.slots,
					holders,
					other_project_holders: elsewhere,
				});
			} else {
				wait({ state: "dispatching", since: null, slots: conn.info.slots });
			}
		}
	}
	return waits;
}
