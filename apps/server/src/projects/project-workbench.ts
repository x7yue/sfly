// 项目的工作台（ADR 0027、0029「迁移与过渡」，#549）：哪台 Agent 是这个项目助手的工作台，存在 `projects.workbench_agent`。
//
// **登记**（{@link ProjectWorkbench.register}）要满足条件，然后让控制面只接受 Agent 凭据：
//   1. 这台 Agent 在这个项目里、没有被停用、最近一次连接用的是 Agent 凭据（它要先用自己的凭据连上来过一次；别的项目里的名字和
//      不存在一样，不透露那边有没有它）；
//   2. 部署里没有停用的 Agent 都已经换成 Agent 凭据（{@link agentsNotOnCredentials}，按每台最近一次连接用的是不是 Agent 凭据算；
//      只签发过、没用它连上过的不算换了），没换的列在拒绝里。
// **之后**部署里任何一个项目有工作台，{@link AgentAuthenticator} 就拒绝共享令牌和不带凭据的连接（整个部署，不只这个项目），
// 开关每次从库里得出（{@link ProjectWorkbench.credentialRequired}），控制面重启之后照旧，不是只在内存里。
//
// **检查和登记之间的竞争**：检查通过之后、登记生效之前，一台 Agent 以旧方式连上来怎么办？两步在**引擎的锁**里一起做（和
// {@link AgentHub.attach} 同一把锁，`attach` 登记连接之前在锁里再确认一遍开关）：
//   - 旧方式的连接先登记：它记下「最近一次连接用的不是 Agent 凭据」，登记的检查在锁里重新读，看到它，拒绝并列出它；
//   - 登记先生效：旧方式的连接在锁里的再确认读到开关，被拒绝，不会进连接表；
// 所以不会出现「登记生效了，却还有一条以旧方式登记的连接活着」，登记也就不需要去断开任何连接：前置条件保证登记那一刻没有以旧方式
// 连着的、没有停用的 Agent（停用的在停用时已经断开），登记之后新的以旧方式连接进不来。这一条不新增断开连接的路径，所以不动
// Hello 的处理和连接的去留（没有改 `verify-task-dispatch` 建模的东西）。
//
// **没有注销登记**：登记之后共享令牌不再接受是有意的单向开关（注销等于重新打开共享令牌的口子）；要换工作台就用另一台 Agent
// 再登记一次（同样的条件），换下来的那台只是不再是工作台。确实要回退到登记之前（例如退回旧版本控制面之前），停掉控制面，
// 在库里把 `projects.workbench_agent` 置空。
import { eq, isNotNull } from "drizzle-orm";
import { agentsNotOnCredentials } from "../agents/agent-auth.js";
import type { Db } from "../db/database.js";
import { agents, projects } from "../db/schema.js";
import type { Mutex } from "../util/mutex.js";
import type { ProjectId } from "./project-id.js";

export type RegisterWorkbenchOutcome =
	| { ok: true; project: ProjectId; agent: string; previous: string | null }
	| { ok: false; reason: "project_not_found" }
	/** 这个项目里没有这台 Agent（不存在，或者属于别的项目：说法一样）。 */
	| { ok: false; reason: "agent_unknown" }
	| { ok: false; reason: "agent_disabled" }
	/** 这台 Agent 最近一次连接用的不是 Agent 凭据（共享令牌、没有凭据，或者记下之前连接的）。 */
	| { ok: false; reason: "agent_not_on_credential" }
	/** 部署里还有没有停用的 Agent 没换成 Agent 凭据：`agents` 是它们的名字（按名字排序）。 */
	| { ok: false; reason: "agents_not_on_credentials"; agents: string[] };

export class ProjectWorkbench {
	constructor(
		private readonly deps: {
			db: Db;
			/** 引擎的锁（和 `AgentHub` 的是同一把）：登记的检查和写库在这把锁里，和连接的登记互斥。 */
			mutex: Mutex;
		},
	) {}

	/** 这个项目登记的工作台（Agent 的名字）；没有登记为 undefined。 */
	async get(project: ProjectId): Promise<string | undefined> {
		const [row] = await this.deps.db
			.select({ agent: projects.workbenchAgent })
			.from(projects)
			.where(eq(projects.id, project));
		return row?.agent ?? undefined;
	}

	/**
	 * 部署里有没有项目登记了工作台：有就只接受 Agent 凭据（{@link AgentAuthenticator} 的 `requireAgentCredential`）。
	 * 每次都读库：开关从库里得出，不缓存，重启之后和登记当时一样。
	 */
	async credentialRequired(): Promise<boolean> {
		const [row] = await this.deps.db
			.select({ id: projects.id })
			.from(projects)
			.where(isNotNull(projects.workbenchAgent))
			.limit(1);
		return row !== undefined;
	}

	/** 登记 `project` 的工作台（条件见文件头）。检查和写库在引擎的锁里一起做。 */
	register(project: ProjectId, agent: string): Promise<RegisterWorkbenchOutcome> {
		return this.deps.mutex.run(async () => {
			const { db } = this.deps;
			const [row] = await db
				.select({
					projectId: agents.projectId,
					disabledAt: agents.disabledAt,
					lastAuthKind: agents.lastAuthKind,
				})
				.from(agents)
				.where(eq(agents.name, agent));
			// 别的项目里的名字和不存在一样：不透露那边有没有这台 Agent。
			if (row === undefined || row.projectId !== project)
				return { ok: false, reason: "agent_unknown" };
			if (row.disabledAt !== null) return { ok: false, reason: "agent_disabled" };
			if (row.lastAuthKind !== "agent") return { ok: false, reason: "agent_not_on_credential" };
			const pending = await agentsNotOnCredentials(db);
			if (pending.length > 0) {
				return { ok: false, reason: "agents_not_on_credentials", agents: pending };
			}
			const [current] = await db
				.select({ agent: projects.workbenchAgent })
				.from(projects)
				.where(eq(projects.id, project));
			if (current === undefined) return { ok: false, reason: "project_not_found" };
			await db.update(projects).set({ workbenchAgent: agent }).where(eq(projects.id, project));
			return {
				ok: true,
				project,
				agent,
				previous: current.agent === null || current.agent === agent ? null : current.agent,
			};
		});
	}
}
