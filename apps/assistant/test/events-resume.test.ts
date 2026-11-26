// 事件流的续传和背压（#545，协议见 `@sfly/schema` 的 `AssistantEventsQuery`）：助手服务在内存里留最近 1 万条持久的事件，
// `GET /events?after=<纪元>:<序号>` 补发 `after` 之后的、再接实时的，`hello.gap` 说补得回补不回；对端读得太慢就断开它。
// 不起 pi：事件总线加协议的 HTTP 一侧（`createAssistantServer`），会话管理器用桩。
import { get, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	ASSISTANT_REPLAY_BUFFER_BYTES,
	ASSISTANT_REPLAY_BUFFER_EVENTS,
	AssistantStreamLine,
	type AssistantStreamRecord,
} from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/bus.js";
import { createAssistantServer } from "../src/server.js";
import type { SessionManager } from "../src/sessions.js";
import { eventually } from "./support/eventually.js";

const SECRET = "events-resume-shared-secret-0123456789abcdef";
const SESSION = "6f1c2d3e-0000-4000-8000-000000000001";

const message = (text: string) => ({
	type: "assistant_message" as const,
	text,
	usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
});
const delta = (text: string) => ({ type: "assistant_delta" as const, text });

describe("EventBus：缓冲和续传", () => {
	it("只留持久的事件，最近 1 万条；序号只给持久的事件，整个助手服务共用", () => {
		expect(ASSISTANT_REPLAY_BUFFER_EVENTS).toBe(10_000);
		const bus = new EventBus(() => new Date("2026-01-01T00:00:00Z"), 3);
		expect(bus.emit(SESSION, 1, delta("a")).seq).toBeUndefined();
		expect(bus.emit(SESSION, 1, message("m1")).seq).toBe(1);
		expect(bus.emit(SESSION, 1, delta("b")).seq).toBeUndefined();
		expect(bus.buffered).toBe(1);
		for (let n = 2; n <= 6; n++) bus.emit(SESSION, 1, message(`m${n}`));
		expect(bus.buffered).toBe(3);
	});

	it("字节上限：行长加起来超过上限就从最早的挤，缓冲里的字节数不超过上限；挤出去之后 after 早于缓冲回 gap，接得上的不回", () => {
		expect(ASSISTANT_REPLAY_BUFFER_BYTES).toBe(64 * 1024 * 1024);
		const line = (n: number) => message(`${n}:${"x".repeat(1000)}`);
		const one = Buffer.byteLength(
			`${JSON.stringify({ epoch: "e".repeat(12), seq: 1, session_id: SESSION, turn: 1, at: "2026-01-01T00:00:00.000Z", event: line(1) })}\n`,
		);
		// 上限约 5 条：条数的上限放得很大，只有字节在起作用。
		const bus = new EventBus(() => new Date("2026-01-01T00:00:00Z"), 1_000_000, one * 5);
		for (let n = 1; n <= 20; n++) bus.emit(SESSION, 1, line(n));
		expect(bus.bufferedBytes).toBeLessThanOrEqual(one * 5);
		expect(bus.buffered).toBeGreaterThanOrEqual(4);
		expect(bus.buffered).toBeLessThanOrEqual(5);
		const oldest = 20 - bus.buffered + 1;
		// after 早于缓冲里最早的一条：有缺口。after 正好是被挤出的最后一条：接得上。
		expect(bus.resume({ epoch: bus.epoch, seq: 3 })).toEqual({ gap: true, lines: [] });
		const edge = bus.resume({ epoch: bus.epoch, seq: oldest - 1 });
		expect(edge.gap).toBe(false);
		expect(edge.lines).toHaveLength(bus.buffered);
		expect(bus.resume({ epoch: bus.epoch, seq: 20 })).toEqual({ gap: false, lines: [] });
	});

	it("一条比字节上限还大的事件把缓冲挤空（连自己）：之后 after 早于它的都是 gap，缓冲里没有东西，字节数是 0", () => {
		const bus = new EventBus(() => new Date(), 10_000, 500);
		bus.emit(SESSION, 1, message("小"));
		bus.emit(SESSION, 1, message("大".repeat(1000)));
		expect(bus.buffered).toBe(0);
		expect(bus.bufferedBytes).toBe(0);
		expect(bus.resume({ epoch: bus.epoch, seq: 0 })).toEqual({ gap: true, lines: [] });
		expect(bus.resume({ epoch: bus.epoch, seq: 1 })).toEqual({ gap: true, lines: [] });
		// 最后一条（被挤掉的）就是 after：之后没有东西缺。
		expect(bus.resume({ epoch: bus.epoch, seq: 2 })).toEqual({ gap: false, lines: [] });
	});

	it("挤出去的行立即释放：反复挤出不让缓冲的字节数和条数增长（不留到数组下一次挪动）", () => {
		const bus = new EventBus(() => new Date(), 1_000_000, 50_000);
		for (let n = 1; n <= 5000; n++) {
			bus.emit(SESSION, 1, message(`${n}:${"y".repeat(500)}`));
			expect(bus.bufferedBytes).toBeLessThanOrEqual(50_000);
		}
		expect(bus.buffered).toBeLessThan(100);
		// 数组里没有留着被挤出去的行（槽位置空）：引用着的行数就是缓冲里的条数，不是发出过的条数。
		expect(bus.retainedLines).toBe(bus.buffered);
		// 留着的是最近的、序号连续。
		const lines = bus.resume({ epoch: bus.epoch, seq: 5000 - bus.buffered }).lines;
		expect(lines.map((l) => (JSON.parse(l) as AssistantStreamRecord).seq)).toEqual(
			Array.from({ length: bus.buffered }, (_, i) => 5000 - bus.buffered + 1 + i),
		);
	});

	it("没有 after：不补发，没有缺口", () => {
		const bus = new EventBus();
		bus.emit(SESSION, 1, message("m"));
		expect(bus.resume(undefined)).toEqual({ gap: false, lines: [] });
	});

	it("纪元相同、after 之后的都还在缓冲里：补发它们（按序号，只有持久的），没有缺口；after 就是最后一条时什么也不补", () => {
		const bus = new EventBus();
		for (let n = 1; n <= 5; n++) {
			bus.emit(SESSION, 1, delta(`d${n}`));
			bus.emit(SESSION, 1, message(`m${n}`));
		}
		const seqs = (after: number) =>
			bus
				.resume({ epoch: bus.epoch, seq: after })
				.lines.map((line) => (JSON.parse(line) as AssistantStreamRecord).seq);
		expect(bus.resume({ epoch: bus.epoch, seq: 2 }).gap).toBe(false);
		expect(seqs(2)).toEqual([3, 4, 5]);
		expect(seqs(0)).toEqual([1, 2, 3, 4, 5]);
		expect(seqs(5)).toEqual([]);
		expect(bus.resume({ epoch: bus.epoch, seq: 5 }).gap).toBe(false);
	});

	it("纪元不同：有缺口，不补发", () => {
		const bus = new EventBus();
		bus.emit(SESSION, 1, message("m"));
		expect(bus.resume({ epoch: "别的纪元", seq: 1 })).toEqual({ gap: true, lines: [] });
	});

	it("after 早于缓冲里最早的一条（中间的被挤出去了）：有缺口；刚好接得上的（after 是被挤出的最后一条）没有缺口", () => {
		const bus = new EventBus(() => new Date(), 3);
		for (let n = 1; n <= 6; n++) bus.emit(SESSION, 1, message(`m${n}`)); // 缓冲里是 4、5、6
		expect(bus.resume({ epoch: bus.epoch, seq: 2 })).toEqual({ gap: true, lines: [] });
		const edge = bus.resume({ epoch: bus.epoch, seq: 3 });
		expect(edge.gap).toBe(false);
		expect(edge.lines).toHaveLength(3);
	});

	it("after 比助手服务发出过的最大序号还大：对不上，有缺口", () => {
		const bus = new EventBus();
		bus.emit(SESSION, 1, message("m"));
		expect(bus.resume({ epoch: bus.epoch, seq: 2 })).toEqual({ gap: true, lines: [] });
	});

	it("还没有过持久的事件：after 是 0 时没有缺口，也没有东西补", () => {
		const bus = new EventBus();
		bus.emit(SESSION, 1, delta("只有增量"));
		expect(bus.resume({ epoch: bus.epoch, seq: 0 })).toEqual({ gap: false, lines: [] });
	});

	it("缓冲满了之后挤出最早的、序号仍然连续（削开头不在每条事件上复制数组）", () => {
		const bus = new EventBus(() => new Date(), 5);
		for (let n = 1; n <= 5000; n++) bus.emit(SESSION, 1, message(`m${n}`));
		expect(bus.buffered).toBe(5);
		const lines = bus.resume({ epoch: bus.epoch, seq: 4995 }).lines;
		expect(lines.map((l) => (JSON.parse(l) as AssistantStreamRecord).seq)).toEqual([
			4996, 4997, 4998, 4999, 5000,
		]);
	});
});

