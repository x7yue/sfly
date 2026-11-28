// 过渡窗口里以旧方式连接的 Agent（共享令牌、没有凭据，#492 记在连接上），以及升级控制面之后正在做完手上任务的上一版 Agent
// （版本不一致，`AgentHub.legacyConnected`）还要用的三条 HTTP 通道（ADR 0029「迁移与过渡」，#494）：
// 不带凭据和带共享令牌的请求只在这里被放行，判断只看 URL 里的版本或任务和此刻的连接表，不当作「某一台 Agent」的请求。
// 窗口在任何一个项目登记了工作台时关上（`ProjectWorkbench.credentialRequired`，#549）；下一个版本连接本身也被拒绝（#848），
// 到时这里没有连接可认，整个文件删掉。
//
// 代价（写进升级说明）：窗口期内，知道某个任务 ID 的人能不带凭据下载那次运行的产物、给这个任务传产物，知道包名和版本的人能下载
// 正在被这样的任务用的归档。任务 ID 只有项目成员看得到。
import { type SQL, sql } from "drizzle-orm";
import type { LegacyAgentAccess } from "../auth/access-guard.js";
import type { Db } from "../db/database.js";
import { ON_AGENT } from "../db/schema.js";
import { type ProjectId, PUBLIC_PROJECT } from "../projects/project-id.js";
import type { AgentHub } from "./agent-hub.js";

export function createLegacyAgentAccess(deps: {
	db: Db;
	hub: Pick<AgentHub, "legacyConnected">;
	/** 窗口还开着吗：没有任何一个项目登记过工作台。 */
	windowOpen: () => Promise<boolean>;
}): LegacyAgentAccess {
	const onAgent = sql.join(
		ON_AGENT.map((status) => sql`${status}`),
		sql`, `,
	);
	/** 此刻以旧方式连接着的 Agent 的名字；窗口关上了或者一台都没有时为 undefined（不用查库）。 */
	const legacyNames = async () => {
		const names = deps.hub.legacyConnected();
		if (names.length === 0 || !(await deps.windowOpen())) return undefined;
		return sql.join(
			names.map((name) => sql`${name}`),
			sql`, `,
		);
	};
	const exists = async (query: SQL) => {
		const result = await deps.db.execute(sql`select exists (${query}) as found`);
		return (result.rows[0] as { found: boolean } | undefined)?.found === true;
	};
	return {
		async archive(project: ProjectId, name: string, version: string) {
			const names = await legacyNames();
			if (names === undefined) return false;
			// 还没结束的任务派给了以旧方式连接的 Agent，节点要的就是这个包，运行锁定的版本就是这个版本；
			// 归档所在的项目是运行的项目或者公共项目（和派发时找包的范围一样）。
			return exists(sql`
				select 1 from tasks t
				join runs r on r.id = t.run_id
				join orchestration_versions v on v.id = r.orchestration_version_id
				where t.agent_name in (${names})
					and t.status in (${onAgent})
					and (r.project_id = ${project} or ${project} = ${PUBLIC_PROJECT})
					and v.document -> 'packages' ->> ${name} = ${version}
					and exists (
						select 1 from jsonb_array_elements(v.document -> 'nodes') n
						where n ->> 'id' = t.node_id and n ->> 'package' = ${name}
					)`);
		},
		async upload(taskId: string) {
			const names = await legacyNames();
			if (names === undefined) return false;
			// 和产物保存时的判断一样（ArtifactStore.save）：派发中、执行中，或者开始以后被取消的。
			return exists(sql`
				select 1 from tasks t
				where t.id = ${taskId}
					and t.agent_name in (${names})
					and (t.status in ('dispatched', 'running') or (t.status = 'cancelled' and t.started_at is not null))`);
		},
		async taskArtifacts(taskId: string) {
			const names = await legacyNames();
			if (names === undefined) return false;
			// 这次运行里此刻有任务在以旧方式连接的 Agent 上（派发中或执行中）。
			return exists(sql`
				select 1 from tasks t
				join tasks other on other.run_id = t.run_id
				where t.id = ${taskId}
					and other.agent_name in (${names})
					and other.status in (${onAgent})`);
		},
	};
}
