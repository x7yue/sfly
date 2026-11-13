import { type EndpointInput, type OnlineEditorView, presenceApi } from "@sfly/schema";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient, callApi } from "./api";
import { useNickname } from "./nickname";
import { useEventSource } from "./sse";

/** 自己在其他标签页打开着同一个场景时显示的名字。 */
export const OWN_OTHER_TAB = "你（其他标签页）";

/** 心跳间隔；控制面 30 秒没收到心跳就移除。 */
export const PRESENCE_HEARTBEAT_MS = 10_000;

/** crypto.randomUUID 只在安全上下文（https / localhost）可用，内网 http 部署时退回随机数。 */
const randomSessionId = (): string =>
	typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const sendHeartbeat = (orchestrationId: string, sessionId: string) =>
	callApi(presenceApi.heartbeat, {
		params: { id: orchestrationId },
		body: { session_id: sessionId },
	}).catch(() => {
		// 心跳失败（控制面重启等）不打扰用户，下一次心跳或 SSE 重连后自动恢复。
	});

/** 关闭页面或离开编辑页面时主动离开（presenceApi.leave）：keepalive 让页面卸载后请求仍会发出。 */
const sendLeave = (orchestrationId: string, sessionId: string) => {
	const input: EndpointInput<typeof presenceApi.leave> = {
		params: { id: orchestrationId },
		body: { session_id: sessionId },
	};
	void apiClient.request(presenceApi.leave, input, { keepalive: true }).catch(() => {
		// 离开失败时控制面 30 秒无心跳后自动移除。
	});
};

/**
 * 编辑页面的在线状态：每 10 秒发送一次带昵称的心跳，并通过 SSE 接收在线编辑者名单。
 * 返回**除自己这个标签页以外**的其他在线编辑者（按昵称去重，保持加入顺序）；
 * 自己的其他标签页显示为 {@link OWN_OTHER_TAB}。
 */
export function useOtherEditors(orchestrationId: string): string[] {
	const nickname = useNickname();
	// 每次打开编辑页面一个会话 ID：同一昵称在多个标签页打开时互不覆盖。
	// 离开后控制面不再接受这个会话的心跳，从往返缓存恢复页面时换一个新 ID 重新加入。
	const [sessionId, setSessionId] = useState(randomSessionId);
	const [editors, setEditors] = useState<OnlineEditorView[]>([]);

	const beat = useCallback(() => {
		if (nickname) void sendHeartbeat(orchestrationId, sessionId);
	}, [nickname, orchestrationId, sessionId]);

	useEffect(() => {
		beat();
		const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
		// 后台标签页的定时器会被浏览器节流，回到前台时立即补一次。
		const onVisible = () => {
			if (document.visibilityState === "visible") beat();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [beat]);

	// 关闭标签页（pagehide）或离开编辑页面（卸载）时主动离开，别人立即看不到自己。
	// 从往返缓存恢复（pageshow persisted）时换新会话 ID，心跳随之重新发出。
	useEffect(() => {
		const leave = () => sendLeave(orchestrationId, sessionId);
		const onShow = (e: PageTransitionEvent) => {
			if (e.persisted) setSessionId(randomSessionId());
		};
		window.addEventListener("pagehide", leave);
		window.addEventListener("pageshow", onShow);
		return () => {
			window.removeEventListener("pagehide", leave);
			window.removeEventListener("pageshow", onShow);
			leave();
		};
	}, [orchestrationId, sessionId]);

	useEventSource(
		presenceApi.events,
		{ params: { id: orchestrationId } },
		{
			editors: (event) => {
				if (event.orchestration_id === orchestrationId) setEditors(event.editors);
			},
		},
		// 重新连上（例如控制面重启后名单清空）时立即补发心跳，让别人尽快重新看到自己。
		beat,
	);

	return useMemo(() => {
		const names: string[] = [];
		for (const editor of editors) {
			if (editor.session_id === sessionId) continue;
			// 同一昵称的其他标签页：提示是自己（草稿共用同一份 localStorage，后保存的会覆盖）。
			const name = editor.nickname === nickname ? OWN_OTHER_TAB : editor.nickname;
			if (!names.includes(name)) names.push(name);
		}
		return names;
	}, [editors, sessionId, nickname]);
}
