import type { EndpointInput, StreamDef, StreamEvents } from "@sfly/schema";
import { useEffect, useRef } from "react";
import { apiUrl, type InputArgs } from "./api";

/** 事件名 → 处理函数；data 的类型由契约推导。 */
export type SseHandlers<S extends StreamDef> = {
	[K in keyof StreamEvents<S>]?: (data: StreamEvents<S>[K]) => void;
};

/**
 * 订阅控制面的 SSE 流（契约里的 `stream` 定义，浏览器原生 EventSource，断线后自动重连）：
 *
 *   useEventSource(runsApi.events, running ? { params: { id } } : null, { run: (view) => … });
 *
 * - `input` 为 null 时不连接；路径或查询参数变化时关闭旧连接、打开新连接；组件卸载时关闭。
 * - `handlers` 按事件名分发，data 已按 JSON 解析（开发环境下还按契约校验，不符合时在控制台报错并丢弃）；
 *   处理函数可以每次渲染都换新的，不会导致重连。
 * - `onOpen` 在每次（重新）连上时调用，可以用来补发心跳或重新拉取历史。
 *
 * 注意：EventSource 不能带自定义请求头（没有昵称头），SSE 路由只用于读取。
 * 浏览器对同一来源的 HTTP/1.1 连接数有上限（约 6 条），一个页面尽量只开必要的流。
 */
export function useEventSource<S extends StreamDef>(
	def: S,
	input: EndpointInput<S> | null,
	handlers: SseHandlers<S>,
	onOpen?: () => void,
): void {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	const url = input === null ? null : apiUrl(def, ...([input] as InputArgs<S>));
	const events = Object.keys(handlers).sort().join("\n");

	useEffect(() => {
		if (url === null) return;
		return openEventSource(
			def,
			url,
			events.split("\n").filter(Boolean),
			(event, data) =>
				(handlersRef.current as Record<string, ((data: unknown) => void) | undefined>)[event]?.(
					data,
				),
			() => onOpenRef.current?.(),
		);
	}, [url, events, def]);
}

/**
 * 打开一条 SSE 连接（不依赖组件，useEventSource 与跨组件共用的连接都用它）：按事件名分发已解析的 data
 * （开发环境下按契约校验，不符合时在控制台报错并丢弃）。返回关闭函数。
 */
export function openEventSource<S extends StreamDef>(
	def: S,
	url: string,
	events: readonly string[],
	dispatch: (event: string, data: unknown) => void,
	onOpen?: () => void,
): () => void {
	const source = new EventSource(url);
	source.onopen = () => onOpen?.();
	for (const event of events) {
		source.addEventListener(event, (message) => {
			let data: unknown;
			try {
				data = JSON.parse((message as MessageEvent<string>).data);
			} catch {
				return;
			}
			if (import.meta.env.DEV) {
				const parsed = def.events[event]?.safeParse(data);
				if (parsed && !parsed.success) {
					console.error(`SSE 事件不符合接口契约（${def.path} ${event}）`, parsed.error.issues);
					return;
				}
			}
			dispatch(event, data);
		});
	}
	return () => source.close();
}
