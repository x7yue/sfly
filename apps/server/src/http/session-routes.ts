import {
	SESSION_SEQ_MAX,
	type SessionDetailResponse,
	type SessionView,
	sessionsApi,
	type TurnOutcome,
} from "@sfly/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import { credentialRequiredMessage } from "../auth/access-rules.js";
import { parseProjectId } from "../projects/project-id.js";
import { FollowOverflowError } from "../sessions/follow.js";
import type { Outcome, SessionService } from "../sessions/session-service.js";
import {
	SessionNotFoundError,
	type SessionRow,
	type SessionStore,
	toListItem,
} from "../sessions/session-store.js";
import type { Sse } from "../sse/sse.js";
import { actorOf } from "./actor.js";
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
 * 写接口的发起人是访问检查得出的身份；助手没有配置时返回 503 `assistant_not_configured`，读接口照常。
 * 新建返回 201 和新会话；发话返回这句话的序号；停止返回会话（这一轮的 `turn_end` 由助手服务的事件带回来）。
 */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
	const { sessions, service, sse } = deps;

	/**
	 * 会话的视图：列表项的字段加项目、就绪状态和在等谁（排队中时有排第几和在等谁）；`lastOutcome` 不给时现读
	 * （读会话那一个接口给它：状态、事件、上一轮的结局取自同一个快照）。
	 */
	const view = async (row: SessionRow, lastOutcome?: TurnOutcome | null): Promise<SessionView> => {
		const queue = await service.queueInfo(row);
		return {
			...toListItem(
				row,
				lastOutcome === undefined ? await sessions.lastOutcome(row.id) : lastOutcome,
				queue.position,
			),
			project: row.projectId,
			readiness: await service.readiness(row.projectId),
			waiting_for: queue.waitingFor,
		};
	};

	contractRoute(app, sessionsApi.list, async ({ params }, reply) => {
		const project = parseProjectId(params.project);
		if (project === undefined || !(await sessions.projectExists(project))) {
			return projectNotFound(reply);
		}
		const { sessions: items, truncated } = await sessions.list(project);
		return { readiness: await service.readiness(project), sessions: items, truncated };
	});

	contractRoute(app, sessionsApi.create, async ({ params, body }, reply, request) => {
		const actor = actorOf(request);
		// 建会话只认用户的凭据（访问检查已经对不带凭据的请求回了 401）：`created_by_user_id` 从凭据取，会话令牌要代他干活。
		// 这是第二道：没有经过访问检查的请求（没有身份）到这里也不能建出一个没有发起人的会话。
		if (actor.userId === null) {
			return sendError(reply, 401, "unauthorized", credentialRequiredMessage(sessionsApi.create));
		}
		const project = parseProjectId(params.project);
		if (project === undefined || !(await sessions.projectExists(project))) {
			return projectNotFound(reply);
		}
		const created = await service.create(project, actor, body.text);
		if (!created.ok) return refuse(reply, created);
		return reply.code(201).send(await view(created.value));
	});

	contractRoute(app, sessionsApi.get, async ({ params, query }, reply) => {
		const found = await sessions.find(params.id);
		if (!found) return sessionNotFound(reply);
		// 状态、事件、上一轮的结局取自同一个快照（`SessionStore.detail`）：分开读，读的当中这一轮结束了，响应是「状态在做、
		// 事件里已经有 turn_end」，页面就永远停在「在做」。
		const snapshot = await sessions.detail(found.id, query.before);
		if (!snapshot) return sessionNotFound(reply);
		const detail: SessionDetailResponse = {
			...(await view(snapshot.row, snapshot.lastOutcome)),
			events: snapshot.events,
			has_more: snapshot.hasMore,
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

	contractRoute(app, sessionsApi.message, async ({ params, body }, reply, request) => {
		const actor = actorOf(request);
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		// 写的时候会话被删了（新建会话没接住、等结局的那段时间删掉的）：和一开始找不到一样，404。
		try {
			const said = await service.say(row, actor, body.text);
			return said.ok ? said.value : refuse(reply, said);
		} catch (error) {
			if (error instanceof SessionNotFoundError) return sessionNotFound(reply);
			throw error;
		}
	});

	contractRoute(app, sessionsApi.end, async ({ params }, reply, request) => {
		const actor = actorOf(request);
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		try {
			const ended = await service.end(row, actor);
			if (!ended.ok) return refuse(reply, ended);
		} catch (error) {
			if (error instanceof SessionNotFoundError) return sessionNotFound(reply);
			throw error;
		}
		return view((await sessions.find(row.id)) ?? row);
	});

	contractRoute(app, sessionsApi.stop, async ({ params }, reply) => {
		const row = await sessions.find(params.id);
		if (!row) return sessionNotFound(reply);
		try {
			const stopped = await service.stop(row);
			if (!stopped.ok) return refuse(reply, stopped);
		} catch (error) {
			if (error instanceof SessionNotFoundError) return sessionNotFound(reply);
			throw error;
		}
		return view((await sessions.find(row.id)) ?? row);
	});
}
