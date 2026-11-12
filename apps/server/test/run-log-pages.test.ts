// 切入点 A：按运行合并读取日志（#222、#223）。两台假 Agent 经 gRPC 上报日志（各自的 Agent 时间偏差不同），
// 通过 HTTP 读取整次运行合并后的日志：按控制面时间交错排列，每行带来源；用游标往前翻页、往后接续。
// 实时推送（#225）用 SSE 客户端从分页给出的起点接上，按 Last-Event-ID 续传。
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	compareRunLogKeys,
	encodeRunLogScope,
	logsApi,
	type RunLogLine,
	type RunLogPage,
	type RunLogScope,
	runLogKey,
	runsApi,
} from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { agentClock, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/**
 * 主链 entry → spawn → z（失败重试 1 次）→ a，spawn 派发子流程「回放」sub → s（在 agent-b 上执行）。
 * z 排在 a 前面：时间相同时按链上的顺序，而不是按节点 ID 的字母顺序。
 */
const DOC = orchestration(
	[
		[{ id: "entry", kind: "entry" }, spawn("spawn"), { ...echo("z"), retries: 1 }, echo("a")],
		[
			{ id: "sub", kind: "subflow_entry", name: "回放", params: [] },
			{ ...echo("s"), agent: "agent-b" },
		],
	],
	[["spawn", "sub"]],
);

const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** 两台 Agent 的 Agent 时间都与控制面不一致，而且方向相反：按 Agent 时间排序会把 agent-b 的行全排在前面。 */
const AGENTS = {
	"agent-a": { agentT0: T0 + 613 * DAY, m0: 5_000 },
	"agent-b": { agentT0: T0 - DAY, m0: 90_000 },
} as const;
type AgentName = keyof typeof AGENTS;

describe("按运行合并读取日志", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	beforeEach(() => {
		clock = new ManualClock(iso(T0));
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const setup = async (
		options: {
			logLimitBytes?: number;
			retentionDays?: number;
			logScanBytes?: number;
			doc?: typeof DOC;
		} = {},
	) => {
		const { doc = DOC, ...controlPlane } = options;
		cp = await startTestControlPlane({ clock, leaseMs: 30 * DAY, ...controlPlane });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		const connect = async (name: AgentName) => {
			const { agentT0, m0 } = AGENTS[name];
			const agent = await FakeAgent.connect(cp.grpcUrl, { name, ...agentClock(agentT0, m0) });
			agents.push(agent);
			return agent;
		};
		const a = await connect("agent-a");
		const b = await connect("agent-b");
		const runId = await api.triggerOk(await api.orchestrationWith(doc));
		return { a, b, runId };
	};

	/** 第 seq 行：Agent 在控制面时间 T0 + atMs 读到它（Agent 时间按这台 Agent 的偏差，单调时钟读数照实走）。 */
	const line = (
		agent: FakeAgent,
		seq: number,
		atMs: number,
		text: string,
		level = LogLevel.INFO,
	) => {
		const { agentT0, m0 } = AGENTS[agent.name as AgentName];
		return {
			seq: BigInt(seq),
			timeUnixMs: BigInt(agentT0 + atMs),
			monotonicMs: BigInt(m0 + atMs),
			source: LogSource.STDOUT,
			level,
			text,
		};
	};

	const page = async (runId: string, query = ""): Promise<RunLogPage> => {
		const res = await cp.fetch(`/runs/${runId}/logs${query ? `?${query}` : ""}`);
		expect(res.status, await res.clone().text()).toBe(200);
		return logsApi.runPage.response.parse(await res.json());
	};
	/** 等合并结果里有 n 行。 */
	const settled = async (runId: string, n: number) => {
		await eventually(async () => expect((await page(runId, "limit=1000")).lines).toHaveLength(n));
		return page(runId, "limit=1000");
	};
	const brief = (l: RunLogLine) => [l.node_id, l.attempt, l.seq, l.text];
	const query = (params: Record<string, string | number>) =>
		new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
	/** 从最新一页用 before 游标往前翻，直到读到开头；返回各页，从新到旧。extra 是每个请求都带的范围、级别参数。 */
	const pagesToStart = async (
		runId: string,
		limit: number,
		first?: RunLogPage,
		extra: Record<string, string> = {},
	) => {
		const pages = [first ?? (await page(runId, query({ limit, ...extra })))];
		for (let last = pages[0]; !last?.reached_start; last = pages.at(-1)) {
			if (!last || pages.length > 200) throw new Error("翻不到开头");
			pages.push(await page(runId, query({ limit, ...extra, before: last.before })));
		}
		return pages;
	};
	/** 各页（从新到旧）按时间先后拼起来。 */
	const joined = (pages: RunLogPage[]) => pages.toReversed().flatMap((p) => p.lines);
	/** 从 after 游标往后接续，直到读到末尾；返回读到的全部行。 */
	const linesAfter = async (
		runId: string,
		after: string,
		limit: number,
		extra: Record<string, string> = {},
	) => {
		const lines: RunLogLine[] = [];
		for (let cursor = after, n = 0; ; n++) {
			if (n > 200) throw new Error("接续不完");
			const next = await page(runId, query({ limit, ...extra, after: cursor }));
			lines.push(...next.lines);
			if (next.reached_end) return lines;
			expect(next.after, "没读到末尾时游标要往后走").not.toBe(cursor);
			cursor = next.after;
		}
	};
	/** 等这个任务自己的日志（按任务的接口）有 n 行：扫描量很小时合并结果一页读不完。 */
	const ownLines = (task: { taskId: string }, n: number) =>
		eventually(async () => {
			const own = logsApi.page.response.parse(
				await (await cp.fetch(`/tasks/${task.taskId}/logs`)).json(),
			);
			expect(own.lines).toHaveLength(n);
		});
	const taskOf = async (runId: string, nodeId: string, attempt: number) => {
		const run = runsApi.get.response.parse(await (await cp.fetch(`/runs/${runId}`)).json());
		for (const chain of run.chains) {
			const task = chain.nodes
				.find((n) => n.node_id === nodeId)
				?.attempts.find((t) => t.attempt === attempt);
			if (task) return { task, chain };
		}
		throw new Error(`${nodeId} 第 ${attempt} 次不在运行里`);
	};

	it("多台 Agent、主链与子流程并行、同一节点的每次尝试：按控制面时间交错排列，每行带来源；limit 取最新的几行", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(z1, [line(a, 1, 1_000, "z1 first"), line(a, 2, 3_000, "z1 second")]);
		b.logs(s, [
			line(b, 1, 2_000, "s first"),
			line(b, 2, 4_000, "s second"),
			line(b, 3, 6_000, "s third"),
		]);
		await a.fail(z1, "boom");
		const z2 = await a.nextAssign();
		a.logs(z2, [line(a, 1, 5_000, "z2 first"), line(a, 2, 7_000, "z2 second")]);

		const all = await settled(runId, 7);
		expect(all.lines.map(brief)).toEqual([
			["z", 1, 1, "z1 first"],
			["s", 1, 1, "s first"],
			["z", 1, 2, "z1 second"],
			["s", 1, 2, "s second"],
			["z", 2, 1, "z2 first"],
			["s", 1, 3, "s third"],
			["z", 2, 2, "z2 second"],
		]);
		const main = (await taskOf(runId, "z", 1)).chain.id;
		const sub = (await taskOf(runId, "s", 1)).chain.id;
		expect(all.lines[0]).toEqual({
			seq: 1,
			time: iso(T0 + 1_000),
			agent_time: iso(AGENTS["agent-a"].agentT0 + 1_000),
			source: "stdout",
			level: "info",
			text: "z1 first",
			task_id: z1.taskId,
			chain_instance_id: main,
			subflow: null,
			node_id: "z",
			attempt: 1,
			chain_depth: 0,
			chain_started_at: iso(T0),
			node_index: 2,
			task_started_at: iso(T0),
		});
		expect(all.lines[1]).toMatchObject({
			time: iso(T0 + 2_000),
			agent_time: iso(AGENTS["agent-b"].agentT0 + 2_000),
			task_id: s.taskId,
			chain_instance_id: sub,
			subflow: "回放",
			node_id: "s",
			attempt: 1,
		});
		expect(all.lines[4]).toMatchObject({ task_id: z2.taskId, node_id: "z", attempt: 2 });
		expect(all).toMatchObject({ run_id: runId, truncated_tasks: [], expired: false });

		const latest = await page(runId, "limit=3");
		expect(latest.lines).toEqual(all.lines.slice(-3));
	});

	it("同一个任务内始终按 seq 排列：后一行折算出的控制面时间更早也不调换", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(z1, [line(a, 1, 1_000, "z1 first"), line(a, 2, 3_500, "z1 second")]);
		b.logs(s, [
			line(b, 1, 2_000, "s first"),
			line(b, 2, 4_000, "s second"),
			line(b, 3, 3_000, "s third"),
		]);

		const { lines } = await settled(runId, 5);
		expect(lines.filter((l) => l.node_id === "s").map((l) => l.seq)).toEqual([1, 2, 3]);
		expect(lines.filter((l) => l.node_id === "z").map((l) => l.seq)).toEqual([1, 2]);
		expect(lines.map(brief).slice(0, 2)).toEqual([
			["z", 1, 1, "z1 first"],
			["s", 1, 1, "s first"],
		]);
	});

	it("控制面时间相同时按链、节点、尝试的顺序排列，每次读出的顺序都一样", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		await a.fail(z1, "boom");
		const z2 = await a.nextAssign();
		await a.succeed(z2);
		const at = await a.nextAssign();
		// 发送的顺序与期望的顺序相反，时间全部相同。
		a.logs(at, [line(a, 1, 9_000, "a")]);
		b.logs(s, [line(b, 1, 9_000, "s")]);
		a.logs(z2, [line(a, 1, 9_000, "z2")]);
		a.logs(z1, [line(a, 1, 9_000, "z1")]);

		const first = await settled(runId, 4);
		expect(first.lines.map(brief)).toEqual([
			["z", 1, 1, "z1"],
			["z", 2, 1, "z2"],
			["a", 1, 1, "a"],
			["s", 1, 1, "s"],
		]);
		expect((await page(runId, "limit=1000")).lines).toEqual(first.lines);
	});

	it("每行带上排序所需的信息：只用行本身和共用的比较函数就能排出控制面给出的顺序，不必查运行视图", async () => {
		const { a, b, runId } = await setup();
		const s = await b.nextAssign();
		const z1 = await a.nextAssign({ start: false });
		// z 第 1 次尝试是升级之前写入的旧行（没有控制面时间，按任务开始时间排），开始时间与 s 的一行相同。
		const dir = join(cp.dataDir, "logs", runId);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, `${z1.taskId}.jsonl`),
			`${JSON.stringify({ seq: 1, time: "2024-05-01T00:00:01.000Z", source: "stdout", level: "info", text: "z1 old" })}\n`,
		);
		clock.advance(9_000);
		await a.started(z1);
		await a.fail(z1, "boom");
		const z2 = await a.nextAssign();
		await a.succeed(z2);
		const at = await a.nextAssign();
		// 时间相同的行跨越主链与子流程、同一节点的两次尝试、链上不同的节点；发送的顺序与期望的顺序相反。
		a.logs(at, [line(a, 1, 9_000, "a"), line(a, 2, 12_000, "a later")]);
		b.logs(s, [line(b, 1, 9_000, "s"), line(b, 2, 10_000, "s later")]);
		a.logs(z2, [line(a, 1, 9_000, "z2"), line(a, 2, 11_000, "z2 later")]);

		const { lines } = await settled(runId, 7);
		expect(lines.map((l) => l.text)).toEqual([
			"z1 old",
			"z2",
			"a",
			"s",
			"s later",
			"z2 later",
			"a later",
		]);
		const sorted = lines
			.toReversed()
			.toSorted((x, y) => compareRunLogKeys(runLogKey(x), runLogKey(y)));
		expect(sorted).toEqual(lines);
		const main = (await taskOf(runId, "z", 1)).chain;
		const sub = (await taskOf(runId, "s", 1)).chain;
		expect(lines.find((l) => l.text === "z1 old")).toMatchObject({
			time: null,
			chain_depth: 0,
			chain_started_at: main.started_at,
			node_index: 2,
			task_started_at: iso(T0 + 9_000),
		});
		expect(lines.find((l) => l.text === "a")).toMatchObject({ chain_depth: 0, node_index: 3 });
		expect(lines.find((l) => l.text === "s")).toMatchObject({
			chain_depth: 1,
			chain_started_at: sub.started_at,
			node_index: 1,
		});
	});

	it("没有控制面时间的旧行（只会在文件开头）都按任务开始时间排：在这之前开始的任务的行之后、之后的行之前", async () => {
		const { a, b, runId } = await setup();
		const s = await b.nextAssign();
		const z1 = await a.nextAssign({ start: false });
		b.logs(s, [line(b, 1, 1_000, "s before z starts"), line(b, 2, 3_000, "s after z starts")]);
		// 升级之前写入的日志文件：每行只有一个时间（当时记的是 Agent 时间）。
		const old = [
			{ seq: 1, time: "2024-05-01T00:00:01.000Z", source: "stdout", level: "info", text: "old 1" },
			{ seq: 2, time: "2024-05-01T00:00:02.000Z", source: "stdout", level: "warn", text: "old 2" },
		];
		const dir = join(cp.dataDir, "logs", runId);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, `${z1.taskId}.jsonl`),
			old.map((l) => `${JSON.stringify(l)}\n`).join(""),
		);
		clock.advance(2_000);
		await a.started(z1);
		a.logs(z1, [line(a, 3, 4_000, "z new")]);

		const { lines } = await settled(runId, 5);
		expect(lines.map((l) => [l.node_id, l.text, l.time, l.agent_time])).toEqual([
			["s", "s before z starts", iso(T0 + 1_000), iso(AGENTS["agent-b"].agentT0 + 1_000)],
			["z", "old 1", null, "2024-05-01T00:00:01.000Z"],
			["z", "old 2", null, "2024-05-01T00:00:02.000Z"],
			["s", "s after z starts", iso(T0 + 3_000), iso(AGENTS["agent-b"].agentT0 + 3_000)],
			["z", "z new", iso(T0 + 4_000), iso(AGENTS["agent-a"].agentT0 + 4_000)],
		]);
	});

	it("任务的日志超过上限被截断时，截断标记出现在合并结果里，并列出被截断的任务", async () => {
		// 每行约 150 字节，600 字节能写 3 行左右。
		const { a, b, runId } = await setup({ logLimitBytes: 600 });
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(
			z1,
			Array.from({ length: 10 }, (_, i) => line(a, i + 1, 1_000 + i * 100, `z1 line ${i + 1}`)),
		);
		b.logs(s, [line(b, 1, 5_000, "s after the marker")]);

		await eventually(async () =>
			expect((await page(runId)).truncated_tasks).toMatchObject([
				{ task_id: z1.taskId, node_id: "z", attempt: 1, subflow: null },
			]),
		);
		const { lines } = await settled(runId, (await page(runId, "limit=1000")).lines.length);
		const marker = lines.at(-2);
		expect(marker).toMatchObject({ task_id: z1.taskId, source: "system", level: "warn" });
		expect(marker?.text).toContain("截断");
		expect(lines.at(-1)).toMatchObject({ node_id: "s", text: "s after the marker" });
	});

	it("运行已过保留期时返回 expired 和空页；运行不存在时 404", async () => {
		const { a, b, runId } = await setup({ retentionDays: 1 });
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(z1, [line(a, 1, 1_000, "z1")]);
		await settled(runId, 1);
		await b.succeed(s);
		await a.succeed(z1);
		await a.succeed(await a.nextAssign());
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));

		const before = (await page(runId)).before;

		clock.advance(2 * DAY);
		await eventually(async () => expect((await page(runId)).expired).toBe(true));
		expect(await page(runId)).toMatchObject({
			run_id: runId,
			lines: [],
			truncated_tasks: [],
			reached_start: true,
			expired: true,
		});
		expect(await page(runId, query({ before }))).toMatchObject({
			lines: [],
			reached_start: true,
			expired: true,
		});

		expect((await cp.fetch("/runs/00000000-0000-4000-8000-000000000000/logs")).status).toBe(404);
		expect((await cp.fetch("/runs/not-a-uuid/logs")).status).toBe(404);
		for (const bad of [
			"limit=0",
			"before=not-a-cursor",
			"after=not-a-cursor",
			query({ before, after: before }),
		]) {
			const res = await cp.fetch(`/runs/${runId}/logs?${bad}`);
			expect(res.status, bad).toBe(400);
			expect(await res.json(), bad).toMatchObject({ error: { code: "invalid_request" } });
		}
	});

	it("用 before 往前翻到开头、再用 after 往后接续回到最新：每行恰好出现一次，顺序与一次读出全部时相同", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(
			z1,
			Array.from({ length: 6 }, (_, i) => line(a, i + 1, 1_000 + i * 2_000, `z1 ${i + 1}`)),
		);
		b.logs(
			s,
			Array.from({ length: 7 }, (_, i) => line(b, i + 1, 2_000 + i * 1_500, `s ${i + 1}`)),
		);
		await a.fail(z1, "boom");
		const z2 = await a.nextAssign();
		a.logs(
			z2,
			Array.from({ length: 4 }, (_, i) => line(a, i + 1, 12_500 + i * 1_000, `z2 ${i + 1}`)),
		);
		const all = (await settled(runId, 17)).lines;

		const pages = await pagesToStart(runId, 4);
		expect(pages.map((p) => p.lines.length)).toEqual([4, 4, 4, 4, 1]);
		expect(pages.map((p) => p.reached_start)).toEqual([false, false, false, false, true]);
		expect(joined(pages)).toEqual(all);

		const earliest = pages.at(-1) as RunLogPage;
		expect([...earliest.lines, ...(await linesAfter(runId, earliest.after, 3))]).toEqual(all);
		// 最新一页的 after 之后还没有新的行。
		expect(await linesAfter(runId, (pages[0] as RunLogPage).after, 3)).toEqual([]);
	});

	it("翻页期间写入新行（包括晚到的行和之后才开始的任务）：已拿到的游标往前翻的结果不变，往后接续恰好拿到新写入的行", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(z1, [
			line(a, 1, 1_000, "z1 1"),
			line(a, 2, 3_000, "z1 2"),
			line(a, 3, 5_000, "z1 3"),
			line(a, 4, 7_000, "z1 4"),
		]);
		b.logs(s, [line(b, 1, 2_000, "s 1"), line(b, 2, 4_000, "s 2"), line(b, 3, 6_000, "s 3")]);
		const before = (await settled(runId, 7)).lines;
		const latest = await page(runId, query({ limit: 3 }));
		expect(latest.lines).toEqual(before.slice(-3));

		// 拿到最新一页之后：s 补上一行比 z1 第 4 行还早的（晚到），z 失败后重试，新的尝试开始输出。
		b.logs(s, [line(b, 4, 6_500, "s 4 late"), line(b, 5, 9_000, "s 5")]);
		await a.fail(z1, "boom");
		const z2 = await a.nextAssign();
		a.logs(z2, [line(a, 1, 8_000, "z2 1"), line(a, 2, 10_000, "z2 2")]);
		const after = (await settled(runId, 11)).lines;
		const fresh = new Set([`${s.taskId}:4`, `${s.taskId}:5`, `${z2.taskId}:1`, `${z2.taskId}:2`]);
		const isFresh = (l: RunLogLine) => fresh.has(`${l.task_id}:${l.seq}`);
		expect(after.filter(isFresh).map(brief)).toEqual([
			["s", 1, 4, "s 4 late"],
			["z", 2, 1, "z2 1"],
			["s", 1, 5, "s 5"],
			["z", 2, 2, "z2 2"],
		]);

		expect(joined(await pagesToStart(runId, 2, latest))).toEqual(before);
		expect(await linesAfter(runId, latest.after, 2)).toEqual(after.filter(isFresh));
	});

	it("同一任务内后一行折算出的控制面时间早不到 2 秒时记成与上一行相同：往前读、往后读给出同一个顺序", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		// z1 第 2 行折算出的控制面时间比第 1 行早 1.5 秒（例如重连后时钟偏差重测），比 s 的那一行也早。
		a.logs(z1, [line(a, 1, 5_000, "z1 first"), line(a, 2, 3_500, "z1 second")]);
		b.logs(s, [line(b, 1, 4_000, "s only")]);

		const all = (await settled(runId, 3)).lines;
		expect(all.map((l) => [l.text, l.time])).toEqual([
			["s only", iso(T0 + 4_000)],
			["z1 first", iso(T0 + 5_000)],
			["z1 second", iso(T0 + 5_000)],
		]);
		const own = logsApi.page.response.parse(
			await (await cp.fetch(`/tasks/${z1.taskId}/logs`)).json(),
		);
		expect(own.lines.map((l) => l.time)).toEqual([iso(T0 + 5_000), iso(T0 + 5_000)]);

		const pages = await pagesToStart(runId, 1);
		expect(joined(pages)).toEqual(all);
		const earliest = pages.at(-1) as RunLogPage;
		expect([...earliest.lines, ...(await linesAfter(runId, earliest.after, 1))]).toEqual(all);

		// 控制面重启之后（任务的状态重新从数据库和日志文件读出），新的一行同样不早于文件里的最后一行。
		await cp.restart();
		for (const agent of agents.splice(0)) void agent.disconnect();
		const { agentT0, m0 } = AGENTS["agent-a"];
		const again = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			...agentClock(agentT0, m0),
		});
		agents.push(again);
		again.logs(z1, [line(again, 3, 4_500, "z1 third")]);
		await eventually(async () =>
			expect((await page(runId, "limit=1000")).lines.at(-1)).toMatchObject({
				text: "z1 third",
				time: iso(T0 + 5_000),
			}),
		);
	});

	it("同一任务内控制面时间回退超过 2 秒时保留折算出的时间：一行偏到未来之后，后面的行不会都停在那个时刻", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		// 第 2 行折算到了一分钟之后（偏差测量出错），第 3、4 行回到正常的时间。
		a.logs(z1, [
			line(a, 1, 1_000, "z1 1"),
			line(a, 2, 60_000, "z1 2 future"),
			line(a, 3, 3_000, "z1 3"),
			line(a, 4, 4_000, "z1 4"),
		]);
		b.logs(s, [line(b, 1, 2_000, "s 1"), line(b, 2, 3_500, "s 2")]);

		await eventually(async () => {
			const own = logsApi.page.response.parse(
				await (await cp.fetch(`/tasks/${z1.taskId}/logs`)).json(),
			);
			expect(own.lines.map((l) => [l.text, l.time])).toEqual([
				["z1 1", iso(T0 + 1_000)],
				["z1 2 future", iso(T0 + 60_000)],
				["z1 3", iso(T0 + 3_000)],
				["z1 4", iso(T0 + 4_000)],
			]);
		});
		const all = (await settled(runId, 6)).lines;
		expect(all.filter((l) => l.node_id === "z").map((l) => l.seq)).toEqual([1, 2, 3, 4]);
		const once = (lines: RunLogLine[]) => lines.map((l) => `${l.task_id}:${l.seq}`).sort();
		const pages = await pagesToStart(runId, 1);
		expect(once(joined(pages))).toEqual(once(all));
		expect(
			joined(pages)
				.filter((l) => l.node_id === "z")
				.map((l) => l.seq),
		).toEqual([1, 2, 3, 4]);
		const earliest = pages.at(-1) as RunLogPage;
		const forward = [...earliest.lines, ...(await linesAfter(runId, earliest.after, 1))];
		expect(once(forward)).toEqual(once(all));
		expect(forward.filter((l) => l.node_id === "z").map((l) => l.seq)).toEqual([1, 2, 3, 4]);
	});

	it("单次请求的扫描量达到上限时先返回不满一页的结果，不算读到开头或末尾；用游标接着读完，不重复不漏行", async () => {
		// z 的行长（约 750 字节）、稀疏（每 5 秒一行）；s 的行短（约 140 字节）、密集（每 0.6 秒一行）。
		// 同样的扫描量，s 读到的行只覆盖很短的一段时间：s 的行取完时 z 读到的行里还有更早的，这时必须停下，
		// 不能接着取 z 的行，否则 s 还没读的、更晚的行会被挤到后面的页里。
		const { a, b, runId } = await setup({ logScanBytes: 2_400 });
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		const zAt = (i: number) => 1_000 + i * 5_000;
		const sAt = (i: number) => 1_250 + i * 600;
		a.logs(
			z1,
			Array.from({ length: 8 }, (_, i) => line(a, i + 1, zAt(i), `z1 ${i + 1} ${"x".repeat(600)}`)),
		);
		b.logs(
			s,
			Array.from({ length: 60 }, (_, i) => line(b, i + 1, sAt(i), `s ${i + 1}`)),
		);
		const expected = [
			...Array.from({ length: 8 }, (_, i) => ({ at: zAt(i), l: ["z", 1, i + 1] })),
			...Array.from({ length: 60 }, (_, i) => ({ at: sAt(i), l: ["s", 1, i + 1] })),
		]
			.sort((x, y) => x.at - y.at)
			.map((x) => x.l);
		const order = (lines: RunLogLine[]) => lines.map((l) => [l.node_id, l.attempt, l.seq]);
		await ownLines(z1, 8);
		await ownLines(s, 60);

		const pages = await pagesToStart(runId, 1000);
		const latest = pages[0] as RunLogPage;
		expect(latest.lines.length).toBeGreaterThan(0);
		expect(latest.lines.length).toBeLessThan(68);
		expect(latest.reached_start).toBe(false);
		expect(pages.slice(0, -1).every((p) => !p.reached_start && p.lines.length > 0)).toBe(true);
		expect(order(joined(pages))).toEqual(expected);

		const earliest = pages.at(-1) as RunLogPage;
		const next = await page(runId, query({ limit: 1000, after: earliest.after }));
		expect(next.lines.length).toBeGreaterThan(0);
		expect(next.reached_end).toBe(false);
		const forward = [...earliest.lines, ...(await linesAfter(runId, earliest.after, 1000))];
		expect(order(forward)).toEqual(expected);
	});

	it("一个任务日志很多、其余许多任务只有几行时，扫描量集中给读得出行的任务：每页仍然取满 limit 行", async () => {
		const small = Array.from({ length: 20 }, (_, i) => `n${i + 1}`);
		const onA = (id: string) => ({ ...echo(id), agent: "agent-a" });
		// 平分时每个任务只分到不到 500 字节（三四行），只够小任务读完自己的那一行。
		const { a, runId } = await setup({
			logScanBytes: 10_000,
			doc: orchestration([[{ id: "entry", kind: "entry" }, ...[...small, "hot"].map(onA)]], []),
		});
		for (const [i, id] of small.entries()) {
			const task = await a.nextAssign();
			a.logs(task, [line(a, 1, 1_000 + i * 100, `${id} only`)]);
			await a.succeed(task);
		}
		const hot = await a.nextAssign();
		a.logs(
			hot,
			Array.from({ length: 200 }, (_, i) => line(a, i + 1, 10_000 + i * 100, `hot ${i + 1}`)),
		);
		await ownLines(hot, 200);
		const all = [
			...small.map((id) => `${id} only`),
			...Array.from({ length: 200 }, (_, i) => `hot ${i + 1}`),
		];

		const pages = await pagesToStart(runId, 30);
		expect(pages.map((p) => p.lines.length)).toEqual([30, 30, 30, 30, 30, 30, 30, 10]);
		expect(joined(pages).map((l) => l.text)).toEqual(all);
		const earliest = pages.at(-1) as RunLogPage;
		const forward = [...earliest.lines, ...(await linesAfter(runId, earliest.after, 30))];
		expect(forward.map((l) => l.text)).toEqual(all);
	});

	it("只读到请求开始那一刻已写入的内容：读取期间才写进文件的行不在这一页，下一次请求才读", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(z1, [line(a, 1, 1_000, "z1 1"), line(a, 2, 3_000, "z1 2")]);
		b.logs(s, [line(b, 1, 2_000, "s 1"), line(b, 2, 4_000, "s 2")]);
		const all = (await settled(runId, 4)).lines;
		const start = (await pagesToStart(runId, 1000)).at(-1)?.before as string;

		// 列出任务之后、读到这个文件之前写入的一行：直接追加到文件末尾，控制面这时还没记下它。
		const written = {
			seq: 3,
			time: iso(T0 + 5_000),
			agent_time: null,
			source: "stdout",
			level: "info",
			text: "z1 3 written while reading",
		};
		await appendFile(
			join(cp.dataDir, "logs", runId, `${z1.taskId}.jsonl`),
			`${JSON.stringify(written)}\n`,
		);

		const forward = await page(runId, query({ limit: 1000, after: start }));
		expect(forward.lines).toEqual(all);
		expect(forward.reached_end).toBe(true);
		expect((await page(runId, query({ limit: 1000 }))).lines).toEqual(all);
	});
	describe("范围与级别（#224）", () => {
		/** 主链 z 失败重试一次、a；子流程 s：三个任务共 9 行，z 的两次尝试各有 warn 与 error。 */
		const scoped = async (options: { logLimitBytes?: number; logScanBytes?: number } = {}) => {
			const { a, b, runId } = await setup(options);
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			a.logs(z1, [
				line(a, 1, 1_000, "z1 info"),
				line(a, 2, 4_000, "z1 warn", LogLevel.WARN),
				line(a, 3, 7_000, "z1 error", LogLevel.ERROR),
			]);
			b.logs(s, [
				line(b, 1, 2_000, "s debug", LogLevel.DEBUG),
				line(b, 2, 5_000, "s error", LogLevel.ERROR),
				line(b, 3, 8_000, "s info"),
			]);
			await a.fail(z1, "boom");
			const z2 = await a.nextAssign();
			a.logs(z2, [line(a, 1, 9_000, "z2 warn", LogLevel.WARN), line(a, 2, 10_000, "z2 info")]);
			await a.succeed(z2);
			const at = await a.nextAssign();
			a.logs(at, [line(a, 1, 11_000, "a warn", LogLevel.WARN)]);
			const main = (await taskOf(runId, "z", 1)).chain.id;
			const sub = (await taskOf(runId, "s", 1)).chain.id;
			return { a, b, runId, main, sub };
		};
		const nodes = (scope: RunLogScope) => ({ nodes: encodeRunLogScope(scope) });
		const texts = (lines: RunLogLine[]) => lines.map((l) => l.text);

		it("范围：只返回指定节点每次尝试的日志（主链和子流程里的节点），其余任务的行不出现；不给范围是全部节点，空范围没有任何节点", async () => {
			const { runId, main, sub } = await scoped();
			const all = (await settled(runId, 9)).lines;

			const z = await page(
				runId,
				query({ limit: 1000, ...nodes([{ chain_instance_id: main, node_id: "z" }]) }),
			);
			expect(texts(z.lines)).toEqual(["z1 info", "z1 warn", "z1 error", "z2 warn", "z2 info"]);
			expect(z.lines).toEqual(all.filter((l) => l.node_id === "z"));
			expect(z.reached_start).toBe(true);

			const sAndA = await page(
				runId,
				query({
					limit: 1000,
					...nodes([
						{ chain_instance_id: sub, node_id: "s" },
						{ chain_instance_id: main, node_id: "a" },
					]),
				}),
			);
			expect(sAndA.lines).toEqual(all.filter((l) => l.node_id === "s" || l.node_id === "a"));
			expect(texts(sAndA.lines)).toEqual(["s debug", "s error", "s info", "a warn"]);

			// 节点 ID 相同、链实例不同：范围按「链路实例 ID + 节点 ID」，子流程里没有 z。
			const wrongChain = await page(
				runId,
				query({ limit: 1000, ...nodes([{ chain_instance_id: sub, node_id: "z" }]) }),
			);
			expect(wrongChain).toMatchObject({ lines: [], reached_start: true, expired: false });
			expect(await page(runId, query({ limit: 1000, ...nodes([]) }))).toMatchObject({
				lines: [],
				reached_start: true,
			});
			expect((await page(runId, query({ limit: 1000 }))).lines).toEqual(all);
		});

		it("范围里往前翻到开头、再往后接续：只涉及范围内的任务，每行恰好一次，顺序与一次读出时相同", async () => {
			const { runId, main, sub } = await scoped();
			const all = (await settled(runId, 9)).lines;
			const scope = nodes([
				{ chain_instance_id: main, node_id: "z" },
				{ chain_instance_id: sub, node_id: "s" },
			]);
			const expected = all.filter((l) => l.node_id !== "a");
			expect(expected).toHaveLength(8);

			const pages = await pagesToStart(runId, 3, undefined, scope);
			expect(pages.map((p) => p.lines.length)).toEqual([3, 3, 2]);
			expect(joined(pages)).toEqual(expected);

			const earliest = pages.at(-1) as RunLogPage;
			expect([...earliest.lines, ...(await linesAfter(runId, earliest.after, 3, scope))]).toEqual(
				expected,
			);
			expect(await linesAfter(runId, (pages[0] as RunLogPage).after, 3, scope)).toEqual([]);
		});

		it("范围外任务的截断标记不出现在截断列表和合并结果里", async () => {
			// 每行约 150 字节，600 字节写 3 行左右：z 的第一次尝试被截断，s 没有。
			const { a, b, runId } = await setup({ logLimitBytes: 600 });
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			a.logs(
				z1,
				Array.from({ length: 10 }, (_, i) => line(a, i + 1, 1_000 + i * 100, `z1 line ${i + 1}`)),
			);
			b.logs(s, [line(b, 1, 5_000, "s only")]);
			await eventually(async () => expect((await page(runId)).truncated_tasks).toHaveLength(1));
			const sub = (await taskOf(runId, "s", 1)).chain.id;
			const main = (await taskOf(runId, "z", 1)).chain.id;

			const onlyS = await page(
				runId,
				query({ ...nodes([{ chain_instance_id: sub, node_id: "s" }]) }),
			);
			expect(onlyS.truncated_tasks).toEqual([]);
			expect(texts(onlyS.lines)).toEqual(["s only"]);
			const onlyZ = await page(
				runId,
				query({ ...nodes([{ chain_instance_id: main, node_id: "z" }]) }),
			);
			expect(onlyZ.truncated_tasks).toMatchObject([{ task_id: z1.taskId, node_id: "z" }]);
			expect(onlyZ.lines.some((l) => l.source === "system")).toBe(true);
		});

		it("级别：服务端只返回这些级别的行，翻页时跳过不匹配的行；可以与范围组合", async () => {
			const { runId, main } = await scoped();
			await settled(runId, 9);

			const warnUp = await page(runId, query({ limit: 1000, level: "warn,error" }));
			expect(texts(warnUp.lines)).toEqual(["z1 warn", "s error", "z1 error", "z2 warn", "a warn"]);
			expect(warnUp.reached_start).toBe(true);
			expect(texts((await page(runId, query({ limit: 1000, level: "error" }))).lines)).toEqual([
				"s error",
				"z1 error",
			]);

			const pages = await pagesToStart(runId, 2, undefined, { level: "warn,error" });
			expect(pages.map((p) => p.lines.length)).toEqual([2, 2, 1]);
			expect(texts(joined(pages))).toEqual(texts(warnUp.lines));

			const both = await page(
				runId,
				query({
					limit: 1000,
					level: "warn",
					...nodes([{ chain_instance_id: main, node_id: "z" }]),
				}),
			);
			expect(texts(both.lines)).toEqual(["z1 warn", "z2 warn"]);

			// 筛掉了全部行：空页，读到了开头。
			expect(
				await page(
					runId,
					query({ level: "error", ...nodes([{ chain_instance_id: main, node_id: "a" }]) }),
				),
			).toMatchObject({
				lines: [],
				reached_start: true,
			});
		});

		it("级别很少匹配、单次扫描量用完时：页可以是空的但没读到开头，用 before 接着读，游标每次都往前走，最终读到匹配的行", async () => {
			// 每行约 150 字节，两个任务各分到 600 字节：一次每个任务只扫得过几行。
			const { a, b, runId } = await setup({ logScanBytes: 1_200 });
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			a.logs(z1, [
				line(a, 1, 1_000, "z1 the only error", LogLevel.ERROR),
				...Array.from({ length: 19 }, (_, i) => line(a, i + 2, 2_000 + i * 1_000, `z1 ${i + 2}`)),
			]);
			b.logs(
				s,
				Array.from({ length: 20 }, (_, i) => line(b, i + 1, 1_500 + i * 1_000, `s ${i + 1}`)),
			);
			await eventually(async () => {
				for (const task of [z1, s]) {
					const own = logsApi.page.response.parse(
						await (await cp.fetch(`/tasks/${task.taskId}/logs`)).json(),
					);
					expect(own.lines).toHaveLength(20);
				}
			});

			const extra = { level: "error" };
			const pages = await pagesToStart(runId, 50, undefined, extra);
			expect(pages.length).toBeGreaterThan(2);
			const first = pages[0] as RunLogPage;
			expect(first.lines).toEqual([]);
			expect(first.reached_start).toBe(false);
			// 每一页的 before 都与它请求时用的不同：不会原地打转。
			const cursors = pages.map((p) => p.before);
			expect(new Set(cursors).size).toBe(cursors.length);
			expect(texts(joined(pages))).toEqual(["z1 the only error"]);
			expect(pages.at(-1)?.reached_start).toBe(true);

			const earliest = pages.at(-1) as RunLogPage;
			expect(texts(await linesAfter(runId, earliest.after, 50, extra))).toEqual([]);
		});

		it("往后接续时级别很少匹配、单次扫描量用完：页可以是空的但 reached_end 为 false，用 after 接着读到匹配的行", async () => {
			const { a, b, runId } = await setup({ logScanBytes: 1_200 });
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			a.logs(z1, [
				...Array.from({ length: 19 }, (_, i) => line(a, i + 1, 1_000 + i * 1_000, `z1 ${i + 1}`)),
				line(a, 20, 20_000, "z1 the only error", LogLevel.ERROR),
			]);
			b.logs(
				s,
				Array.from({ length: 20 }, (_, i) => line(b, i + 1, 1_500 + i * 1_000, `s ${i + 1}`)),
			);
			await ownLines(z1, 20);
			await ownLines(s, 20);

			const extra = { level: "error" };
			const start = (await pagesToStart(runId, 50, undefined, extra)).at(-1)?.before as string;
			const first = await page(runId, query({ limit: 50, ...extra, after: start }));
			expect(first).toMatchObject({ lines: [], reached_end: false });
			expect(texts(await linesAfter(runId, start, 50, extra))).toEqual(["z1 the only error"]);
		});

		it("节点 ID 里有逗号、分号、冒号、百分号和中文时，范围也能准确匹配", async () => {
			const odd = (id: string) => ({ ...echo(id), agent: "agent-a" });
			const ids = ["a,b", "a;b", "a:b", "100%", "a%2Cb", "回放"];
			const { a, runId } = await setup({
				doc: orchestration([[{ id: "entry", kind: "entry" }, ...ids.map(odd)]], []),
			});
			for (const [i, id] of ids.entries()) {
				const task = await a.nextAssign();
				expect(task.nodeId).toBe(id);
				a.logs(task, [line(a, 1, 1_000 + i * 1_000, `from ${id}`)]);
				await a.succeed(task);
			}
			const all = (await settled(runId, ids.length)).lines;
			const chain = all[0]?.chain_instance_id as string;
			for (const id of ids) {
				const only = await page(
					runId,
					query({ ...nodes([{ chain_instance_id: chain, node_id: id }]) }),
				);
				expect(texts(only.lines), id).toEqual([`from ${id}`]);
			}
			const some = await page(
				runId,
				query({
					...nodes(
						["a,b", "a:b", "回放"].map((node_id) => ({ chain_instance_id: chain, node_id })),
					),
				}),
			);
			expect(texts(some.lines)).toEqual(["from a,b", "from a:b", "from 回放"]);
		});

		it("nodes 不是约定的写法、重复给出或 level 不认识时 400", async () => {
			const { runId, main } = await scoped();
			for (const bad of [
				"nodes=no-colon",
				`nodes=${main}:`,
				`nodes=:z`,
				`nodes=${main}:z;`,
				"nodes=%E0%A4%A",
				"level=loud",
			]) {
				const res = await cp.fetch(`/runs/${runId}/logs?${bad}`);
				expect(res.status, bad).toBe(400);
				expect(await res.json(), bad).toMatchObject({ error: { code: "invalid_request" } });
			}
			// 同一个参数重复给出也不接受（范围只有一个 nodes）。
			const twice = await cp.fetch(`/runs/${runId}/logs?nodes=${main}:z&nodes=${main}:a`);
			expect(twice.status).toBe(400);
		});
	});

	describe("实时推送（#225）", () => {
		const streams: SseClient[] = [];
		afterEach(() => {
			for (const sse of streams.splice(0)) sse.close();
		});

		/** 连上按运行的实时推送；headers 可带 last-event-id 模拟浏览器重连。 */
		const follow = async (
			runId: string,
			params: Record<string, string> = {},
			headers: Record<string, string> = {},
		) => {
			const sse = await SseClient.open(cp, `/runs/${runId}/logs/events?${query(params)}`, headers);
			streams.push(sse);
			return sse;
		};
		/** 收 logs 事件直到凑够 n 行（按收到的先后）；返回这些行和最后一个事件的 ID。 */
		const pushed = async (sse: SseClient, n: number) => {
			const lines: RunLogLine[] = [];
			let id: string | undefined;
			while (lines.length < n) {
				const event = await sse.next("logs");
				lines.push(...logsApi.runEvents.events.logs.parse(event.data).lines);
				id = event.id;
			}
			expect(lines).toHaveLength(n);
			return { lines, id: id as string };
		};
		const keyOf = (l: RunLogLine) => `${l.task_id}:${l.seq}`;
		/** 等这个任务的日志写到第 seq 行（行数多、扫描量小时不能用 settled）。 */
		const written = (task: { taskId: string }, seq: number) =>
			eventually(async () => {
				const own = logsApi.page.response.parse(
					await (await cp.fetch(`/tasks/${task.taskId}/logs?limit=1`)).json(),
				);
				expect(own.last_seq).toBe(seq);
			});

		/** 主链 entry → z（失败重试 1 次）→ spawn → a，spawn 之后才触发子流程「回放」sub → s（在 agent-b 上执行）。 */
		const LATE_SUBFLOW = orchestration(
			[
				[{ id: "entry", kind: "entry" }, { ...echo("z"), retries: 1 }, spawn("spawn"), echo("a")],
				[
					{ id: "sub", kind: "subflow_entry", name: "回放", params: [] },
					{ ...echo("s"), agent: "agent-b" },
				],
			],
			[["spawn", "sub"]],
		);

		it("先读最新一页、再用 live_after 接上：之后写入的行都推送到（包括之后才开始的尝试和新触发的子流程），每行与分页读出的相同，合起来不重复不遗漏", async () => {
			const { a, b, runId } = await setup({ doc: LATE_SUBFLOW });
			const z1 = await a.nextAssign();
			a.logs(z1, [line(a, 1, 1_000, "z1 1"), line(a, 2, 2_000, "z1 2")]);
			const history = await settled(runId, 2);

			// 读完历史、连上之前写入的一行：连上时补发。
			a.logs(z1, [line(a, 3, 3_000, "z1 3")]);
			await written(z1, 3);
			const sse = await follow(runId, { after: history.live_after });
			await a.fail(z1, "boom");
			const z2 = await a.nextAssign();
			a.logs(z2, [line(a, 1, 4_000, "z2 1"), line(a, 2, 6_000, "z2 2")]);
			await a.succeed(z2);
			const s = await b.nextAssign();
			const at = await a.nextAssign();
			b.logs(s, [line(b, 1, 5_000, "s 1"), line(b, 2, 8_000, "s 2")]);
			a.logs(at, [line(a, 1, 7_000, "a 1")]);

			const live = (await pushed(sse, 6)).lines;
			const all = (await settled(runId, 8)).lines;
			const byKey = new Map(all.map((l) => [keyOf(l), l]));
			// 推送的每行与分页读出的同一行完全相同（来源、排序信息都一样）。
			for (const l of live) expect(l).toEqual(byKey.get(keyOf(l)));
			expect(new Set(live.map((l) => `${l.node_id}#${l.attempt} ${l.subflow ?? "主链"}`))).toEqual(
				new Set(["z#1 主链", "z#2 主链", "s#1 回放", "a#1 主链"]),
			);
			const seen = [...history.lines, ...live].map(keyOf);
			expect(new Set(seen).size).toBe(seen.length);
			expect(new Set(seen)).toEqual(new Set(all.map(keyOf)));
		});

		it("范围与级别和分页相同：只推送范围内节点（包括之后的新尝试）的、这些级别的行", async () => {
			const { a, b, runId } = await setup();
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			const main = (await taskOf(runId, "z", 1)).chain.id;
			const params = {
				nodes: encodeRunLogScope([{ chain_instance_id: main, node_id: "z" }]),
				level: "warn,error",
			};
			const latest = await page(runId, query({ ...params, limit: 10 }));
			const sse = await follow(runId, { ...params, after: latest.live_after });

			b.logs(s, [line(b, 1, 1_000, "s error", LogLevel.ERROR)]);
			a.logs(z1, [line(a, 1, 2_000, "z1 info"), line(a, 2, 3_000, "z1 warn", LogLevel.WARN)]);
			await a.fail(z1, "boom");
			const z2 = await a.nextAssign();
			await ownLines(s, 1);
			a.logs(z2, [
				line(a, 1, 4_000, "z2 debug", LogLevel.DEBUG),
				line(a, 2, 5_000, "z2 error", LogLevel.ERROR),
			]);

			expect((await pushed(sse, 2)).lines.map((l) => [l.text, l.attempt])).toEqual([
				["z1 warn", 1],
				["z2 error", 2],
			]);
			expect(sse.received.filter((e) => e.event === "logs")).toHaveLength(2);
		});

		it("断线后用 Last-Event-ID 重连：只补发断线期间写入的行（包括新的尝试），已推送的不再推送，之后照常推送", async () => {
			const { a, b, runId } = await setup();
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			const { live_after } = await page(runId);
			const first = await follow(runId, { after: live_after });
			a.logs(z1, [line(a, 1, 1_000, "z1 1"), line(a, 2, 2_000, "z1 2")]);
			b.logs(s, [line(b, 1, 3_000, "s 1")]);
			const before = await pushed(first, 3);
			const firstEvent = first.received.find((e) => e.event === "logs")?.id as string;
			first.close();

			a.logs(z1, [line(a, 3, 4_000, "z1 3")]);
			b.logs(s, [line(b, 2, 5_000, "s 2"), line(b, 3, 6_000, "s 3")]);
			await a.fail(z1, "boom");
			const z2 = await a.nextAssign();
			a.logs(z2, [line(a, 1, 7_000, "z2 1")]);
			const all = (await settled(runId, 7)).lines;

			// 浏览器重连时 URL 不变（仍是第一次的 after），请求头带最后收到的事件 ID。
			const resumed = await follow(runId, { after: live_after }, { "last-event-id": before.id });
			const missed = await pushed(resumed, 4);
			expect(new Set(missed.lines.map(keyOf))).toEqual(
				new Set(all.map(keyOf).filter((k) => !before.lines.map(keyOf).includes(k))),
			);
			a.logs(z2, [line(a, 2, 8_000, "z2 2")]);
			expect((await pushed(resumed, 1)).lines.map((l) => l.text)).toEqual(["z2 2"]);

			// 从中间的事件 ID 续传：补发的是那个事件之后的全部行。
			const fromMiddle = await follow(
				runId,
				{ after: live_after },
				{ "last-event-id": firstEvent },
			);
			const firstLines = logsApi.runEvents.events.logs
				.parse(first.received.find((e) => e.event === "logs")?.data)
				.lines.map(keyOf);
			const rest = (await settled(runId, 8)).lines
				.map(keyOf)
				.filter((k) => !firstLines.includes(k));
			expect(new Set((await pushed(fromMiddle, rest.length)).lines.map(keyOf))).toEqual(
				new Set(rest),
			);
		});

		it("一台 Agent 断线重连后补发的晚到行照常推送：控制面时间早于已经推送的别的任务的行，按排序键排在它们前面", async () => {
			const { a, b, runId } = await setup();
			const z1 = await a.nextAssign();
			const s = await b.nextAssign();
			const sse = await follow(runId, { after: (await page(runId)).live_after });
			b.logs(s, [line(b, 1, 1_000, "s 1")]);
			a.logs(z1, [line(a, 1, 2_000, "z1 1")]);
			await pushed(sse, 2);

			// agent-b 断线 10 秒，期间（第 3、5 秒）读到的两行排着队；agent-a 照常上报第 4、6 秒的行。
			agents.splice(agents.indexOf(b), 1);
			await b.disconnect();
			a.logs(z1, [line(a, 2, 4_000, "z1 2"), line(a, 3, 6_000, "z1 3")]);
			expect((await pushed(sse, 2)).lines.map((l) => l.text)).toEqual(["z1 2", "z1 3"]);
			clock.advance(10_000);
			const { agentT0, m0 } = AGENTS["agent-b"];
			const back = await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-b",
				...agentClock(agentT0 + 10_000, m0 + 10_000),
				runningTasks: [{ taskId: s.taskId, attempt: s.attempt }],
			});
			agents.push(back);
			back.logs(s, [line(back, 2, 3_000, "s 2 late"), line(back, 3, 5_000, "s 3 late")]);

			const late = (await pushed(sse, 2)).lines;
			expect(late.map((l) => [l.text, l.time])).toEqual([
				["s 2 late", iso(T0 + 3_000)],
				["s 3 late", iso(T0 + 5_000)],
			]);
			const all = (await settled(runId, 6)).lines;
			expect(all.map((l) => l.text)).toEqual([
				"s 1",
				"z1 1",
				"s 2 late",
				"z1 2",
				"s 3 late",
				"z1 3",
			]);
			// 只凭推送的行本身就能排出这个顺序（前端插入实时行用的就是这个比较函数）。
			const arrived = [
				...late,
				...(await page(runId, "limit=1000")).lines.filter((l) => !l.text.includes("late")),
			];
			expect(arrived.toSorted((x, y) => compareRunLogKeys(runLogKey(x), runLogKey(y)))).toEqual(
				all,
			);
		});

		it("连上时要补发的行超过 5000 行：不逐行补发，推送 reload，之后照常推送新写入的行；从 live_after 连上时没有要补发的", async () => {
			const { a, runId } = await setup();
			const z1 = await a.nextAssign();
			a.logs(
				z1,
				Array.from({ length: 5_001 }, (_, i) => line(a, i + 1, 1_000 + i, `z1 ${i + 1}`)),
			);
			await written(z1, 5_001);

			const fromStart = await follow(runId);
			await fromStart.next("reload");
			a.logs(z1, [line(a, 5_002, 9_000, "z1 5002")]);
			expect((await pushed(fromStart, 1)).lines.map((l) => l.seq)).toEqual([5_002]);
			expect(fromStart.received.filter((e) => e.event === "logs")).toHaveLength(1);

			const fromLatest = await follow(runId, { after: (await page(runId)).live_after });
			a.logs(z1, [line(a, 5_003, 9_500, "z1 5003")]);
			expect((await pushed(fromLatest, 1)).lines.map((l) => l.seq)).toEqual([5_003]);
			expect(fromLatest.received.filter((e) => e.event === "reload")).toHaveLength(0);
		});

		it("运行不存在时 404；after 不是 live_after（例如分页游标）时 400", async () => {
			const { a, runId } = await setup();
			const z1 = await a.nextAssign();
			a.logs(z1, [line(a, 1, 1_000, "z1 1")]);
			const latest = await settled(runId, 1);
			expect(
				(await cp.fetch("/runs/00000000-0000-0000-0000-000000000000/logs/events")).status,
			).toBe(404);
			expect((await cp.fetch("/runs/nope/logs/events")).status).toBe(404);
			for (const bad of ["garbage", latest.after, latest.before]) {
				const res = await cp.fetch(`/runs/${runId}/logs/events?${query({ after: bad })}`);
				expect(res.status, bad).toBe(400);
				expect(await res.json(), bad).toMatchObject({ error: { code: "invalid_request" } });
			}
		});
	});
});
