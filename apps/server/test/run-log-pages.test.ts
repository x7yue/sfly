// 切入点 A：按运行合并读取日志（#222、#223）。两台假 Agent 经 gRPC 上报日志（各自的 Agent 时间偏差不同），
// 通过 HTTP 读取整次运行合并后的日志：按控制面时间交错排列，每行带来源；用游标往前翻页、往后接续。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logsApi, type RunLogLine, type RunLogPage, runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { agentClock, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
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
		options: { logLimitBytes?: number; retentionDays?: number; logScanBytes?: number } = {},
	) => {
		cp = await startTestControlPlane({ clock, leaseMs: 30 * DAY, ...options });
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
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		return { a, b, runId };
	};

	/** 第 seq 行：Agent 在控制面时间 T0 + atMs 读到它（Agent 时间按这台 Agent 的偏差，单调时钟读数照实走）。 */
	const line = (agent: FakeAgent, seq: number, atMs: number, text: string) => {
		const { agentT0, m0 } = AGENTS[agent.name as AgentName];
		return {
			seq: BigInt(seq),
			timeUnixMs: BigInt(agentT0 + atMs),
			monotonicMs: BigInt(m0 + atMs),
			source: LogSource.STDOUT,
			level: LogLevel.INFO,
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
	/** 从最新一页用 before 游标往前翻，直到读到开头；返回各页，从新到旧。 */
	const pagesToStart = async (runId: string, limit: number, first?: RunLogPage) => {
		const pages = [first ?? (await page(runId, query({ limit })))];
		for (let last = pages[0]; !last?.reached_start; last = pages.at(-1)) {
			if (!last || pages.length > 200) throw new Error("翻不到开头");
			pages.push(await page(runId, query({ limit, before: last.before })));
		}
		return pages;
	};
	/** 各页（从新到旧）按时间先后拼起来。 */
	const joined = (pages: RunLogPage[]) => pages.toReversed().flatMap((p) => p.lines);
	/** 从 after 游标往后接续，直到没有新的行；返回读到的全部行。 */
	const linesAfter = async (runId: string, after: string, limit: number) => {
		const lines: RunLogLine[] = [];
		for (let cursor = after, n = 0; ; n++) {
			if (n > 200) throw new Error("接续不完");
			const next = await page(runId, query({ limit, after: cursor }));
			if (next.lines.length === 0) return lines;
			lines.push(...next.lines);
			cursor = next.after;
		}
	};
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

	it("没有控制面时间的旧行：任务的第一行按任务开始时间排，之后的旧行沿用上一行的排序时间", async () => {
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

	it("同一任务内后一行折算出的控制面时间更早时记成与上一行相同：往前读、往后读给出同一个顺序", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		// z1 第 2 行折算出的控制面时间比第 1 行早 2 秒（例如重连后时钟偏差重测），比 s 的那一行也早。
		a.logs(z1, [line(a, 1, 5_000, "z1 first"), line(a, 2, 3_000, "z1 second")]);
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

	it("单次请求的扫描量达到上限时先返回不满一页的结果，不算读到开头；用游标接着读完，不重复不漏行", async () => {
		// 每行约 150 字节：两个任务各分到 600 字节左右，一次每个任务只读得到几行。
		const { a, b, runId } = await setup({ logScanBytes: 1_200 });
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(
			z1,
			Array.from({ length: 20 }, (_, i) => line(a, i + 1, 1_000 + i * 1_000, `z1 ${i + 1}`)),
		);
		b.logs(
			s,
			Array.from({ length: 20 }, (_, i) => line(b, i + 1, 1_500 + i * 1_000, `s ${i + 1}`)),
		);
		const expected = Array.from({ length: 20 }, (_, i) => [
			["z", 1, i + 1, `z1 ${i + 1}`],
			["s", 1, i + 1, `s ${i + 1}`],
		]).flat();
		await eventually(async () => {
			const own = logsApi.page.response.parse(
				await (await cp.fetch(`/tasks/${s.taskId}/logs`)).json(),
			);
			expect(own.lines).toHaveLength(20);
			expect(
				logsApi.page.response.parse(await (await cp.fetch(`/tasks/${z1.taskId}/logs`)).json())
					.lines,
			).toHaveLength(20);
		});

		const pages = await pagesToStart(runId, 1000);
		const latest = pages[0] as RunLogPage;
		expect(latest.lines.length).toBeGreaterThan(0);
		expect(latest.lines.length).toBeLessThan(20);
		expect(latest.reached_start).toBe(false);
		expect(pages.slice(0, -1).every((p) => !p.reached_start && p.lines.length > 0)).toBe(true);
		expect(joined(pages).map(brief)).toEqual(expected);

		const earliest = pages.at(-1) as RunLogPage;
		const forward = [...earliest.lines, ...(await linesAfter(runId, earliest.after, 1000))];
		expect(forward.map(brief)).toEqual(expected);
	});
});
