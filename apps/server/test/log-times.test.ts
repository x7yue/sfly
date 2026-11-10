// 切入点 A：日志和进度同时记 Agent 时间和控制面时间（#173，ADR 0018）。假 Agent 经 gRPC 上报任意的 Agent 时间和
// 单调时钟读数，控制面用手动时钟；通过 HTTP（分页、下载、运行视图）和 SSE（日志增量、进度）观察。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logsApi, runsApi } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import {
	type AssignedTask,
	agentClock,
	FakeAgent,
	LogLevel,
	LogSource,
} from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

/** 控制面时间的起点；Agent 时间比它快 613 天。 */
const T0 = Date.parse("2025-03-07T08:00:00.000Z");
const AGENT_T0 = Date.parse("2026-11-10T08:00:00.000Z");
/** Agent 连上时的单调时钟读数。 */
const M0 = 5_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("日志和进度的两种时间", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const streams: SseClient[] = [];

	/** 新版本 Agent：Hello 带 Agent 时间和单调时钟读数。 */
	const connect = async (agentTime = AGENT_T0, monotonicMs = M0) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			...agentClock(agentTime, monotonicMs),
		});
		agents.push(agent);
		return agent;
	};
	const connectOld = async () => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(agent);
		return agent;
	};
	const start = async (agent: FakeAgent): Promise<{ runId: string; task: AssignedTask }> => {
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		return { runId, task: await agent.nextAssign() };
	};
	const page = async (taskId: string) => {
		const res = await cp.fetch(`/tasks/${taskId}/logs?limit=1000`);
		expect(res.status).toBe(200);
		return logsApi.page.response.parse(await res.json());
	};
	/** 等日志文件里写到第 n 行，返回 [序号, 控制面时间, Agent 时间]。 */
	const times = async (taskId: string, n: number) => {
		await eventually(async () => expect((await page(taskId)).last_seq).toBe(n));
		return (await page(taskId)).lines.map((l) => [l.seq, l.time, l.agent_time]);
	};
	const line = (seq: number, agentTimeMs: number, monotonicMs: number, text = `第 ${seq} 行`) => ({
		seq: BigInt(seq),
		timeUnixMs: BigInt(agentTimeMs),
		monotonicMs: BigInt(monotonicMs),
		source: LogSource.STDOUT,
		level: LogLevel.INFO,
		text,
	});
	const progressOf = async (runId: string) => {
		const run = runsApi.get.response.parse(await (await cp.fetch(`/runs/${runId}`)).json());
		return run.chains[0]?.nodes.find((n) => n.node_id === "a")?.attempts[0]?.progress;
	};

	beforeEach(async () => {
		clock = new ManualClock(iso(T0));
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
	});
	afterEach(async () => {
		for (const s of streams.splice(0)) s.close();
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("日志", () => {
		it("Agent 时间快 613 天、是 1970 年、中途倒退时，每行的两种时间都按原样保存；控制面时间按单调时钟读数折算，顺序按序号", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			// 收到这批日志时控制面已经过了 10 秒：控制面时间取的是发生的时刻，不是收到的时刻。
			clock.advance(10_000);
			agent.logs(task, [
				line(1, AGENT_T0 + 1_000, M0 + 1_000),
				// Agent 时间被改到 1970 年。
				line(2, 86_400_000, M0 + 2_000),
				// 再改到 2099 年。
				line(3, Date.parse("2099-12-31T23:59:59.000Z"), M0 + 3_000),
				// 倒退回比第一行还早。
				line(4, AGENT_T0 - 3_600_000, M0 + 4_000),
			]);

			expect(await times(task.taskId, 4)).toEqual([
				[1, iso(T0 + 1_000), iso(AGENT_T0 + 1_000)],
				[2, iso(T0 + 2_000), "1970-01-02T00:00:00.000Z"],
				[3, iso(T0 + 3_000), "2099-12-31T23:59:59.000Z"],
				[4, iso(T0 + 4_000), iso(AGENT_T0 - 3_600_000)],
			]);
		});

		it("Agent 时间超出能记录的范围（公元 100 年到 9999 年）时，日志行照常接收，Agent 时间记成边界值", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			agent.logs(task, [
				line(1, Date.parse("9999-12-31T23:59:59.999Z") + 1, M0 + 1_000),
				line(2, -9e15, M0 + 2_000),
			]);

			expect(await times(task.taskId, 2)).toEqual([
				[1, iso(T0 + 1_000), "9999-12-31T23:59:59.999Z"],
				[2, iso(T0 + 2_000), "0100-01-01T00:00:00.000Z"],
			]);
		});

		it("SSE 的日志增量和订阅时补发的尾部都带两种时间", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			agent.logs(task, [line(1, AGENT_T0 + 1_000, M0 + 1_000, "已有")]);
			await times(task.taskId, 1);

			const sse = await SseClient.open(cp, `/tasks/${task.taskId}/logs/events`);
			streams.push(sse);
			const tail = logsApi.events.events.logs.parse((await sse.next("logs")).data);
			expect(tail.lines).toEqual([
				{
					seq: 1,
					time: iso(T0 + 1_000),
					agent_time: iso(AGENT_T0 + 1_000),
					source: "stdout",
					level: "info",
					text: "已有",
				},
			]);

			agent.logs(task, [line(2, AGENT_T0 - 5_000, M0 + 2_000, "新增")]);
			const live = logsApi.events.events.logs.parse((await sse.next("logs")).data);
			expect(live.lines).toEqual([
				{
					seq: 2,
					time: iso(T0 + 2_000),
					agent_time: iso(AGENT_T0 - 5_000),
					source: "stdout",
					level: "info",
					text: "新增",
				},
			]);
		});

		it("断线期间排队的日志重连后落在发生时的控制面时间，而不是重连的时刻", async () => {
			let agent = await connect();
			const { task } = await start(agent);
			agent.logs(task, [line(1, AGENT_T0 + 1_000, M0 + 1_000)]);
			await times(task.taskId, 1);

			// 断线 60 秒；期间 Agent 在第 20、40 秒各读到一行，Agent 时间在中途被往回改了一天。
			await agent.disconnect();
			clock.advance(60_000);
			agent = await connect(AGENT_T0 - 86_400_000 + 60_000, M0 + 60_000);
			agent.logs(task, [
				line(2, AGENT_T0 + 20_000, M0 + 20_000),
				line(3, AGENT_T0 - 86_400_000 + 40_000, M0 + 40_000),
				line(4, AGENT_T0 - 86_400_000 + 61_000, M0 + 61_000),
			]);

			expect(await times(task.taskId, 4)).toEqual([
				[1, iso(T0 + 1_000), iso(AGENT_T0 + 1_000)],
				[2, iso(T0 + 20_000), iso(AGENT_T0 + 20_000)],
				[3, iso(T0 + 40_000), iso(AGENT_T0 - 86_400_000 + 40_000)],
				[4, iso(T0 + 61_000), iso(AGENT_T0 - 86_400_000 + 61_000)],
			]);
		});

		it("旧版本 Agent 不带单调时钟读数：控制面时间取收到的时刻，Agent 时间仍取原字段，不做范围检查", async () => {
			const agent = await connectOld();
			const { task } = await start(agent);
			clock.advance(7_000);
			agent.logs(task, [
				{ ...line(1, AGENT_T0, 0), monotonicMs: undefined },
				{ ...line(2, 1_000, 0), monotonicMs: undefined },
			]);
			await times(task.taskId, 2);
			clock.advance(3_000);
			agent.logs(task, [{ ...line(3, AGENT_T0 - 1, 0), monotonicMs: undefined }]);

			expect(await times(task.taskId, 3)).toEqual([
				[1, iso(T0 + 7_000), iso(AGENT_T0)],
				[2, iso(T0 + 7_000), "1970-01-01T00:00:01.000Z"],
				[3, iso(T0 + 10_000), iso(AGENT_T0 - 1)],
			]);
		});

		it("新版本 Agent 的某一行没带读数（0）时，这一行的控制面时间取收到的时刻", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			clock.advance(9_000);
			agent.logs(task, [line(1, AGENT_T0, 0)]);

			expect(await times(task.taskId, 1)).toEqual([[1, iso(T0 + 9_000), iso(AGENT_T0)]]);
		});

		describe("旧日志文件（每行只有一个时间）", () => {
			const OLD = [
				{ seq: 1, time: "2024-05-01T00:00:01.000Z", source: "stdout", level: "info", text: "旧 1" },
				{ seq: 2, time: "2024-05-01T00:00:02.000Z", source: "sdk", level: "warn", text: "旧 2" },
			];
			/** 在任务的日志文件里放两行升级之前写入的日志。 */
			const writeOld = async (runId: string, taskId: string) => {
				const dir = join(cp.dataDir, "logs", runId);
				await mkdir(dir, { recursive: true });
				await writeFile(
					join(dir, `${taskId}.jsonl`),
					OLD.map((l) => `${JSON.stringify(l)}\n`).join(""),
				);
			};

			it("读出时只有 Agent 时间，控制面时间未记录；之后写入的行两种时间都有", async () => {
				const agent = await connect();
				const { runId, task } = await start(agent);
				await writeOld(runId, task.taskId);
				agent.logs(task, [line(3, AGENT_T0 + 3_000, M0 + 3_000)]);

				expect(await times(task.taskId, 3)).toEqual([
					[1, null, "2024-05-01T00:00:01.000Z"],
					[2, null, "2024-05-01T00:00:02.000Z"],
					[3, iso(T0 + 3_000), iso(AGENT_T0 + 3_000)],
				]);
				// 翻页的字节偏移仍是文件里的位置。
				const { lines, size } = await page(task.taskId);
				expect(lines[0]?.offset).toBe(0);
				expect(lines[1]?.offset).toBe(Buffer.byteLength(`${JSON.stringify(OLD[0])}\n`));
				expect(lines[2]?.offset).toBe(
					Buffer.byteLength(OLD.map((l) => `${JSON.stringify(l)}\n`).join("")),
				);
				expect(size).toBeGreaterThan(lines[2]?.offset ?? 0);

				const sse = await SseClient.open(cp, `/tasks/${task.taskId}/logs/events`);
				streams.push(sse);
				const tail = logsApi.events.events.logs.parse((await sse.next("logs")).data);
				expect(tail.lines.map((l) => [l.seq, l.time, l.agent_time])).toEqual([
					[1, null, "2024-05-01T00:00:01.000Z"],
					[2, null, "2024-05-01T00:00:02.000Z"],
					[3, iso(T0 + 3_000), iso(AGENT_T0 + 3_000)],
				]);
			});

			it("下载的每一行都同时带两种时间：旧行的控制面时间为 null", async () => {
				const agent = await connect();
				const { runId, task } = await start(agent);
				await writeOld(runId, task.taskId);
				agent.logs(task, [line(3, AGENT_T0 + 3_000, M0 + 3_000, "新 3")]);
				await times(task.taskId, 3);

				const res = await cp.fetch(`/tasks/${task.taskId}/logs/download`);
				expect(res.status).toBe(200);
				const text = await res.text();
				expect(text.endsWith("\n")).toBe(true);
				expect(
					text
						.trimEnd()
						.split("\n")
						.map((l) => JSON.parse(l)),
				).toEqual([
					{
						seq: 1,
						time: null,
						agent_time: "2024-05-01T00:00:01.000Z",
						source: "stdout",
						level: "info",
						text: "旧 1",
					},
					{
						seq: 2,
						time: null,
						agent_time: "2024-05-01T00:00:02.000Z",
						source: "sdk",
						level: "warn",
						text: "旧 2",
					},
					{
						seq: 3,
						time: iso(T0 + 3_000),
						agent_time: iso(AGENT_T0 + 3_000),
						source: "stdout",
						level: "info",
						text: "新 3",
					},
				]);
			});
		});

		it("下载：Agent 时间偏差很大、中途倒退时每行的两种时间都在", async () => {
			const agent = await connect();
			const { task } = await start(agent);
			agent.logs(task, [
				line(1, AGENT_T0 + 1_000, M0 + 1_000),
				line(2, AGENT_T0 - 86_400_000, M0 + 2_000),
			]);
			await times(task.taskId, 2);

			const res = await cp.fetch(`/tasks/${task.taskId}/logs/download`);
			const rows = (await res.text())
				.trimEnd()
				.split("\n")
				.map((l) => JSON.parse(l) as { seq: number; time: string; agent_time: string });
			expect(rows.map((r) => [r.seq, r.time, r.agent_time])).toEqual([
				[1, iso(T0 + 1_000), iso(AGENT_T0 + 1_000)],
				[2, iso(T0 + 2_000), iso(AGENT_T0 - 86_400_000)],
			]);
		});
	});

	describe("进度", () => {
		const progress = (agent: FakeAgent, task: AssignedTask, current: number, init: object) =>
			agent.send({
				case: "progress",
				value: { taskId: task.taskId, attempt: task.attempt, current, message: "", ...init },
			});

		it("最新进度同时保存两种时间：运行视图和 SSE 都带，Agent 时间倒退也照样接收", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			const sse = await SseClient.open(cp, `/runs/${runId}/events`);
			streams.push(sse);
			await sse.next("run");
			clock.advance(10_000);

			progress(agent, task, 1, {
				timeUnixMs: BigInt(AGENT_T0 + 2_000),
				monotonicMs: BigInt(M0 + 2_000),
			});
			const first = runsApi.events.events.progress.parse((await sse.next("progress")).data);
			expect(first.progress).toEqual({
				current: 1,
				total: null,
				message: "",
				time: iso(T0 + 2_000),
				agent_time: iso(AGENT_T0 + 2_000),
			});

			// Agent 时间被改回 1970 年。
			progress(agent, task, 2, { timeUnixMs: 5_000n, monotonicMs: BigInt(M0 + 3_000) });
			const second = runsApi.events.events.progress.parse((await sse.next("progress")).data);
			expect(second.progress).toMatchObject({
				current: 2,
				time: iso(T0 + 3_000),
				agent_time: "1970-01-01T00:00:05.000Z",
			});
			expect(await progressOf(runId)).toEqual(second.progress);
		});

		it("旧版本 Agent 不带单调时钟读数：控制面时间取收到的时刻", async () => {
			const agent = await connectOld();
			const { runId, task } = await start(agent);
			clock.advance(4_000);
			progress(agent, task, 1, { timeUnixMs: BigInt(AGENT_T0) });

			await eventually(async () =>
				expect(await progressOf(runId)).toMatchObject({
					time: iso(T0 + 4_000),
					agent_time: iso(AGENT_T0),
				}),
			);
		});

		it("升级之前保存的进度只有一个时间：读出时是 Agent 时间，控制面时间未记录", async () => {
			const agent = await connect();
			const { runId, task } = await start(agent);
			// 升级之前的格式。
			const old = { current: 3, total: 9, message: "旧", time: "2024-05-01T00:00:01.000Z" };
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query("UPDATE tasks SET progress = $1::jsonb WHERE id = $2", [
					JSON.stringify(old),
					task.taskId,
				]);
			} finally {
				await client.end();
			}

			expect(await progressOf(runId)).toEqual({
				current: 3,
				total: 9,
				message: "旧",
				time: null,
				agent_time: "2024-05-01T00:00:01.000Z",
			});
		});
	});
});
