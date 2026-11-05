import { useEffect, useRef } from "react";
import { API_BASE } from "./api";

/** 事件名 → 处理函数；data 已按 JSON 解析。 */
export type SseHandlers = Record<string, (data: unknown) => void>;

/**
 * 订阅控制面的 SSE 流（`GET /api<path>`，浏览器原生 EventSource，断线后自动重连）。
 *
 * - `handlers` 按事件名分发（控制面每条消息都有 `event:` 名称，data 是 JSON）；
 *   处理函数可以每次渲染都换新的，不会导致重连。
 * - `onOpen` 在每次（重新）连上时调用，可以用来补发心跳或重新拉取历史。
 * - `path` 为 null 时不连接。path 变化时关闭旧连接、打开新连接；组件卸载时关闭。
 *
 * 注意：EventSource 不能带自定义请求头（没有昵称头），SSE 路由只用于读取。
 * 浏览器对同一来源的 HTTP/1.1 连接数有上限（约 6 条），一个页面尽量只开必要的流。
 */
export function useEventSource(
	path: string | null,
	handlers: SseHandlers,
	onOpen?: () => void,
): void {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	const events = Object.keys(handlers).sort().join("\n");

	useEffect(() => {
		if (path === null) return;
		const source = new EventSource(`${API_BASE}${path}`);
		source.onopen = () => onOpenRef.current?.();
		for (const event of events.split("\n").filter(Boolean)) {
			source.addEventListener(event, (message) => {
				let data: unknown;
				try {
					data = JSON.parse((message as MessageEvent<string>).data);
				} catch {
					return;
				}
				handlersRef.current[event]?.(data);
			});
		}
		return () => source.close();
	}, [path, events]);
}
