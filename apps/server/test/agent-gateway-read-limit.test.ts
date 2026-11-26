// Agent 网关收一条消息的大小上限（#674，`readMaxBytes`）：单条消息超过上限时，这一台 Agent 的流以 `resource_exhausted` 结束，
// 日志里写出是哪台 Agent（握手之前是来源地址）、声明的大小和上限，没有消息的任何内容；别的 Agent 的流不受影响；
// 库读到 5 字节的长度前缀、发现声明的长度超过上限就拒绝，不先把整条收齐（内存不随这一条增长）；上限以内的照常收，
// 含还没升级的 Agent 能发出的最大的一批（默认上限 80 MiB，见 `AGENT_MESSAGE_MAX_BYTES`）；正好等于上限的一条照收、
// 多一个字节的被拒；网关不接受压缩（压缩的消息不解压、以 unimplemented 拒绝）；每条连接上同时能开的流数有上限；
// 握手之前超限的日志按来源地址限频。
import { connect as connectHttp2 } from "node:http2";
import { Writable } from "node:stream";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { AgentMessageSchema } from "@sfly/proto";
import type { LogLineView } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
	AGENT_MAX_CONCURRENT_STREAMS,
	AGENT_MESSAGE_MAX_BYTES,
	startAgentGateway,
} from "../src/gateway/agent-gateway.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { ErrorKind, FakeAgent, TaskStatus } from "./support/fake-agent.js";
import { benchDocument, publishBench } from "./support/focus-items.js";
import { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 测试里用小的上限（256 KiB），不用真的发 80 MiB。 */
const LIMIT = 256 * 1024;
/** 消息里的标记：日志里不该出现它（日志只写哪台 Agent、大小和上限）。 */
const PAYLOAD = "SECRET-PAYLOAD-";

/** gRPC 的一条消息：1 字节标志、4 字节长度、内容；declared 可以和内容的长度不一样。 */
function frame(flags: number, payload: Buffer, declared = payload.length): Buffer {
	const bytes = Buffer.alloc(5 + payload.length);
	bytes.writeUInt8(flags, 0);
	bytes.writeUInt32BE(declared, 1);
	payload.copy(bytes, 5);
	return bytes;
}

/**
 * 真的 h2c 客户端开一条 Session 流（不经过连接库）：grpc-status 出现在响应头或 trailer 里都算。
 * 不设 `grpc-encoding` 时是不压缩的流。
 */
function rawStream(url: string, headers: Record<string, string> = {}) {
	const session = connectHttp2(new URL(url));
	session.on("error", () => {});
	const request = session.request({
		":method": "POST",
		":path": "/sfly.agent.v1.AgentGateway/Session",
		"content-type": "application/grpc",
		te: "trailers",
		...headers,
	});
	request.on("error", () => {});
	const status = new Promise<string | undefined>((resolve) => {
		const done = (received: Record<string, unknown>) => {
			if (received["grpc-status"] !== undefined) resolve(String(received["grpc-status"]));
		};
		request.on("response", done);
		request.on("trailers", done);
		request.on("close", () => resolve(undefined));
	});
	return {
		request,
		session,
		status: () =>
			Promise.race([
				status,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("5 秒内没有收到 grpc-status")), 5_000),
				),
			]),
		close() {
			request.close();
			session.close();
		},
	};
}

/** 编码之后正好 target 字节的一条结果（不存在的任务：控制面忽略，照常回 Ack）。 */
function resultOfSize(target: number, taskId: string) {
	let pad = target - 64;
	for (let i = 0; i < 10; i++) {
		const value = {
			taskId,
			attempt: 1,
			status: TaskStatus.FAILED,
			error: { kind: ErrorKind.NODE_ERROR, message: "p".repeat(pad) },
		};
		const size = toBinary(
			AgentMessageSchema,
			create(AgentMessageSchema, { body: { case: "result", value } }),
		).length;
		if (size === target) return value;
		pad += target - size;
	}
	throw new Error(`凑不出 ${target} 字节的一条`);
}

/** 握手之前超限的日志限频的窗口（`src/control-plane.ts`）。 */
const TOO_LARGE_LOG_WINDOW_MS = 10_000;

