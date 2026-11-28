// 同一台 Agent 上同一个节点包只能装一个版本（ADR 0002：所有节点包共用一个 Python 环境），任务执行期间 Agent 不持锁：
// 另一个版本装上时会换掉正在执行的任务的代码（#449）。触发前的预检（runs/preflight.ts）和派发（engine.ts 的 #prepareAssign）
// 都用这里的判断：控制面自己的任务记录里，这台 Agent 上准备中、执行中的任务各用着哪个版本，不靠 Agent 上报。
import { nodeNameWithId } from "@sfly/orchestration";
import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { ON_AGENT, packageVersionConflicts } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import type { PackageNode } from "./chain.js";

/** 一台 Agent 上正在用某个节点包的一个版本的运行（准备中、执行中的任务所属的）。 */
export interface VersionInUse {
	version: string;
	runId: string;
	projectId: ProjectId;
	scenario: string;
	runStartedAt: Date;
}

/** 列出几个正在用的运行，多出来的写个数。 */
const LISTED_RUNS = 3;

/**
 * 这台 Agent 上准备中、执行中（`ON_AGENT`）的任务里，用着 `pkg` 的、版本不是 `version` 的，每个运行一条，按运行开始的先后。
 * 版本按原样的字符串比较：Agent 判断装没装也是逐字比较（`agent/src/lib.rs` 的 `Inventory::find`），`0.9` 和 `0.9.0` 也会换装。
 * 节点用哪个包从运行绑定的版本文档里取，只取这一个字段，不把文档读出来。`db` 可以是事务（派发时读到这个事务里刚派发的）。
 */
export async function otherVersionsInUse(
	db: Db | Tx,
	agentName: string,
	pkg: string,
	version: string,
): Promise<VersionInUse[]> {
	const rows = await db.execute<{
		version: string;
		run_id: string;
		project_id: string;
		scenario: string;
		run_started_at: Date | string;
	}>(sql`
		select distinct on (t.run_id)
			v.document -> 'packages' ->> n.package as version,
			t.run_id, r.project_id, o.name as scenario, r.started_at as run_started_at
		from tasks t
		join runs r on r.id = t.run_id
		join orchestrations o on o.id = r.orchestration_id
		join orchestration_versions v on v.id = r.orchestration_version_id
		cross join lateral (
			select jsonb_path_query_first(
				v.document, '$.nodes[*] ? (@.id == $id && @.kind == "package").package',
				jsonb_build_object('id', t.node_id)
			) #>> '{}' as package
		) n
		where t.agent_name = ${agentName}
			and t.status in (${sql.join(
				ON_AGENT.map((s) => sql`${s}`),
				sql`, `,
			)})
			and n.package = ${pkg}
			and (v.document -> 'packages' ->> n.package) is distinct from ${version}
		order by t.run_id
	`);
	return rows.rows
		.map((r) => ({
			version: r.version,
			runId: r.run_id,
			projectId: r.project_id as ProjectId,
			scenario: r.scenario,
			runStartedAt: new Date(r.run_started_at),
		}))
		.sort((a, b) => a.runStartedAt.getTime() - b.runStartedAt.getTime());
}

/** 运行已经跑了多久的一句话：已经跑了不到 1 分钟、N 分钟、H 小时 M 分钟。 */
export function ranFor(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "已经跑了不到 1 分钟";
	if (minutes < 60) return `已经跑了 ${minutes} 分钟`;
	const rest = minutes % 60;
	return `已经跑了 ${Math.floor(minutes / 60)} 小时${rest === 0 ? "" : ` ${rest} 分钟`}`;
}

/**
 * 不能用这个版本的说明：哪个节点、哪台 Agent、正在用的是哪个版本、属于哪次运行（链接和它已经跑了多久），以及下一步。
 * 读者所在的项目（`project`）之外的运行只说是别的项目里的，不给场景名和链接。
 */
export function versionInUseMessage(
	node: PackageNode,
	version: string,
	agent: string,
	inUse: readonly VersionInUse[],
	context: { project: ProjectId; now: Date; runLink: (runId: string) => string },
): string {
	const runs = inUse.slice(0, LISTED_RUNS).map((r) => {
		const elapsed = ranFor(context.now.getTime() - r.runStartedAt.getTime());
		const what =
			r.projectId === context.project
				? `场景「${r.scenario}」的运行 ${context.runLink(r.runId)}，${elapsed}`
				: `别的项目里的一个运行，${elapsed}`;
		return `${node.package}@${r.version}（${what}）`;
	});
	const more = inUse.length > LISTED_RUNS ? ` 等 ${inUse.length} 个运行` : "";
	return `节点 ${nodeNameWithId(node)} 用的是 ${node.package}@${version}，但它派发到的 Agent ${agent} 上正在执行 ${runs.join("、")}${more}：同一台 Agent 上一个节点包只能装一个版本，装上 ${version} 会换掉正在执行的代码。等那次运行结束再触发，或者把这个节点换到另一台 Agent`;
}

/** 一次因为版本冲突的拒绝（`package_version_conflicts` 的一行，不含 id）。 */
export type VersionConflictRecord = typeof packageVersionConflicts.$inferInsert;

/** 记下拒绝（触发时预检阻断的在触发的事务里，派发时失败的在派发的事务里）。 */
export async function recordVersionConflicts(
	tx: Tx,
	records: readonly VersionConflictRecord[],
): Promise<void> {
	if (records.length > 0) await tx.insert(packageVersionConflicts).values([...records]);
}
