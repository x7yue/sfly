import { z } from "zod";
import {
	CreateSessionBody,
	SendMessageBody,
	SendMessageResult,
	SessionDetailQuery,
	SessionDetailResponse,
	SessionEventsQuery,
	SessionListResponse,
	SessionView,
	sessionEventSchemas,
} from "../sessions.js";
import { endpoint, stream } from "./contract.js";

/**
 * 助手会话的接口（GLOSSARY「助手」「会话」，ADR 0027）。类型（事件、请求、响应）在 ../sessions.ts，这里只有接口表。
 *
 * 路径按 ADR 0029「项目从请求的哪里来」：列出和新建在 `/projects/:project/sessions`，其余按会话 ID 定位、路径里不带项目，
 * 项目从会话所在的项目得出。控制面是用户和助手之间唯一的入口：助手服务只和控制面说话（../assistant-protocol.ts）。
 *
 * 错误码（`ApiErrorBody.error.code`，取值见 `SessionErrorCode`）：写接口在助手没有配置时返回 503 `assistant_not_configured`
 * （读接口照常，就绪状态里写明原因）；助手服务连不上 503 `assistant_unavailable`；发话时会话在排队中 409
 * `session_queued`，已结束或者正在结束 409 `session_ended`（在做时发话是插话，不再是 409；同一个项目另一个会话在做时这个会话排队，
 * 不再是 409 `project_busy`，#544）。项目或会话不存在（或属于别的项目）一律 404。
 */

/** 路径里的项目标识（`/projects/:project/…`，ADR 0029）：写法不对或不存在时 404。 */
const ProjectParams = z.object({ project: z.string() });

/** 路径里的会话 ID：不是 UUID 时控制面返回 404（与找不到相同），所以这里只要求是字符串。 */
const IdParams = z.object({ id: z.string() });

