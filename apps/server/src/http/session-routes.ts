import { type SessionDetailResponse, type SessionView, sessionsApi } from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseProjectId } from "../projects/project-id.js";
import type { Outcome, SessionService } from "../sessions/session-service.js";
import { type SessionRow, type SessionStore, toListItem } from "../sessions/session-store.js";
import type { Sse } from "../sse/sse.js";
import { requireActor } from "./actor.js";
import { contractRoute, contractStream } from "./contract-route.js";
import { sendError } from "./errors.js";

const projectNotFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "project not found");
const sessionNotFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "session not found");

/** 写没有成功：状态码、错误码和说明都是服务给的。 */
const refuse = (reply: FastifyReply, outcome: Extract<Outcome<unknown>, { ok: false }>) =>
	sendError(reply, outcome.status, outcome.code, outcome.message);

export interface SessionRouteDeps {
	sessions: SessionStore;
	/** 写接口和就绪状态（src/sessions/session-service.ts）。 */
	service: SessionService;
	sse: Sse;
}

/**
 * 助手会话（契约见 @sfly/schema 的 sessionsApi，ADR 0027）：列出、读、事件流，以及写接口。
 * 项目不存在、会话不存在（或属于别的项目：访问检查在进处理函数之前已经按会话所在的项目判断过）都是 404。
 * 写接口需要昵称（记为发起人）；助手没有配置时返回 503 `assistant_not_configured`，读接口照常。
 * 新建返回 201 和新会话；发话返回这句话的序号；停止返回会话（这一轮的 `turn_end` 由助手服务的事件带回来）。
 */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
	const { sessions, service, sse } = deps;

	/** 会话的视图：列表项的字段加项目、就绪状态和在等谁。 */
	const view = async (row: SessionRow): Promise<SessionView> => ({
		...toListItem(row, await sessions.lastOutcome(row.id)),
		project: row.projectId,
		readiness: await service.readiness(row.projectId),
		// 排队（#544）之前没有会话在排队，也就没有在等谁。
		waiting_for: null,
	});

	contractRoute(app, sessionsApi.list, async ({ params }, reply) => {
		const project = parseProjectId(params.project);
		if (project === undefined || !(await sessions.projectExists(project))) {
			return projectNotFound(reply);
		}
		return { readiness: await service.readiness(project), sessions: await sessions.list(project) };
	});

	contractRoute(app, sessionsApi.create, async ({ params, body }, reply, request) => {
		const actor = requireActor(request, reply);
		if (actor === undefined) return reply;
		const project = parseProjectId(params.project);
		if (project === undefined || !(await sessions.projectExists(project))) {
			return projectNotFound(reply);
		}
		const created = await service.create(project, actor, body.text);
		if (!created.ok) return refuse(reply, created);
		return reply.code(201).send(await view(created.value));
	});

	contractRoute(app, sessionsApi.get, async ({ params, query }, reply) => {
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		const { events, hasMore } = await sessions.page(row.id, query.before);
		const detail: SessionDetailResponse = { ...(await view(row)), events, has_more: hasMore };
		return detail;
	});

	contractStream(app, sse, sessionsApi.events, async ({ params, query }, open, reply, request) => {
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		open((stream) => {
			const resume = Number(stream.lastEventId);
			const after = Math.max(
				query.after ?? 0,
				Number.isSafeInteger(resume) && resume > 0 ? resume : 0,
			);
			return sessions.follow(
				row.id,
				after,
				(event) => {
					// 持久的事件以序号作 SSE 的事件 ID；不持久的没有 ID，不推进浏览器续传的位置。
					if ("seq" in event) stream.send(event.type, event, event.seq);
					else stream.send(event.type, event);
				},
				(error) => {
					request.log.error(error);
					stream.close();
				},
			);
		});
		return undefined;
	});

	contractRoute(app, sessionsApi.message, async ({ params, body }, reply, request) => {
		const actor = requireActor(request, reply);
		if (actor === undefined) return reply;
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		const said = await service.say(row, actor, body.text);
		return said.ok ? said.value : refuse(reply, said);
	});

	contractRoute(app, sessionsApi.stop, async ({ params }, reply, request) => {
		const actor = requireActor(request, reply);
		if (actor === undefined) return reply;
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		const stopped = await service.stop(row);
		if (!stopped.ok) return refuse(reply, stopped);
		return view((await sessions.find(row.id)) ?? row);
	});
}
