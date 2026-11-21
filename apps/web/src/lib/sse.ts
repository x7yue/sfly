import type { RouteInput } from "@sfly/client";
import type { EndpointInput, StreamDef, StreamEvents } from "@sfly/schema";
import { apiClient } from "./api";

/** 事件名 → 处理函数；data 的类型由契约推导。 */
export type SseHandlers<S extends StreamDef> = {
	[K in keyof StreamEvents<S>]?: (data: StreamEvents<S>[K]) => void;
};

type AnyHandlers = Record<string, ((data: unknown) => void) | undefined>;

/**
 * 打开一条 SSE 连接（契约里的 `stream` 定义，断线后自动重连；不依赖组件）：
 *
 *   const close = openEventSource(logsApi.runEvents, { params: { id } }, { logs: (chunk) => … }, onOpen);
 *
 * - `handlers` 按事件名分发，data 已按 JSON 解析（开发环境下按契约校验，不符合时在控制台报错并丢弃）。
 * - `onOpen` 在每次（重新）连上时调用，可以用来重新拉取断线期间错过的数据。
 * - 返回关闭函数；组件里在 effect 里打开、卸载时调用它。
 *
 * 运行的实时状态不要自己开连接：`monitor/live-run.ts` 把同一次运行的订阅合并成一条共享连接。
 * 浏览器对同一来源的 HTTP/1.1 连接数有上限（约 6 条），一个页面尽量只开必要的流。
 */
export function openEventSource<S extends StreamDef>(
	def: S,
	input: EndpointInput<S>,
	handlers: SseHandlers<S>,
	onOpen?: () => void,
): () => void {
	const checked: AnyHandlers = {};
	for (const [event, handle] of Object.entries(handlers as AnyHandlers)) {
		checked[event] = (data) => {
			if (import.meta.env.DEV) {
				const parsed = def.events[event]?.safeParse(data);
				if (parsed && !parsed.success) {
					console.error(`SSE 事件不符合接口契约（${def.path} ${event}）`, parsed.error.issues);
					return;
				}
			}
			handle?.(data);
		};
	}
	return apiClient.subscribe(def, input as RouteInput, checked, { onOpen });
}