/** 助手服务的 HTTP 一侧，会话管理器用桩（`/events` 用不到它）。 */
async function startServer(options: { bus?: EventBus; maxBacklogBytes?: number } = {}) {
	const bus = options.bus ?? new EventBus();
	const logs: string[] = [];
	const server: Server = createAssistantServer({
		secret: SECRET,
		bus,
		sessions: { activeProcesses: 0, maxProcesses: 8 } as unknown as SessionManager,
		versions: { assistant: "test", pi: "test" },
		model: () => ({
			configured: true,
			endpoint: null,
			reachable: true,
			checked_at: null,
			reason: null,
			error_class: null,
		}),
		log: (message) => logs.push(message),
		heartbeatMs: 60_000,
		...(options.maxBacklogBytes !== undefined && { maxBacklogBytes: options.maxBacklogBytes }),
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return { bus, server, port, logs };
}

/** 一条事件流的读者：`pause()` 之后不读（模拟读得慢的对端），行经协议的 schema 检查。 */
class Reader {
	readonly lines: AssistantStreamLine[] = [];
	closed = false;
	status = 0;
	#res: IncomingMessage | undefined;
	#buffer = "";

	static async open(port: number, after?: string, paused = false): Promise<Reader> {
		const reader = new Reader();
		await new Promise<void>((resolve, reject) => {
			const request = get(
				`http://127.0.0.1:${port}/events${after === undefined ? "" : `?after=${after}`}`,
				{ headers: { authorization: `Bearer ${SECRET}` } },
				(res) => {
					reader.#res = res;
					reader.status = res.statusCode ?? 0;
					res.setEncoding("utf8");
					if (paused) res.pause();
					res.on("data", (chunk: string) => reader.#take(chunk));
					// 对端读得慢（暂停）时 `res` 的 close 要等读完才来：以底下的连接为准。
					const closed = () => {
						reader.closed = true;
					};
					res.socket.on("close", closed);
					res.on("close", closed);
					res.on("error", closed);
					resolve();
				},
			);
			request.on("error", reject);
		});
		return reader;
	}

	#take(chunk: string): void {
		this.#buffer += chunk;
		const parts = this.#buffer.split("\n");
		this.#buffer = parts.pop() ?? "";
		for (const part of parts) {
			if (part !== "") this.lines.push(AssistantStreamLine.parse(JSON.parse(part)));
		}
	}

	pause(): void {
		this.#res?.pause();
	}
	resume(): void {
		this.#res?.resume();
	}
	close(): void {
		this.#res?.destroy();
	}

	get hello() {
		return this.lines.find((line) => "type" in line && line.type === "hello");
	}
	/** 收到的持久事件的序号（按到达的先后）。 */
	get seqs(): number[] {
		return this.lines.flatMap((line) =>
			"seq" in line && line.seq !== undefined ? [line.seq] : [],
		);
	}
}

describe("GET /events?after=：补发、接实时、缺口", () => {
	const servers: Server[] = [];
	const readers: Reader[] = [];
	afterEach(() => {
		for (const reader of readers.splice(0)) reader.close();
		for (const server of servers.splice(0)) {
			server.closeAllConnections();
			server.close();
		}
	});
	const start = async (options: Parameters<typeof startServer>[0] = {}) => {
		const started = await startServer(options);
		servers.push(started.server);
		return started;
	};
	const open = async (port: number, after?: string, paused = false) => {
		const reader = await Reader.open(port, after, paused);
		readers.push(reader);
		return reader;
	};

	it("after 在缓冲里：hello（没有缺口）、补发 after 之后的持久事件、再接实时的，不漏不重；没有 after 只推实时的", async () => {
		const { bus, port } = await start();
		for (let n = 1; n <= 5; n++) bus.emit(SESSION, 1, message(`m${n}`));
		const resumed = await open(port, `${bus.epoch}:2`);
		await eventually(() => expect(resumed.seqs).toEqual([3, 4, 5]));
		expect(resumed.hello).toEqual({ type: "hello", epoch: bus.epoch, gap: false });
		bus.emit(SESSION, 1, delta("实时的增量"));
		bus.emit(SESSION, 1, message("m6"));
		await eventually(() => expect(resumed.seqs).toEqual([3, 4, 5, 6]));
		const fresh = await open(port);
		expect(fresh.seqs).toEqual([]);
		bus.emit(SESSION, 1, message("m7"));
		await eventually(() => expect(fresh.seqs).toEqual([7]));
		// 补发的行是原样的记录（`at` 还是当时盖的）。
		expect(resumed.lines.find((l) => "seq" in l && l.seq === 3)).toMatchObject({
			event: { type: "assistant_message", text: "m3" },
		});
	});

	it("纪元不同或 after 早于缓冲：hello.gap 为 true，只推实时的；after 写得不对：400", async () => {
		const { bus, port } = await start({ bus: new EventBus(() => new Date(), 3) });
		for (let n = 1; n <= 6; n++) bus.emit(SESSION, 1, message(`m${n}`));
		const otherEpoch = await open(port, "别的纪元:3".replace("别的纪元", "other-epoch"));
		await eventually(() => expect(otherEpoch.hello).toMatchObject({ gap: true }));
		const tooOld = await open(port, `${bus.epoch}:1`);
		await eventually(() => expect(tooOld.hello).toMatchObject({ gap: true }));
		expect(otherEpoch.seqs).toEqual([]);
		expect(tooOld.seqs).toEqual([]);
		bus.emit(SESSION, 1, message("m7"));
		await eventually(() => expect(tooOld.seqs).toEqual([7]));
		for (const bad of ["abc", "e:x", "e:", ":3", "a b:1"]) {
			const res = await fetch(`http://127.0.0.1:${port}/events?after=${encodeURIComponent(bad)}`, {
				headers: { authorization: `Bearer ${SECRET}` },
			});
			expect(res.status, bad).toBe(400);
		}
	});

	it("补发很多（多块、对端读得慢）期间到的实时事件排在补发后面：序号连续，不漏不重", async () => {
		const { bus, port } = await start();
		const big = "x".repeat(8 * 1024);
		for (let n = 1; n <= 3000; n++) bus.emit(SESSION, 1, message(`${n}:${big}`)); // 24 MB
		const reader = await open(port, `${bus.epoch}:0`, true);
		// 对端不读：补发写不完，实时事件先排着。
		await new Promise((resolve) => setTimeout(resolve, 100));
		for (let n = 3001; n <= 3010; n++) bus.emit(SESSION, 1, message(`${n}`));
		reader.resume();
		await eventually(() => expect(reader.seqs.length).toBe(3010), 30_000);
		expect(reader.seqs).toEqual(Array.from({ length: 3010 }, (_, i) => i + 1));
		// 补发完之后是实时的。
		bus.emit(SESSION, 1, message("3011"));
		await eventually(() => expect(reader.seqs.at(-1)).toBe(3011));
	}, 60_000);

	it("对端读得太慢：没被读走的字节超过上限就断开这条连接（带 after 重连，持久的事件补发，序号连续、没有缺口）", async () => {
		const { bus, port, logs } = await start({ maxBacklogBytes: 1024 * 1024 });
		const slow = await open(port, undefined, true);
		const big = "y".repeat(64 * 1024);
		// 实时事件一直写，对端不读：写出去没被读走的字节超过上限，连接被断开。
		let sent = 0;
		for (; sent < 400 && bus.subscribers > 0; sent++) {
			bus.emit(SESSION, 1, message(`${sent}:${big}`));
			if (sent % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		// 以助手服务这一侧为准：读得慢（暂停）的对端自己看不到连接断了（它的 socket 不读，收不到 RST）。
		await eventually(() => expect(bus.subscribers).toBe(0));
		expect(logs.join("\n")).toContain("读得太慢");
		// 断开之后助手服务照常产生事件；对端带着最后收到的位置重连，补回其余的。
		const got = slow.seqs.at(-1) ?? 0;
		for (let n = 0; n < 3; n++) bus.emit(SESSION, 1, message(`之后的 ${n}`));
		const total = bus.buffered;
		const again = await open(port, `${bus.epoch}:${got}`);
		await eventually(() => expect(again.seqs.length).toBe(total - got));
		expect(again.hello).toMatchObject({ gap: false });
		expect(again.seqs).toEqual(Array.from({ length: total - got }, (_, i) => got + i + 1));
	});

	it("补发期间排着的实时事件加起来超过上限：断开；读得正常的不受影响", async () => {
		const { bus, port, logs } = await start({ maxBacklogBytes: 512 * 1024 });
		// 补发要比内核给这条连接的缓冲大得多（几十 MB），对端不读时补发才停在中间、实时事件才排在 `pending` 里。
		const big = "z".repeat(64 * 1024);
		for (let n = 1; n <= 600; n++) bus.emit(SESSION, 1, message(`${n}:${big}`));
		await open(port, `${bus.epoch}:0`, true);
		const fine = await open(port);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.subscribers).toBe(2);
		for (let n = 601; n <= 640 && bus.subscribers === 2; n++) {
			bus.emit(SESSION, 1, message(`${n}:${big}`));
			// 让读得正常的那条连接有机会读走（一口气写 2.6 MB 它也会被当成读得太慢）。
			await new Promise((resolve) => setImmediate(resolve));
		}
		await eventually(() => expect(bus.subscribers).toBe(1));
		expect(logs.join("\n")).toContain("读得太慢");
		// 另一条读得正常的连接照常收到。
		await eventually(() => expect(fine.seqs.length).toBeGreaterThan(0));
		expect(fine.closed).toBe(false);
	}, 30_000);
});