export const sessionsApi = {
	/** 项目里的会话（最近活动在前），以及助手此刻能不能用。 */
	list: endpoint({
		method: "GET",
		path: "/projects/:project/sessions",
		summary: "列出项目里的会话，以及助手此刻能不能用",
		effect: "read",
		resource: { kind: "session", target: "collection" },
		client: true,
		key: ["sessions", "list"],
		params: ProjectParams,
		response: SessionListResponse,
	}),
	/**
	 * 新建一个会话，`text` 是它的第一句话，作为第一轮：写 `user_message` 和 `turn_started`，把这一轮交给助手服务。
	 * 返回 201 和新会话。助手没有配置时 503 `assistant_not_configured`；这个项目里已有别的会话在做（或在排队）时，新会话
	 * 排队（`status` 是 `queued`，`queue_position` 是排第几，`waiting_for` 是在等谁），这句话照常写 `user_message`，
	 * 轮到它时才交给助手服务；助手服务连不上 503 `assistant_unavailable`，不留下会话。
	 */
	create: endpoint({
		method: "POST",
		path: "/projects/:project/sessions",
		summary: "新建一个会话，把第一句话作为它的第一轮",
		effect: "write",
		resource: { kind: "session", target: "collection" },
		client: true,
		key: ["sessions", "create"],
		params: ProjectParams,
		body: CreateSessionBody,
		response: SessionView,
	}),
	/**
	 * 一个会话和它最近的持久事件（至多一页，序号升序）；`before`（序号）往前翻页，`has_more` 为 true 表示更早的还有。
	 */
	get: endpoint({
		method: "GET",
		path: "/sessions/:id",
		summary: "读一个会话和它的事件；before 往前翻页",
		effect: "read",
		resource: { kind: "session", target: { params: "id" } },
		client: true,
		key: ["sessions", "get"],
		params: IdParams,
		query: SessionDetailQuery,
		response: SessionDetailResponse,
	}),
	/**
	 * 实时推送一个会话的事件（SSE）：先按 `after` 和 `Last-Event-ID` 里较大的一个从库里补发，再接实时。
	 * 事件名是事件的 `type`，data 是事件（`SessionEvent`）：持久的事件以会话内序号 `seq` 作事件 ID，
	 * 不持久的（文字增量、工具输出、思考、排队状态、快照）没有 ID，不推进续传的位置。
	 */
	events: stream({
		path: "/sessions/:id/events",
		summary: "实时推送一个会话的事件",
		effect: "read",
		resource: { kind: "session", target: { params: "id" } },
		client: true,
		params: IdParams,
		query: SessionEventsQuery,
		events: sessionEventSchemas,
	}),
	/**
	 * 对会话说一句话，返回这句话的 `user_message` 的序号：空闲时开始新的一轮（这个项目里别的会话在做时，这个会话排队，
	 * 这句话轮到它时才交给助手服务）；**在做时是插话**（`user_message` 的 `steer` 为 true，交给助手服务的 `steer`，在当前这一步
	 * 的工具调用做完之后、下一次调用模型之前送到；响应类型不变）；**但控制面已经发出了中止、这一轮的结局还没有写下时（正在停止）
	 * 不是插话**：这句话是新的一轮的开头（`steer` 为 false），按说话的时刻排进项目里已有的队列、不插队，会话仍是在做、
	 * `queue_position` 有值，这一轮的结局写下之后开始它；排队中（包括这种）再说话 409 `session_queued`；已结束或者正在结束 409 `session_ended`。
	 */
	message: endpoint({
		method: "POST",
		path: "/sessions/:id/messages",
		summary: "对会话说一句话：空闲时开始新的一轮，在做时是插话",
		effect: "write",
		resource: { kind: "session", target: { params: "id" } },
		client: true,
		key: ["sessions", "message"],
		params: IdParams,
		body: SendMessageBody,
		response: SendMessageResult,
	}),
	/**
	 * 停止会话正在做的这一轮：把中止发给助手服务，这一轮的 `turn_end` 由助手服务的事件带回来；中止有没有得到确认都等到同一个期限
	 * （23 秒，从发出中止起算），到期还没有结局才由控制面补一条 `stopped`；这期间用户又说的话是新的一轮的开头，排在这一轮后面。
	 * **停止 = 这个会话在做的一轮停掉、排着的话移出队列**（`queue_cancelled` 的提示，带那句话的 `message_id`）：排队中的会话移出队列、
	 * 回到空闲；在做、而且停止途中又说了话排在后面的会话，再点一次停止就是撤掉那句话（只撤这次停止之前就排着的，这次停止的等待期间
	 * 说的话照旧排在后面）；空闲的会话不改（向助手服务补发一次带最近那一轮轮次的中止，兜底「`prompt` 超时之后补发的中止没送到」），
	 * 已结束的什么也不做。会话的状态一直在变、重试三次都没有做成时 409 `turn_running`。
	 */
	stop: endpoint({
		method: "POST",
		path: "/sessions/:id/stop",
		summary: "停止会话正在做的这一轮；排队中的移出队列",
		effect: "write",
		resource: { kind: "session", target: { params: "id" } },
		client: true,
		key: ["sessions", "stop"],
		params: IdParams,
		response: SessionView,
	}),
	/**
	 * 结束会话：在做的一轮先停止、等到这一轮的结局，排队的移出队列；然后会话变成已结束并写 `session_ended`，**写下之后**才把 `end` 发给
	 * 助手服务（它结束这个会话的进程；助手服务不记得会话结束了，所以先写下结束，之后控制面不再为这个会话发命令）。之后发话 409 `session_ended`。工作区、提交、场景版本、运行都留着，不删除任何东西。
	 * 已经结束的会话再调用无害（返回会话，不再写事件）。助手没有配置时 503 `assistant_not_configured`。停止之后又开始了一轮（说话和
	 * 结束同时到）会再停一次，重试三次还不行时 409 `turn_running`。**结束一开始就记成「正在结束」**：写下 `session_ended` 之前对它说话回
	 * 409 `session_ended`，也不会为它开始新的一轮。
	 */
	end: endpoint({
		method: "POST",
		path: "/sessions/:id/end",
		summary: "结束会话：之后不再接受消息，工作区和运行都留着",
		effect: "write",
		resource: { kind: "session", target: { params: "id" } },
		client: true,
		key: ["sessions", "end"],
		params: IdParams,
		response: SessionView,
	}),
};
