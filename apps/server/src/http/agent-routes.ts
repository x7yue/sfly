import { agentsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { AgentHub } from "../agents/agent-hub.js";
import type { Engine } from "../engine/engine.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import { agentReferences } from "../orchestrations/usage.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * Agent API（契约见 @sfly/schema 的 agentsApi）：GET /agents 全部注册过的 Agent；
 * POST /agents/:name/update-now 立即更新。
 */
export function registerAgentRoutes(
	app: FastifyInstance,
	{
		hub,
		engine,
		orchestrations,
	}: { hub: AgentHub; engine: Engine; orchestrations: OrchestrationStore },
): void {
	contractRoute(app, agentsApi.updateNow, async ({ params }, reply) => {
		const outcome = await engine.updateNow(params.name);
		if (!outcome.ok) return sendError(reply, outcome.status, outcome.code, outcome.message);
		return { terminated_tasks: outcome.terminated };
	});
	contractRoute(app, agentsApi.list, async () => {
		const [agents, documents] = await Promise.all([hub.list(), orchestrations.headDocuments()]);
		// 引用数随各场景的最新版本变化，查询时现算。
		const references = agentReferences(documents);
		return {
			agents: agents.map((agent) => ({
				...agent,
				referencing_orchestrations: references.get(agent.name) ?? 0,
			})),
			control_plane_version: hub.version,
		};
	});
}
