import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPost } from "./api";
import { useNickname } from "./nickname";
import { useEventSource } from "./sse";

/** 一个打开着编辑页面的浏览器标签页（控制面 `GET /orchestrations/:id/presence/events`）。 */
export interface OnlineEditor {
	session_id: string;
	nickname: string;
}

interface EditorsEvent {
	orchestration_id: string;
	editors: OnlineEditor[];
}

/** 心跳间隔；控制面 30 秒没收到心跳就移除。 */
export const PRESENCE_HEARTBEAT_MS = 10_000;

/** crypto.randomUUID 只在安全上下文（https / localhost）可用，内网 http 部署时退回随机数。 */
const randomSessionId = (): string =>
	typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const sendHeartbeat = (orchestrationId: string, sessionId: string) =>
	apiPost<{ editors: OnlineEditor[] }>(`/orchestrations/${orchestrationId}/presence`, {
		session_id: sessionId,
	}).catch(() => {
		// 心跳失败（控制面重启等）不打扰用户，下一次心跳或 SSE 重连后自动恢复。
	});

/**
 * 编辑页面的在线状态：每 10 秒发送一次带昵称的心跳，并通过 SSE 接收在线编辑者名单。
 * 返回**除自己这个标签页以外**的其他在线编辑者（按昵称去重，保持加入顺序）。
 */
export function useOtherEditors(orchestrationId: string): string[] {
	const nickname = useNickname();
	// 每次打开编辑页面一个会话 ID：同一昵称在多个标签页打开时互不覆盖。
	const sessionId = useMemo(randomSessionId, []);
	const [editors, setEditors] = useState<OnlineEditor[]>([]);

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

	useEventSource(
		`/orchestrations/${orchestrationId}/presence/events`,
		{
			editors: (data) => {
				const event = data as EditorsEvent;
				if (event.orchestration_id === orchestrationId) setEditors(event.editors);
			},
		},
		// 重新连上（例如控制面重启后名单清空）时立即补发心跳，让别人尽快重新看到自己。
		beat,
	);

	return useMemo(() => {
		const names: string[] = [];
		for (const editor of editors) {
			if (editor.session_id !== sessionId && !names.includes(editor.nickname)) {
				names.push(editor.nickname);
			}
		}
		return names;
	}, [editors, sessionId]);
}
