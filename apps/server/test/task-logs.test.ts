// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
// 切入点 A：任务日志与进度（#10）。假 Agent 经 gRPC 上报 LogBatch / Progress，
// 通过 HTTP（运行视图）和 SSE（/tasks/:id/logs/events、/runs/:id/events）观察。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type RunView } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface LogLine {
	seq: number;
	time: string;
	source: string;
	level: string;
	text: string;
}

interface LogsEvent {
	task_id: string;
	lines: LogLine[];
	/** 第一行在日志文件中的字节偏移。 */
	offset: number;
}

interface ProgressView {
	current: number;
	total: number | null;
	message: string;
	time: string;
}

const MASK = "******";

function chain(params: Array<Record<string, unknown>> = []) {
	return {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params },
			{ id: "a", kind: "package", package: "stub", node: "echo" },
			{ id: "b", kind: "package", package: "stub", node: "echo" },
		],
		edges: [
			{ from: "entry", to: "a", kind: "chain" },
			{ from: "a", to: "b", kind: "chain" },
		],
		packages: { stub: "1.0.0" },
	};
}

describe("任务日志与进度", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const streams: SseClient[] = [];

	const connect = async (name = "agent-a") => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name });
		agents.push(agent);
		return agent;
	};
	const logStream = async (taskId: string) => {
		const sse = await SseClient.open(cp, `/tasks/${taskId}/logs/events`);
		streams.push(sse);
		return sse;
	};
	/** 触发一次运行，返回派发给 agent 的第一个任务。 */
	const start = async (
		agent: FakeAgent,
		params: Array<Record<string, unknown>> = [],
		values: Record<string, unknown> = {},
	): Promise<{ runId: string; task: AssignedTask }> => {
		const id = await api.orchestrationWith(chain(params));
		const runId = await api.triggerOk(id, values);
		return { runId, task: await agent.nextAssign() };
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
	});
	afterEach(async () => {
		for (const s of streams.splice(0)) s.close();
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("日志", () => {
		it("订阅时先收到已有的日志，之后实时推送新增行；每行带序号、时间、来源和级别", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			agent.logs(task, [
				{
					seq: 1n,
					timeUnixMs: BigInt(Date.UTC(2026, 0, 1, 0, 0, 3)),
					source: LogSource.SDK,
					level: LogLevel.WARN,
					text: "慢",
				},
				[2, "第二行"],
			]);

			const sse = await logStream(task.taskId);
			let event = (await sse.next<LogsEvent>("logs")).data;
			if (event.lines.length < 2) event = (await sse.next<LogsEvent>("logs")).data;
			expect(event.task_id).toBe(task.taskId);
			expect(event.offset).toBe(0);
			expect(event.lines).toEqual([
				{ seq: 1, time: "2026-01-01T00:00:03.000Z", source: "sdk", level: "warn", text: "慢" },
				{
					seq: 2,
					time: "2026-01-01T00:00:00.000Z",
					source: "stdout",
					level: "info",
					text: "第二行",
				},
			]);

			agent.logs(task, [
				{
					seq: 3n,
					timeUnixMs: BigInt(Date.UTC(2026, 0, 1, 0, 0, 4)),
					source: LogSource.STDERR,
					level: LogLevel.ERROR,
					text: "错误输出",
				},
			]);
			const live = await sse.next<LogsEvent>("logs");
			expect(live.data.lines).toEqual([
				{
					seq: 3,
					time: "2026-01-01T00:00:04.000Z",
					source: "stderr",
					level: "error",
					text: "错误输出",
				},
			]);
			expect(live.id).toBe("3");
			expect(live.data.offset).toBeGreaterThan(0);
		});

		it("日志追加写入每个任务自己的文件：控制面重启后仍能读到；重复的序号被丢弃", async () => {
			let agent = await connect();
			const { task } = await start(agent);
			agent.logs(task, [
				[1, "a1"],
				[2, "a2"],
			]);
			const first = await logStream(task.taskId);
			await waitForLines(first, 2);

			await cp.restart();
			agent = await connect();
			agent.logs(task, [
				[2, "重复"],
				[3, "a3"],
			]);
			const again = await logStream(task.taskId);
			const lines = await waitForLines(again, 3);
			expect(lines.map((l) => [l.seq, l.text])).toEqual([
				[1, "a1"],
				[2, "a2"],
				[3, "a3"],
			]);
		});

		it("只推送订阅的任务；重连时按 Last-Event-ID 只补发之后的行；任务不存在时 404", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			const sse = await logStream(task.taskId);
			expect((await sse.next<LogsEvent>("logs")).data.lines).toEqual([]);

			agent.logs({ taskId: "00000000-0000-0000-0000-000000000001", attempt: 1 }, [[1, "别人"]]);
			agent.logs(task, [
				[1, "x1"],
				[2, "x2"],
				[3, "x3"],
			]);
			expect((await sse.next<LogsEvent>("logs")).data.lines.map((l) => l.text)).toEqual([
				"x1",
				"x2",
				"x3",
			]);

			const resumed = await SseClient.open(cp, `/tasks/${task.taskId}/logs/events`, {
				"last-event-id": "2",
			});
			streams.push(resumed);
			expect((await resumed.next<LogsEvent>("logs")).data.lines.map((l) => l.seq)).toEqual([3]);

			const missing = await api.get("/tasks/00000000-0000-0000-0000-000000000000/logs/events");
			expect(missing.status).toBe(404);
			expect((await api.get("/tasks/nope/logs/events")).status).toBe(404);
		});

		it("其他 Agent 上报的日志被忽略", async () => {
			const agent = await connect();
			const other = await connect("agent-b");
			const { task } = await start(agent);
			other.logs(task, [[1, "冒充"]]);
			agent.logs(task, [[1, "本人"]]);

			const lines = await waitForLines(await logStream(task.taskId), 1);
			expect(lines.map((l) => l.text)).toEqual(["本人"]);
		});
	});

	describe("进度", () => {
		it("只保留最新值：运行视图的尝试里能读到，并通过运行的 SSE 推送", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			const sse = await SseClient.open(cp, `/runs/${runId}/events`);
			streams.push(sse);
			await sse.next("run");

			agent.progress(task, 1, 3, "建立连接");
			expect((await sse.next("progress")).data).toEqual({
				run_id: runId,
				chain_instance_id: expect.any(String),
				node_id: "a",
				task_id: task.taskId,
				progress: {
					current: 1,
					total: 3,
					message: "建立连接",
					time: "2026-01-01T00:00:01.000Z",
				},
			});
			agent.progress(task, 2.5);
			const latest = (await sse.next<{ progress: ProgressView }>("progress")).data.progress;
			expect(latest).toMatchObject({ current: 2.5, total: null, message: "" });

			const view = await api.run(runId);
			const attempt = view.chains[0]?.nodes.find((n) => n.node_id === "a")?.attempts[0];
			expect(attempt?.progress).toEqual(latest);
			const b = view.chains[0]?.nodes.find((n) => n.node_id === "b");
			expect(b?.attempts).toEqual([]);

			await agent.succeed(task);
			const done = (await sse.next<RunView>("run")).data;
			const kept = done.chains[0]?.nodes.find((n) => n.node_id === "a")?.attempts[0];
			expect(kept?.progress).toEqual(latest);
		});
	});

	describe("secret 参数打码", () => {
		it("secret 参数的值出现在日志中时被替换成掩码，日志文件里也不保存明文", async () => {
			const agent = await connect();
			const { task } = await start(
				agent,
				[
					{ name: "token", type: "string", secret: true },
					{ name: "pin", type: "number", secret: true },
					{ name: "user", type: "string" },
				],
				{ token: "s3cr3t-value", pin: 4242, user: "alice" },
			);
			agent.logs(task, [
				[1, "token=s3cr3t-value again s3cr3t-value"],
				[2, "pin 4242, user alice"],
			]);

			const lines = await waitForLines(await logStream(task.taskId), 2);
			expect(lines.map((l) => l.text)).toEqual([
				`token=${MASK} again ${MASK}`,
				`pin ${MASK}, user alice`,
			]);

			await cp.restart();
			const reread = await waitForLines(await logStream(task.taskId), 2);
			expect(reread.map((l) => l.text)).toEqual(lines.map((l) => l.text));
			const files = await readAllLogFiles(cp.dataDir);
			expect(files).not.toContain("s3cr3t-value");
			expect(files).toContain(MASK);
		});
	});
	describe("secret 值在运行视图里打码", () => {
		it("输入、输出、错误信息、参数里出现的 secret 值都被打码（按值匹配）", async () => {
			const agent = await connect();
			const { runId, task } = await start(
				agent,
				[{ name: "token", type: "string", secret: true }],
				{ token: "s3cr3t-value" },
			);
			await agent.succeed(task, { text: "got s3cr3t-value", nested: ["s3cr3t-value"] });
			await agent.fail(await agent.nextAssign(), "auth failed for s3cr3t-value");

			const run = await api.run(runId);
			expect(JSON.stringify(run)).not.toContain("s3cr3t-value");
			expect(run.params).toEqual({ token: MASK });
			const [a, b] = run.chains[0]?.nodes.slice(1) ?? [];
			expect(a?.outputs).toEqual({ text: `got ${MASK}`, nested: [MASK] });
			expect(b?.error).toEqual({ kind: "node_error", message: `auth failed for ${MASK}` });
		});

		it("secret 值经参数映射传进子流程（子流程参数没有声明 secret）时，子流程一侧同样打码", async () => {
			const agent = await connect();
			const id = await api.orchestrationWith({
				default_agent: "agent-a",
				nodes: [
					{
						id: "entry",
						kind: "entry",
						params: [{ name: "token", type: "string", secret: true }],
					},
					{ id: "x", kind: "async", params: { t: "${{ params.token }}" } },
					{ id: "sub", kind: "subflow_entry", params: [{ name: "t", type: "string" }] },
					{ id: "s1", kind: "package", package: "stub", node: "echo" },
				],
				edges: [
					{ from: "entry", to: "x", kind: "chain" },
					{ from: "x", to: "sub", kind: "dispatch" },
					{ from: "sub", to: "s1", kind: "chain" },
				],
				packages: { stub: "1.0.0" },
			});
			const runId = await api.triggerOk(id, { token: "hunter2" });
			const task = await agent.nextAssign();
			agent.logs(task, [[1, "t is hunter2"]]);
			const [line] = await waitForLines(await logStream(task.taskId), 1);
			expect(line?.text).toBe(`t is ${MASK}`);
			const run = await api.run(runId);
			expect(run.chains[1]?.params).toEqual({ t: MASK });
		});

		it("之后才创建的子流程实例声明的 secret 参数，也用于此前已经在写日志的任务", async () => {
			const agent = await connect();
			const id = await api.orchestrationWith({
				default_agent: "agent-a",
				nodes: [
					{ id: "entry", kind: "entry", params: [{ name: "user", type: "string" }] },
					{ id: "x1", kind: "async", params: {} },
					{ id: "subA", kind: "subflow_entry", params: [] },
					{ id: "sa", kind: "package", package: "stub", node: "echo" },
					{ id: "b", kind: "package", package: "stub", node: "echo" },
					{ id: "x2", kind: "async", params: { k: "${{ params.user }}" } },
					{
						id: "subB",
						kind: "subflow_entry",
						params: [{ name: "k", type: "string", secret: true }],
					},
				],
				edges: [
					{ from: "entry", to: "x1", kind: "chain" },
					{ from: "x1", to: "b", kind: "chain" },
					{ from: "b", to: "x2", kind: "chain" },
					{ from: "x1", to: "subA", kind: "dispatch" },
					{ from: "subA", to: "sa", kind: "chain" },
					{ from: "x2", to: "subB", kind: "dispatch" },
				],
				packages: { stub: "1.0.0" },
			});
			const runId = await api.triggerOk(id, { user: "alice" });
			const first = await agent.nextAssign();
			const second = await agent.nextAssign();
			const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
			agent.logs(sa, [[1, "user alice"]]);
			const sse = await logStream(sa.taskId);
			await waitForLines(sse, 1);
			// b 结束后 x2 创建 subB：alice 从此是 secret 值。
			await agent.succeed(b);
			await eventually(async () =>
				expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
			);
			agent.logs(sa, [[2, "user alice again"]]);
			// waitForLines 每次从空开始收集，这里只等新增的第 2 行。
			const [again] = await waitForLines(sse, 1);
			expect(again?.seq).toBe(2);
			expect(again?.text).toBe(`user ${MASK} again`);
		});
	});
});

/** 从一条日志流里收集行（按序号去重），直到至少有 n 行。 */
async function waitForLines(sse: SseClient, n: number): Promise<LogLine[]> {
	const bySeq = new Map<number, LogLine>();
	while (bySeq.size < n) {
		for (const line of (await sse.next<LogsEvent>("logs")).data.lines) bySeq.set(line.seq, line);
	}
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

async function readAllLogFiles(dataDir: string): Promise<string> {
	const { readdir, readFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const entries = await readdir(join(dataDir, "logs"), { recursive: true, withFileTypes: true });
	const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
	expect(files.length).toBeGreaterThan(0);
	return (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
}