describe("Agent 网关：单条消息的大小上限", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	let errors: MockInstance<typeof console.error>;
	const agents: FakeAgent[] = [];

	/** 控制面写到标准错误的全部内容。 */
	const log = () => errors.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
	const quiet = new Writable({ write: (_chunk, _encoding, done) => done() });

	beforeEach(async () => {
		errors = vi.spyOn(console, "error").mockImplementation(() => {});
		clock = new ManualClock();
		cp = await startTestControlPlane({
			clock,
			agentMessageMaxBytes: LIMIT,
			logger: { stream: quiet },
		});
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.disconnect()));
		await cp.close();
		errors.mockRestore();
	});

	/** 日志里「超过上限」的行。 */
	const tooLargeLines = () =>
		log()
			.split("\n")
			.filter((l) => l.includes("超过上限"));

	const connect = async (name: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, slots: 4 });
		agents.push(agent);
		return agent;
	};

	it("超过上限的一条消息：这一台 Agent 的流以 resource_exhausted 结束，日志写出是哪台 Agent、声明的大小和上限、没有消息的内容；别的 Agent 的连接照常", async () => {
		const bad = await connect("agent-bad");
		const good = await connect("agent-good");
		// ~450 KB 的一条消息（大于 256 KiB 的上限）。
		bad.send({
			case: "notification",
			value: {
				taskId: "t-1",
				attempt: 1,
				eventJson: JSON.stringify({ type: "notify", text: PAYLOAD.repeat(30_000) }),
			},
		});

		await expect(bad.next(undefined, { timeoutMs: 10_000 })).rejects.toMatchObject({
			code: Code.ResourceExhausted,
		});
		expect(bad.ended).toBe(true);

		await eventually(() => expect(log()).toContain("超过上限"));
		const line = tooLargeLines()[0] as string;
		const match =
			/^sfly: Agent agent-bad发来的消息超过上限（声明 (\d+) 字节，上限 (\d+) 字节），关闭这条连接$/.exec(
				line,
			);
		expect(match, line).not.toBeNull();
		expect(Number(match?.[1])).toBeGreaterThan(450_000);
		expect(Number(match?.[2])).toBe(LIMIT);
		expect(log()).not.toContain(PAYLOAD);

		// 别的 Agent 的流照常：心跳处理完回了 Ack。
		await good.heartbeat();
		expect(good.ended).toBe(false);
	});

	it("握手之前的第一条消息就超过上限：还不知道是哪台 Agent，日志写来源地址；这条流以 resource_exhausted 结束", async () => {
		const agent = FakeAgent.connectRaw(cp.grpcUrl, (raw) =>
			raw.send({
				case: "hello",
				value: { name: "agent-big-hello", token: PAYLOAD.repeat(30_000) },
			}),
		);
		await expect(agent).rejects.toMatchObject({ code: Code.ResourceExhausted });

		await eventually(() => expect(log()).toContain("握手之前"));
		const line = tooLargeLines()[0] as string;
		expect(line).toMatch(
			/^sfly: 来源地址 \S+ 的连接（握手之前）发来的消息超过上限（声明 \d+ 字节，上限 262144 字节），关闭这条连接$/,
		);
		expect(line).not.toContain("agent-big-hello");
		expect(log()).not.toContain(PAYLOAD);
	});

	it("声明的长度超过上限、只发出头几个字节就被拒：不是把整条收齐了才拒，内存不随它增长", async () => {
		const url = new URL(cp.grpcUrl);
		const session = connectHttp2(url);
		session.on("error", () => {});
		const request = session.request({
			":method": "POST",
			":path": "/sfly.agent.v1.AgentGateway/Session",
			"content-type": "application/grpc",
			te: "trailers",
		});
		// gRPC 的消息前缀：1 字节标志、4 字节长度。声明 1 GB，只发 10 个字节的内容，请求也不结束。
		const prefix = Buffer.alloc(5);
		prefix.writeUInt32BE(1_000_000_000, 1);
		request.write(prefix);
		request.write(Buffer.alloc(10));
		try {
			const status = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("2 秒内没有收到 grpc-status：控制面在等整条消息")),
					2_000,
				);
				const done = (headers: Record<string, unknown>) => {
					if (headers["grpc-status"] === undefined) return;
					clearTimeout(timer);
					resolve(String(headers["grpc-status"]));
				};
				request.on("response", done);
				request.on("trailers", done);
				request.on("error", reject);
			});
			expect(status).toBe(String(Code.ResourceExhausted));
		} finally {
			request.close();
			session.close();
		}
		await eventually(() => expect(log()).toContain("声明 1000000000 字节，上限 262144 字节"));
	});

	it("上限以内的消息照常收：一批接近上限的日志（几行加起来 192 KiB）写进了任务日志，流没有断", async () => {
		const api = new ApiClient(cp);
		await publishBench(cp);
		const agent = await connect("agent-a");
		await api.triggerOk(await api.orchestrationWith(benchDocument([["load", "load"]])));
		const task = await agent.nextAssign();
		const text = "x".repeat(64 * 1024);

		agent.logs(task, [
			[1, text],
			[2, text],
			[3, text],
		]);

		await eventually(async () => {
			const page = await api.getJson<{ lines: LogLineView[] }>(`/tasks/${task.taskId}/logs`);
			expect(page.lines).toHaveLength(3);
		});
		await agent.heartbeat();
		expect(agent.ended).toBe(false);
	});

	it("上限必须是 1 到 4294967295 的整数（长度前缀是 4 个字节）：这个范围的两端照常启动", async () => {
		const start = (readMaxBytes: number) =>
			startAgentGateway({
				host: "127.0.0.1",
				port: 0,
				hub: undefined as never,
				authenticator: undefined as never,
				readMaxBytes,
			});
		for (const bad of [0, -1, 1.5, 2 ** 32, Number.NaN]) {
			await expect(start(bad)).rejects.toThrow(/readMaxBytes/);
		}
		for (const ok of [1, 4294967295]) {
			await (await start(ok)).close();
		}
	});

	it("正好等于上限的一条照常收（回 Ack、流不断），多一个字节的被拒", async () => {
		const agent = await connect("agent-edge");
		const ack = await agent.report(resultOfSize(LIMIT, "edge-exact"), { timeoutMs: 10_000 });
		expect(ack.taskId).toBe("edge-exact");
		expect(agent.ended).toBe(false);
		expect(tooLargeLines()).toHaveLength(0);

		agent.send({ case: "result", value: resultOfSize(LIMIT + 1, "edge-over") });
		await expect(agent.next(undefined, { timeoutMs: 10_000 })).rejects.toMatchObject({
			code: Code.ResourceExhausted,
		});
		await eventually(() =>
			expect(tooLargeLines()).toEqual([
				`sfly: Agent agent-edge发来的消息超过上限（声明 ${LIMIT + 1} 字节，上限 ${LIMIT} 字节），关闭这条连接`,
			]),
		);
	});

	describe("不接受压缩", () => {
		// 解压之后超过上限的一条，线上只有几十到几千字节：压缩要是被接受，控制面就得真的解压、把内存写到接近上限
		// （握手之前就能做）。网关不接受压缩：带 grpc-encoding 的请求以 unimplemented 拒绝，不解压，也就没有「超过上限」的日志。
		it.each([
			["gzip", (plain: Buffer) => gzipSync(plain, { level: 9 })],
			["br", (plain: Buffer) => brotliCompressSync(plain)],
		])("%s：线上很小、解压之后远超上限的一条（握手之前）被拒 unimplemented，没有解压", async (encoding, compress) => {
			const compressed = compress(Buffer.alloc(8 * LIMIT));
			expect(compressed.length).toBeLessThan(LIMIT / 4);
			const raw = rawStream(cp.grpcUrl, { "grpc-encoding": encoding });
			raw.request.write(frame(1, compressed));
			try {
				expect(await raw.status()).toBe(String(Code.Unimplemented));
			} finally {
				raw.close();
			}
			expect(tooLargeLines()).toHaveLength(0);
		});

		it("握手之后：一条流里带压缩标志的消息也不解压（这条流以错误结束，不是 resource_exhausted，没有「超过上限」的日志）", async () => {
			const raw = rawStream(cp.grpcUrl);
			const hello = toBinary(
				AgentMessageSchema,
				create(AgentMessageSchema, {
					body: { case: "hello", value: { name: "agent-compressed", slots: 1 } },
				}),
			);
			raw.request.write(frame(0, Buffer.from(hello)));
			// 握手之后：压缩标志置位、没有声明 grpc-encoding 的消息（线上很小，解压出来远超上限）
			raw.request.write(frame(1, gzipSync(Buffer.alloc(8 * LIMIT), { level: 9 })));
			try {
				const status = await raw.status();
				expect(status).not.toBe("0");
				expect(status).not.toBe(String(Code.ResourceExhausted));
			} finally {
				raw.close();
			}
			expect(tooLargeLines()).toHaveLength(0);
		});
	});

	it("每条连接上同时能开的流数有上限（服务端 SETTINGS）", async () => {
		const raw = rawStream(cp.grpcUrl);
		try {
			const settings = await new Promise<{ maxConcurrentStreams?: number }>((resolve) => {
				raw.session.once("remoteSettings", resolve);
			});
			expect(settings.maxConcurrentStreams).toBe(AGENT_MAX_CONCURRENT_STREAMS);
			expect(AGENT_MAX_CONCURRENT_STREAMS).toBeLessThanOrEqual(8);
		} finally {
			raw.close();
		}
	});

	/** 在一条（共用的）连接上开一条流，只发 5 字节的长度前缀（声明比上限多 1，请求不用结束）；流结束时返回。 */
	const overLimitStream = (session: ReturnType<typeof connectHttp2>) =>
		new Promise<void>((resolve) => {
			const request = session.request({
				":method": "POST",
				":path": "/sfly.agent.v1.AgentGateway/Session",
				"content-type": "application/grpc",
				te: "trailers",
			});
			request.on("error", () => {});
			request.on("close", () => resolve());
			request.end(frame(0, Buffer.alloc(0), LIMIT + 1));
		});

	it("握手之前超限的日志按来源地址限频：一个窗口里只写一行，下一个窗口的第一行带上省掉的次数", async () => {
		const session = connectHttp2(new URL(cp.grpcUrl));
		session.on("error", () => {});
		try {
			// 一条一条开：每一条都到了处理流的地方（同时开的流超过 SETTINGS 里的上限时，多出的在 HTTP/2 一层就被拒，到不了这里）
			for (let i = 0; i < 20; i++) await overLimitStream(session);
			expect(tooLargeLines()).toHaveLength(1);
			// 窗口还没过（差 1 毫秒）：再来的也不写
			clock.advance(TOO_LARGE_LOG_WINDOW_MS - 1);
			await overLimitStream(session);
			expect(tooLargeLines()).toHaveLength(1);

			clock.advance(1);
			await overLimitStream(session);
			expect(tooLargeLines()).toHaveLength(2);
			expect(tooLargeLines()[1]).toBe(
				`sfly: 来源地址 ${tooLargeLines()[0]?.match(/来源地址 (\S+) /)?.[1]} 的连接（握手之前）发来的消息超过上限（声明 ${LIMIT + 1} 字节，上限 ${LIMIT} 字节），关闭这条连接（这个来源地址之前还有 20 次没有写）`,
			);
		} finally {
			session.close();
		}
	});

	it("没有认证的连接一口气开 300 条流各发一个超限的长度前缀：控制面只写一行日志", async () => {
		const session = connectHttp2(new URL(cp.grpcUrl));
		session.on("error", () => {});
		try {
			await Promise.all(Array.from({ length: 300 }, () => overLimitStream(session)));
			await eventually(() => expect(tooLargeLines()).toHaveLength(1));
			expect(tooLargeLines()[0]).toMatch(
				/^sfly: 来源地址 \S+ 的连接（握手之前）发来的消息超过上限（声明 262145 字节，上限 262144 字节），关闭这条连接$/,
			);
		} finally {
			session.close();
		}
	});

	it("握手之后超限的日志不限频：每台 Agent 每次一行", async () => {
		const a = await connect("agent-first");
		const b = await connect("agent-second");
		for (const agent of [a, b]) {
			agent.send({
				case: "notification",
				value: { taskId: "t", attempt: 1, eventJson: "N".repeat(LIMIT + 1024) },
			});
			await expect(agent.next(undefined, { timeoutMs: 10_000 })).rejects.toMatchObject({
				code: Code.ResourceExhausted,
			});
		}
		await eventually(() => expect(tooLargeLines()).toHaveLength(2));
	});
});

