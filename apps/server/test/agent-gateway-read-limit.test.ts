// Agent 网关收一条消息的大小上限（#674，`readMaxBytes`）：单条消息超过上限时，这一台 Agent 的流以 `resource_exhausted` 结束，
// 日志里写出是哪台 Agent（握手之前是来源地址）、声明的大小和上限，没有消息的任何内容；别的 Agent 的流不受影响；
// 库读到 5 字节的长度前缀、发现声明的长度超过上限就拒绝，不先把整条收齐（内存不随这一条增长）；上限以内的照常收，
// 含还没升级的 Agent 能发出的最大的一批（默认上限 80 MiB，见 `AGENT_MESSAGE_MAX_BYTES`）。
import { connect as connectHttp2 } from "node:http2";
import { Writable } from "node:stream";
import { Code } from "@connectrpc/connect";
import type { LogLineView } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { AGENT_MESSAGE_MAX_BYTES, startAgentGateway } from "../src/gateway/agent-gateway.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { benchDocument, publishBench } from "./support/focus-items.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 测试里用小的上限（256 KiB），不用真的发 80 MiB。 */
const LIMIT = 256 * 1024;
/** 消息里的标记：日志里不该出现它（日志只写哪台 Agent、大小和上限）。 */
const PAYLOAD = "SECRET-PAYLOAD-";

describe("Agent 网关：单条消息的大小上限", () => {
	let cp: TestControlPlane;
	let errors: MockInstance<typeof console.error>;
	const agents: FakeAgent[] = [];

	/** 控制面写到标准错误的全部内容。 */
	const log = () => errors.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
	const quiet = new Writable({ write: (_chunk, _encoding, done) => done() });

	beforeEach(async () => {
		errors = vi.spyOn(console, "error").mockImplementation(() => {});
		cp = await startTestControlPlane({
			agentMessageMaxBytes: LIMIT,
			logger: { stream: quiet },
		});
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.disconnect()));
		await cp.close();
		errors.mockRestore();
	});

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
		const line = log()
			.split("\n")
			.find((l) => l.includes("超过上限")) as string;
		const match =
			/Agent agent-bad发来的消息超过上限（声明 (\d+) 字节，上限 (\d+) 字节），关闭这条连接/.exec(
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
		const line = log()
			.split("\n")
			.find((l) => l.includes("握手之前")) as string;
		expect(line).toMatch(
			/来源地址 \S+ 的连接（握手之前）发来的消息超过上限（声明 \d+ 字节，上限 262144 字节），关闭这条连接/,
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

	it("上限必须是 1 到 4294967295 的整数（长度前缀是 4 个字节）", async () => {
		for (const bad of [0, -1, 1.5, 2 ** 32, Number.NaN]) {
			await expect(
				startAgentGateway({
					host: "127.0.0.1",
					port: 0,
					hub: undefined as never,
					authenticator: undefined as never,
					readMaxBytes: bad,
				}),
			).rejects.toThrow(/readMaxBytes/);
		}
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
