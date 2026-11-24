import { agentsApi, devAgentsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import type { AgentCredentialService } from "../agents/agent-credentials.js";
import type { AgentHub } from "../agents/agent-hub.js";
import type { AccountService } from "../auth/accounts.js";
import type { Engine } from "../engine/engine.js";
import type { OrchestrationStore } from "../orchestrations/orchestration-store.js";
import { agentReferences } from "../orchestrations/usage.js";
import { DEFAULT_PROJECT, parseProjectId } from "../projects/project-id.js";
import { contractRoute } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * Agent API（契约见 @sfly/schema 的 agentsApi）：GET /agents 全部注册过的 Agent；
 * POST /agents/:name/update-now 立即更新。路径还不带项目（#488）：Agent 都在默认项目里。
 */
export function registerAgentRoutes(
	app: FastifyInstance,
	{
		hub,
		engine,
		orchestrations,
		credentials,
		accounts,
	}: {
		hub: AgentHub;
		engine: Engine;
		orchestrations: OrchestrationStore;
		credentials: AgentCredentialService;
		accounts: AccountService;
	},
): void {
	contractRoute(app, agentsApi.updateNow, async ({ params }, reply) => {
		const outcome = await engine.updateNow(DEFAULT_PROJECT, params.name);
		if (!outcome.ok) return sendError(reply, outcome.status, outcome.code, outcome.message);
		return { terminated_tasks: outcome.terminated };
	});
	// ---- Agent 凭据：项目管理员（「管理」范围）签发、吊销；原值只在签发的响应里出现一次 ----
	contractRoute(app, agentsApi.listCredentials, async ({ params }) => ({
		credentials: await credentials.list(DEFAULT_PROJECT, params.name),
	}));
	contractRoute(app, agentsApi.issueCredential, async ({ params }, reply) =>
		reply.code(201).send(await credentials.issue(DEFAULT_PROJECT, params.name)),
	);
	contractRoute(app, agentsApi.revokeCredential, async ({ params }, reply) => {
		const result = await credentials.revoke(DEFAULT_PROJECT, params.name, params.id);
		if (result === "not_found") {
			return sendError(reply, 404, "not_found", "这台 Agent 没有这个凭据");
		}
		return reply.code(204).send();
	});
	// ---- 停用、恢复 ----
	contractRoute(app, agentsApi.disable, async ({ params }, reply) => {
		const result = await hub.setDisabled(DEFAULT_PROJECT, params.name, true);
		if (result === "not_found") return sendError(reply, 404, "not_found", "没有这台 Agent");
		return reply.code(204).send();
	});
	contractRoute(app, agentsApi.enable, async ({ params }, reply) => {
		const result = await hub.setDisabled(DEFAULT_PROJECT, params.name, false);
		if (result === "not_found") return sendError(reply, 404, "not_found", "没有这台 Agent");
		return reply.code(204).send();
	});
	// ---- 我的开发 Agent：名字由控制面生成，只认有用户的人的凭据（访问检查保证），要「编辑」范围 ----
	contractRoute(app, devAgentsApi.create, async ({ params, body }, reply, raw) => {
		const userId = raw.access?.userId;
		const project = parseProjectId(params.project);
		const user = userId == null ? undefined : await accounts.findUser(userId);
		if (user === undefined || project === undefined) {
			return sendError(reply, 401, "unauthorized", "凭据无效、已过期或已吊销");
		}
		const result = await credentials.issueDev(project, user, body.host);
		if (result.ok) {
			return reply
				.code(201)
				.send({ name: result.name, credential: result.credential, token: result.token });
		}
		if (result.reason === "exists") {
			return sendError(
				reply,
				409,
				"dev_agent_exists",
				`已经有一台叫 ${result.name} 的 Agent：换一个主机名`,
			);
		}
		if (result.reason === "invalid_host") {
			return sendError(reply, 400, "invalid_host", "主机名只能写小写字母、数字和连字符");
		}
		return sendError(
			reply,
			400,
			"dev_agent_name_too_long",
			`名字 ${result.name} 太长：换一个短一点的主机名`,
		);
	});
	contractRoute(app, devAgentsApi.revoke, async ({ params }, reply, raw) => {
		const userId = raw.access?.userId;
		const project = parseProjectId(params.project);
		if (userId == null || project === undefined) {
			return sendError(reply, 401, "unauthorized", "凭据无效、已过期或已吊销");
		}
		const result = await credentials.revokeDev(project, params.name, {
			userId,
			canManage: raw.access?.scopes.includes("manage") ?? false,
		});
		if (result.kind === "not_found") {
			return sendError(reply, 404, "not_found", "没有这台开发 Agent");
		}
		if (result.kind === "forbidden") {
			return sendError(reply, 403, "forbidden", "只能吊销自己的开发 Agent，或者需要「管理」范围");
		}
		return reply.code(204).send();
	});
	contractRoute(app, agentsApi.list, async () => {
		const [agents, documents] = await Promise.all([
			hub.list(DEFAULT_PROJECT),
			orchestrations.rawHeadDocuments(DEFAULT_PROJECT),
		]);
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