describe("Agent 网关：默认上限", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent | undefined;
	beforeEach(async () => {
		cp = await startTestControlPlane();
	});
	afterEach(async () => {
		await agent?.disconnect();
		agent = undefined;
		await cp.close();
	});

	it("默认上限是 80 MiB，比还没升级的 Agent 能发出的最大的一批高：1000 行、每行 64 KiB 的一批日志（62.5 MiB）照常接收，流没有断", async () => {
		expect(AGENT_MESSAGE_MAX_BYTES).toBe(80 * 1024 * 1024);
		const api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
		await api.triggerOk(await api.orchestrationWith(benchDocument([["load", "load"]])));
		const task = await agent.nextAssign();
		const text = "x".repeat(64 * 1024);

		agent.logs(
			task,
			Array.from({ length: 1000 }, (_, i): [number, string] => [i + 1, text]),
		);

		// 控制面收下并处理了这一批（日志有每个任务的上限，存下多少不是这里要查的）：流没有断，之后的心跳照常处理，
		// 任务日志里至少有了行。
		await agent.heartbeat();
		expect(agent.ended).toBe(false);
		await eventually(async () => {
			const page = await api.getJson<{ lines: LogLineView[] }>(`/tasks/${task.taskId}/logs`);
			expect(page.lines.length).toBeGreaterThan(0);
		}, 30_000);
	}, 120_000);
});
