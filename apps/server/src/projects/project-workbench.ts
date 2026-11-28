// 项目的工作台（ADR 0027、0029「迁移与过渡」，#549）：哪台 Agent 是这个项目助手的工作台，存在 `projects.workbench_agent`。
//
// **登记**（{@link ProjectWorkbench.register}）要满足条件，然后让控制面只接受 Agent 凭据：
//   1. 这台 Agent 在这个项目里、没有被停用、最近一次连接用的是 Agent 凭据（它要先用自己的凭据连上来过一次；别的项目里的名字和
//      不存在一样，不透露那边有没有它）；
//   2. 部署里没有停用的 Agent 都已经换成 Agent 凭据（{@link agentsNotOnCredentials}，按每台最近一次连接用的是不是 Agent 凭据算；
//      只签发过、没用它连上过的不算换了），没换的列在拒绝里。**开关已经开着时（已经有项目登记过工作台）不再检查这一条**：
//      旧方式的连接反正连不上（登记之后 Hello 拒绝它们），它们留着的 `last_auth_kind` 只是登记之前的最后一次记录，
//      不能让它们挡住换工作台；工作台本身的那三条照旧。没换的只列这个项目里的名字，别的项目里的只给台数（#778）。
//   3. 开关还没开时（部署里第一次登记）登记的人是平台管理员：这一步让整个部署只接受 Agent 凭据、不能撤回，是部署一级的决定，
//      不该由某一个项目的管理员做（#778，ADR 0029 的平台管理员）；开关开着以后项目管理员登记、换自己项目的工作台照旧。
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
// 再登记一次（工作台本身的条件照旧，部署里的 Agent 都换成凭据这一条在开关已经开着时不再查），换下来的那台只是不再是工作台；
// 在做的一轮在原来的工作台上做完（这一轮开始时交给助手服务的是当时的工作台），下一轮才交给新的。确实要回退到登记之前（例如退回旧版本控制面之前），停掉控制面，
// 在库里把 `projects.workbench_agent` 置空。
import { eq, isNotNull } from "drizzle-orm";
import { agentsNotOnCredentials } from "../agents/agent-auth.js";
import type { Db, Tx } from "../db/database.js";
import { agents, projects, users } from "../db/schema.js";
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
	/**
	 * 部署里还有没有停用的 Agent 没换成 Agent 凭据：`agents` 是这个项目里的（按名字排序），`otherProjects` 是别的项目里的台数
	 * （不给名字：一个项目的管理员不该看到别的项目里的 Agent，#778）。
	 */
	| { ok: false; reason: "agents_not_on_credentials"; agents: string[]; otherProjects: number }
	/** 开关还没开（部署里还没有项目登记过工作台），登记的人不是平台管理员：第一次登记会让整个部署只接受 Agent 凭据（#778）。 */
	| { ok: false; reason: "switch_needs_platform_admin" };

/** 这个项目登记的工作台（Agent 的名字）；没有登记为 undefined。在事务里读时传事务（触发准入、派发）。 */
export async function workbenchOf(db: Db | Tx, project: ProjectId): Promise<string | undefined> {
	const [row] = await db
		.select({ agent: projects.workbenchAgent })
		.from(projects)
		.where(eq(projects.id, project));
	return row?.agent ?? undefined;
}

export class ProjectWorkbench {
	constructor(
		private readonly deps: {
			db: Db;
			/** 引擎的锁（和 `AgentHub` 的是同一把）：登记的检查和写库在这把锁里，和连接的登记互斥。 */
			mutex: Mutex;
		},
	) {}

	/** 这个项目登记的工作台（Agent 的名字）；没有登记为 undefined。 */
	get(project: ProjectId): Promise<string | undefined> {
		return workbenchOf(this.deps.db, project);
	}

	/**
	 * 部署里有没有项目登记了工作台：有就只接受 Agent 凭据（{@link AgentAuthenticator} 的 `requireAgentCredential`）。
	 * 每次都读库：开关从库里得出，不缓存，重启之后和登记当时一样。
	 * **读不到就抛，不放行**：库出错时这里的异常原样传给调用方（`AgentAuthenticator` 不接它，Hello 的处理抛出去，
	 * 这条连接以错误结束、没有登记进连接表），**不能**接住错误当成「没有登记」：那样库一出问题，旧方式的连接就全放行了，
	 * 恰好是这个开关要挡住的。带 Agent 凭据的 Hello 不读开关，所以库出错时它们照样是各自的结果（认凭据本来就要读库，也会失败）。
	 */
	async credentialRequired(): Promise<boolean> {
		const [row] = await this.deps.db
			.select({ id: projects.id })
			.from(projects)
			.where(isNotNull(projects.workbenchAgent))
			.limit(1);
		return row !== undefined;
	}

	/**
	 * 登记 `project` 的工作台（条件见文件头）。检查和写库在引擎的锁里一起做。`caller` 是登记的人（用户 ID）：
	 * 开关还没开时只有平台管理员能登记。
	 */
	register(
		project: ProjectId,
		agent: string,
		caller: { userId: string | null },
	): Promise<RegisterWorkbenchOutcome> {
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
			// 开关已经开着（有项目登记过）时不再要求「整个部署都换成 Agent 凭据」：旧方式的连接反正连不上，换工作台只看工作台本身。
			if (!(await this.credentialRequired())) {
				// 第一次登记打开的是整个部署的开关（不可逆，所有项目都只接受 Agent 凭据）：要平台管理员（#778，ADR 0029）。
				if (!(await this.#isPlatformAdmin(caller.userId))) {
					return { ok: false, reason: "switch_needs_platform_admin" };
				}
				const pending = await agentsNotOnCredentials(db);
				if (pending.length > 0) {
					const here = pending.filter((p) => p.projectId === project).map((p) => p.name);
					return {
						ok: false,
						reason: "agents_not_on_credentials",
						agents: here,
						otherProjects: pending.length - here.length,
					};
				}
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

	async #isPlatformAdmin(userId: string | null): Promise<boolean> {
		if (userId === null) return false;
		const [row] = await this.deps.db
			.select({ admin: users.isPlatformAdmin })
			.from(users)
			.where(eq(users.id, userId));
		return row?.admin === true;
	}
}
