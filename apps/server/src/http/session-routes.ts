import {
	type Readiness,
	SESSION_SEQ_MAX,
	type SessionDetailResponse,
	type SessionView,
	sessionsApi,
} from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseProjectId } from "../projects/project-id.js";
import { FollowOverflowError } from "../sessions/follow.js";
import { type SessionRow, type SessionStore, toListItem } from "../sessions/session-store.js";
import type { Sse } from "../sse/sse.js";
import { requireActor } from "./actor.js";
import { contractRoute, contractStream } from "./contract-route.js";
import { sendError } from "./errors.js";

const projectNotFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "project not found");
const sessionNotFound = (reply: FastifyReply) =>
	sendError(reply, 404, "not_found", "session not found");

/** 助手没有配置（或还没有接上）：写接口返回 503 `assistant_not_configured`。 */
const notConfigured = (reply: FastifyReply, readiness: Readiness) =>
	sendError(
		reply,
		503,
		"assistant_not_configured",
		readiness.problems.map((problem) => problem.message).join("；") || "助手没有配置",
	);

export interface SessionRouteDeps {
	sessions: SessionStore;
	sse: Sse;
	/** 助手此刻能不能用（src/sessions/readiness.ts）；每次列出会话时算一次。 */
	readiness: () => Promise<Readiness>;
}

/**
 * 助手会话（契约见 @sfly/schema 的 sessionsApi，ADR 0027）：列出、读、事件流，以及写接口。
 * 项目不存在、会话不存在（或属于别的项目：访问检查在进处理函数之前已经按会话所在的项目判断过）都是 404。
 * 写接口需要昵称（记为发起人）；助手没有配置时返回 503 `assistant_not_configured`，读接口照常。
 */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
	const { sessions, sse } = deps;

	/** 会话的视图：列表项的字段加项目和就绪状态。 */
	const view = async (row: SessionRow, readiness: Readiness): Promise<SessionView> => ({
		...toListItem(row, await sessions.lastOutcome(row.id)),
		project: row.projectId,
		readiness,
		// 排队（#544）之前没有会话在排队，也就没有在等谁。
		waiting_for: null,
	});

	contractRoute(app, sessionsApi.list, async ({ params }, reply) => {
		const project = parseProjectId(params.project);
		if (project === undefined || !(await sessions.projectExists(project))) {
			return projectNotFound(reply);
		}
		return { readiness: await deps.readiness(), sessions: await sessions.list(project) };
	});

	contractRoute(app, sessionsApi.create, async ({ params }, reply, request) => {
		const actor = requireActor(request, reply);
		if (actor === undefined) return reply;
		const project = parseProjectId(params.project);
		if (project === undefined || !(await sessions.projectExists(project))) {
			return projectNotFound(reply);
		}
		return notConfigured(reply, await deps.readiness());
	});

	contractRoute(app, sessionsApi.get, async ({ params, query }, reply) => {
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		const { events, hasMore } = await sessions.page(row.id, query.before);
		const detail: SessionDetailResponse = {
			...(await view(row, await deps.readiness())),
			events,
			has_more: hasMore,
		};
		return detail;
	});

	contractStream(app, sse, sessionsApi.events, async ({ params, query }, open, reply, request) => {
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		open((stream) => {
			// 序号超过 int4 的 Last-Event-ID 和超限的 `after` 一样不合法；流已经打开不能再 400，当作没带。
			const resume = Number(stream.lastEventId);
			const after = Math.max(
				query.after ?? 0,
				Number.isSafeInteger(resume) && resume > 0 && resume <= SESSION_SEQ_MAX ? resume : 0,
			);
			return sessions.follow(
				row.id,
				after,
				{
					emit: (event) => {
						// 持久的事件以序号作 SSE 的事件 ID；不持久的没有 ID，不推进浏览器续传的位置。
						if ("seq" in event) stream.send(event.type, event, event.seq);
						else stream.send(event.type, event);
					},
					drained: () => stream.drained(),
				},
				(error) => {
					// 缓冲溢出是客户端读得太慢，不是服务端的错：关掉流，浏览器按 Last-Event-ID 重连。
					if (error instanceof FollowOverflowError) request.log.warn(error.message);
					else request.log.error(error);
					stream.close();
				},
			);
		});
		return undefined;
	});

	contractRoute(app, sessionsApi.message, async ({ params }, reply, request) => {
		const actor = requireActor(request, reply);
		if (actor === undefined) return reply;
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		return notConfigured(reply, await deps.readiness());
	});

	contractRoute(app, sessionsApi.stop, async ({ params }, reply, request) => {
		const actor = requireActor(request, reply);
		if (actor === undefined) return reply;
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		return notConfigured(reply, await deps.readiness());
	});
}
