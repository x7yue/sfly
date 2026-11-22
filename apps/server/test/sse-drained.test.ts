// SSE 流的 `drained()`：写出去的数据还没被对端读走时，调用方等到它读走再写下一批（会话事件流的补发用它，
// 慢客户端不会让整段历史堆在服务端的内存里）。真的 HTTP 连接：客户端暂停读取，服务端一直写到内核缓冲区写满。
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerSse, type SseStream } from "../src/sse/sse.js";

const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn();
	cleanup = [];
});

/** 起一个只有一条 SSE 路由的服务，连上一个客户端；返回服务端的流和客户端的响应。 */
async function connect(): Promise<{ stream: SseStream; client: http.IncomingMessage }> {
	const app = Fastify();
	const sse = registerSse(app, { clock, version: "test" });
	let opened!: (stream: SseStream) => void;
	const streamOpened = new Promise<SseStream>((resolve) => {
		opened = resolve;
	});
	app.get("/events", (request, reply) => {
		sse.open(request, reply, (stream) => {
			opened(stream);
			return undefined;
		});
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	cleanup.push(() => app.close());
	const { port } = app.server.address() as AddressInfo;
	const client = await new Promise<http.IncomingMessage>((resolve, reject) => {
		const req = http.get({ host: "127.0.0.1", port, path: "/events" }, resolve);
		req.on("error", reject);
		cleanup.push(() => {
			req.destroy();
		});
	});
	// 先不读：数据堆在内核缓冲区里。
	client.pause();
	return { stream: await streamOpened, client };
}

const pending = async (promise: Promise<void>, ms = 100): Promise<boolean> =>
	(await Promise.race([
		promise.then(() => false),
		new Promise((r) => setTimeout(() => r(true), ms)),
	])) as boolean;

/** 一直写到服务端的写缓冲写满（`drained()` 不再马上完成）。 */
async function fillUp(stream: SseStream): Promise<void> {
	const chunk = "x".repeat(256 * 1024);
	for (let i = 0; i < 400; i++) {
		if (await pending(stream.drained(), 0)) return;
		stream.send({ event: "fill", data: chunk });
	}
	throw new Error("写了 100 MB 缓冲还没写满");
}

describe("SseStream.drained", () => {
	it("对端还在读的时候马上完成", async () => {
		const { stream, client } = await connect();
		client.resume();
		stream.send({ event: "x", data: 1 });
		await stream.drained();
	});

	it("对端不读、缓冲写满之后一直等着，对端开始读了才完成", async () => {
		const { stream, client } = await connect();
		await fillUp(stream);
		expect(await pending(stream.drained())).toBe(true);
		client.resume();
		await stream.drained();
	});

	it("流结束时放行等着的调用方（不会永远等一个已经断开的客户端）", async () => {
		const { stream } = await connect();
		await fillUp(stream);
		const waiting = stream.drained();
		expect(await pending(waiting)).toBe(true);
		stream.close();
		await waiting;
		// 已经结束的流上再问：马上完成。
		await stream.drained();
	});

	it("客户端断开时放行等着的调用方", async () => {
		const { stream, client } = await connect();
		await fillUp(stream);
		const waiting = stream.drained();
		expect(await pending(waiting)).toBe(true);
		client.destroy();
		await waiting;
		expect(stream.closed).toBe(true);
	});
});
