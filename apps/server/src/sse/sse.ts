import {
	CONTROL_PLANE_TIME_EVENT,
	CONTROL_PLANE_TIME_HEADER,
	CONTROL_PLANE_VERSION_HEADER,
} from "@sfly/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "../clock.js";

/** 一条 SSE 消息。data 按 JSON 序列化；id 会成为浏览器重连时的 `Last-Event-ID`。 */
export interface SseMessage {
	event: string;
	data: unknown;
	id?: string | number;
}

/** 一条打开的 SSE 流。 */
export interface SseStream {
	send(message: SseMessage): void;
	/** 由服务端结束这条流。 */
	close(): void;
	readonly closed: boolean;
	/** 浏览器重连时带上的最后一条消息 ID（`Last-Event-ID` 请求头）。 */
	readonly lastEventId: string | undefined;
}

/** setup 里订阅数据源，返回的清理函数在流结束（客户端断开、服务端关闭）时调用一次。 */
export type SseSetup = (stream: SseStream) => (() => void) | undefined;

export interface SseOptions {
	/** 控制面时间的来源：每条流在连上时和每次心跳都把它发给页面。 */
	clock: Clock;
	/** 控制面版本：每条流的响应头都带上它（{@link CONTROL_PLANE_VERSION_HEADER}）。 */
	version: string;
	/** 心跳的间隔（带控制面时间，也防止代理断开空闲连接），默认 15 秒。 */
	heartbeatMs?: number;
	/** 建议浏览器断线后多久重连，默认 3 秒。 */
	retryMs?: number;
}

/**
 * 控制面的 SSE 推送（运行状态、日志、在线编辑者共用）。
 *
 * 用 `registerSse(app, { clock, version })` 创建，路由里 `sse.open(request, reply, setup)` 把请求变成 SSE 流。
 * 每条流在连上时和每次心跳都发一条控制面时间事件（@sfly/schema 的 CONTROL_PLANE_TIME_EVENT）。
 * 控制面关闭时（Fastify preClose）结束所有打开的流，避免长连接拖住 `app.close()`。
 */
export interface Sse {
	open(request: FastifyRequest, reply: FastifyReply, setup: SseSetup): void;
	/** 当前打开的流数量。 */
	readonly size: number;
}

export function registerSse(app: FastifyInstance, options: SseOptions): Sse {
	const { clock } = options;
	const heartbeatMs = options.heartbeatMs ?? 15_000;
	const retryMs = options.retryMs ?? 3_000;
	const open = new Set<SseStream>();

	app.addHook("preClose", (done) => {
		for (const stream of [...open]) stream.close();
		done();
	});

	return {
		get size() {
			return open.size;
		},
		open(request, reply, setup) {
			reply.hijack();
			const res = reply.raw;
			const time = () => clock.now().toISOString();
			// hijack 之后 Fastify 不再发送 reply 上已经设置的响应头（例如 onRequest 里设置的跨域头）。
			for (const [name, value] of Object.entries(reply.getHeaders())) {
				if (value !== undefined) res.setHeader(name, value);
			}
			res.writeHead(200, {
				[CONTROL_PLANE_TIME_HEADER]: time(),
				[CONTROL_PLANE_VERSION_HEADER]: options.version,
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				// 让 nginx 等反向代理不要缓冲。
				"x-accel-buffering": "no",
			});
			res.write(`retry: ${retryMs}\n\n`);
			const sendTime = () =>
				res.write(formatMessage({ event: CONTROL_PLANE_TIME_EVENT, data: { time: time() } }));
			sendTime();

			let closed = false;
			let cleanup: (() => void) | undefined;
			const heartbeat = setInterval(sendTime, heartbeatMs);
			heartbeat.unref();

			const finish = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				open.delete(stream);
				cleanup?.();
			};
			const lastEventId = request.headers["last-event-id"];
			const stream: SseStream = {
				get closed() {
					return closed;
				},
				lastEventId: typeof lastEventId === "string" ? lastEventId : undefined,
				send(message) {
					if (closed) return;
					res.write(formatMessage(message));
				},
				close() {
					if (closed) return;
					finish();
					res.end();
				},
			};
			open.add(stream);
			res.on("close", finish);
			try {
				cleanup = setup(stream) ?? undefined;
			} catch (error) {
				stream.close();
				throw error;
			}
			// setup 期间流可能已经结束（客户端立即断开）。
			if (closed) cleanup?.();
		},
	};
}

function formatMessage({ event, data, id }: SseMessage): string {
	const lines = [`event: ${event}`];
	if (id !== undefined) lines.push(`id: ${id}`);
	for (const line of JSON.stringify(data).split("\n")) lines.push(`data: ${line}`);
	return `${lines.join("\n")}\n\n`;
}
