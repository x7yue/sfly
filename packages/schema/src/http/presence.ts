import { z } from "zod";
import { endpoint, stream } from "./contract.js";

/**
 * 在线编辑者接口的契约（约定见 ./contract.ts，docs/ARCHITECTURE.md §6.4）：编辑页面每 10 秒发一次心跳，
 * 通过 SSE 接收名单，关闭页面时主动离开（否则 30 秒无心跳后移除）。名单只在控制面内存里。
 */

/** 一个打开着编辑页面的浏览器标签页。 */
export const OnlineEditorView = z.object({
	session_id: z.string(),
	nickname: z.string(),
});

/** 在线编辑者名单（心跳的响应、SSE 的 `editors` 事件）。 */
export const EditorsEvent = z.object({
	orchestration_id: z.string(),
	editors: z.array(OnlineEditorView),
});

const IdParams = z.object({ id: z.string() });
/** 每次打开编辑页面随机生成的会话 ID：同一昵称在多个标签页打开时互不覆盖。 */
const SessionBody = z.object({ session_id: z.string().trim().min(1).max(200) });

export const presenceApi = {
	/** 心跳（需要昵称请求头）；场景不存在时 404。返回当前名单。 */
	heartbeat: endpoint({
		method: "POST",
		path: "/orchestrations/:id/presence",
		client: false,
		key: ["presence", "heartbeat"],
		params: IdParams,
		body: SessionBody,
		response: z.object({ editors: z.array(OnlineEditorView) }),
	}),
	/**
	 * 主动离开（204，没有响应体）：浏览器关闭页面时用 keepalive 请求发出，不要求昵称
	 * （只移除这个随机会话 ID 自己）。
	 */
	leave: endpoint({
		method: "POST",
		path: "/orchestrations/:id/presence/leave",
		client: false,
		key: ["presence", "leave"],
		params: IdParams,
		body: SessionBody,
		response: z.undefined(),
	}),
	/** 名单的实时推送（SSE）：连上时先发一次，之后名单变化时再发（事件 `editors`）。 */
	events: stream({
		path: "/orchestrations/:id/presence/events",
		client: false,
		params: IdParams,
		events: { editors: EditorsEvent },
	}),
};

export type OnlineEditorView = z.infer<typeof OnlineEditorView>;
export type EditorsEvent = z.infer<typeof EditorsEvent>;
