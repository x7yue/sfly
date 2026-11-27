// 项目的工作台：登记（契约在 packages/schema/src/http/projects.ts，ADR 0027、0029「迁移与过渡」，#549）。
// 走到这里的请求已经过了访问检查：项目是路径里的 `:project`（存在、凭据属于它），范围是「管理」，凭据是人（登录、个人令牌）。
// 登记的条件和竞争怎么处理见 src/projects/project-workbench.ts 的文件头。
import { projectWorkbenchApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { parseProjectId } from "../projects/project-id.js";
import type { ProjectWorkbench } from "../projects/project-workbench.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

export function registerProjectWorkbenchRoutes(
	app: FastifyInstance,
	{ workbench }: { workbench: ProjectWorkbench },
): void {
	contractRoute(app, projectWorkbenchApi.register, async ({ params, body }, reply) => {
		const project = parseProjectId(params.project);
		if (project === undefined) return sendError(reply, 404, "not_found", "没有这个项目");
		const outcome = await workbench.register(project, body.agent);
		if (outcome.ok) {
			return { project: outcome.project, agent: outcome.agent, previous_agent: outcome.previous };
		}
		switch (outcome.reason) {
			case "project_not_found":
				return sendError(reply, 404, "not_found", "没有这个项目");
			case "agent_unknown":
				return sendError(
					reply,
					409,
					"workbench_agent_unknown",
					"这个项目里没有这台 Agent：工作台要先用自己的 Agent 凭据连上来过一次，再登记",
				);
			case "agent_disabled":
				return sendError(
					reply,
					409,
					"workbench_agent_disabled",
					"这台 Agent 被停用了：先恢复它（POST /agents/<名字>/enable），或者换一台作工作台",
				);
			case "agent_not_on_credential":
				return sendError(
					reply,
					409,
					"workbench_agent_not_on_credential",
					"这台 Agent 最近一次连接用的不是 Agent 凭据：为它签发 Agent 凭据，换进它的 agent.env 里重启，连上之后再登记",
				);
			case "agents_not_on_credentials":
				return sendError(
					reply,
					409,
					"agents_not_on_credentials",
					`还有 ${outcome.agents.length} 台没有停用的 Agent 最近一次连接用的不是 Agent 凭据，登记之后共享令牌和不带凭据的连接都会被拒绝：` +
						"为它们签发 Agent 凭据并换上重新连接（sfly agent credentials issue），或者停用它们（POST /agents/<名字>/disable），再登记",
					{ agents: outcome.agents },
				);
		}
	});
}
