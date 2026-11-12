// 切入点 A：下载整次运行合并后的日志（#226）。两台假 Agent 经 gRPC 上报日志（各自的 Agent 时间偏差不同），
// 通过 HTTP 下载：每行的字段、顺序与合并视图一致，跟随范围、不受级别筛选影响，只含请求那一刻已写入的内容。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	encodeRunLogScope,
	logsApi,
	RunLogDownloadRow,
	type RunLogLine,
	type RunLogScope,
	runsApi,
} from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { agentClock, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 主链 entry → spawn → z（失败重试 1 次），spawn 派发子流程「回放」sub → s（在 agent-b 上执行）。 */
const DOC = orchestration(
	[
		[{ id: "entry", kind: "entry" }, spawn("spawn"), { ...echo("z"), retries: 1 }],
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

describe("下载整次运行合并后的日志", () => {
	let cp: TestControlPlane;
	let clock: ManualClock;
	const agents: FakeAgent[] = [];

	beforeEach(() => {
		clock = new ManualClock(iso(T0));
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const setup = async (options: { retentionDays?: number; logScanBytes?: number } = {}) => {
		cp = await startTestControlPlane({ clock, leaseMs: 30 * DAY, ...options });
		const api = new ApiClient(cp);
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
		return { api, a, b, runId };
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

	const downloadPath = (runId: string, params = "") =>
		`/runs/${runId}/logs/download${params ? `?${params}` : ""}`;
	/** 一行行解析下载内容：每行都是合法的 JSON，字段恰好是契约里的（多一个少一个都不行）。 */
	const parseRows = (text: string): RunLogDownloadRow[] => {
		expect(text === "" || text.endsWith("\n"), "每行以换行结尾").toBe(true);
		return text
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => RunLogDownloadRow.strict().parse(JSON.parse(l)));
	};
	const download = async (runId: string, params = "") => {
		const res = await cp.fetch(downloadPath(runId, params));
		expect(res.status).toBe(200);
		return { res, rows: parseRows(await res.text()) };
	};
	/** 合并视图的一页（`GET /runs/:id/logs`）。 */
	const viewPage = async (runId: string, params: Record<string, string | number>) => {
		const search = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
		const res = await cp.fetch(`/runs/${runId}/logs?${search}`);
		expect(res.status, await res.clone().text()).toBe(200);
		return logsApi.runPage.response.parse(await res.json());
	};
	/** 合并视图：从最新一页往前翻到运行开始，按时间先后拼起来。 */
	const view = async (runId: string, limit: number, extra: Record<string, string> = {}) => {
		const pages: RunLogLine[][] = [];
		for (let before: string | undefined; ; ) {
			const page = await viewPage(runId, { limit, ...extra, ...(before ? { before } : {}) });
			pages.unshift(page.lines);
			if (page.reached_start) return pages.flat();
			if (pages.length > 500) throw new Error("翻不到开头");
			before = page.before;
		}
	};
	/** 下载内容里的一行对应合并视图里的哪一行：来源和内容一致。 */
	const asDownloaded = (l: RunLogLine): RunLogDownloadRow => RunLogDownloadRow.parse(l);

	/** 这个任务的日志已经写到第 n 行。 */
	const landed = (task: { taskId: string }, n: number) =>
		eventually(async () => {
			const own = logsApi.page.response.parse(
				await (await cp.fetch(`/tasks/${task.taskId}/logs?limit=1`)).json(),
			);
			expect(own.last_seq).toBe(n);
		});
	const chainIds = async (runId: string) => {
		const run = runsApi.get.response.parse(await (await cp.fetch(`/runs/${runId}`)).json());
		const main = run.chains.find((c) => c.name === null)?.id;
		const sub = run.chains.find((c) => c.name === "回放")?.id;
		if (!main || !sub) throw new Error("运行里没有主链或子流程");
		return { main, sub };
	};

	/** z 第 1 次 2 行、s 3 行、z 第 2 次 2 行，三个任务按控制面时间交错共 7 行；z 第 1 次的第二行 WARN，s 的第二行 ERROR。 */
	const basic = async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(z1, [line(a, 1, 1_000, "z1 first"), line(a, 2, 3_000, "z1 second", LogLevel.WARN)]);
		b.logs(s, [
			line(b, 1, 2_000, "s first"),
			line(b, 2, 4_000, "s second", LogLevel.ERROR),
			line(b, 3, 6_000, "s third"),
		]);
		await a.fail(z1, "boom");
		const z2 = await a.nextAssign();
		a.logs(z2, [line(a, 1, 5_000, "z2 first"), line(a, 2, 7_000, "z2 second")]);
		await landed(z1, 2);
		await landed(s, 3);
		await landed(z2, 2);
		return { runId, z1, z2, s };
	};
	const texts = (rows: Array<{ text: string }>) => rows.map((r) => r.text);
	const ALL = ["z1 first", "s first", "z1 second", "s second", "z2 first", "s third", "z2 second"];

	it("下载合并后的 JSONL：每行带两种时间和来源（任务、子流程名、节点 ID、尝试序号），顺序与合并视图相同，文件名带运行编号", async () => {
		const { runId, z1, s } = await basic();

		const { res, rows } = await download(runId);
		expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
		expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
		expect(res.headers.get("content-disposition")).toContain(`run-${runId}.log.jsonl`);
		expect(texts(rows)).toEqual(ALL);
		expect(rows[0]).toEqual({
			seq: 1,
			time: iso(T0 + 1_000),
			agent_time: iso(AGENTS["agent-a"].agentT0 + 1_000),
			source: "stdout",
			level: "info",
			text: "z1 first",
			task_id: z1.taskId,
			subflow: null,
			node_id: "z",
			attempt: 1,
		});
		expect(rows[1]).toEqual({
			seq: 1,
			time: iso(T0 + 2_000),
			agent_time: iso(AGENTS["agent-b"].agentT0 + 2_000),
			source: "stdout",
			level: "info",
			text: "s first",
			task_id: s.taskId,
			subflow: "回放",
			node_id: "s",
			attempt: 1,
		});
		expect(rows.map((r) => [r.node_id, r.attempt])).toEqual([
			["z", 1],
			["s", 1],
			["z", 1],
			["s", 1],
			["z", 2],
			["s", 1],
			["z", 2],
		]);
		expect(rows).toEqual((await view(runId, 1000)).map(asDownloaded));
	});

	/**
	 * z 第 1 次、s、z 第 2 次的大量日志：z 第 1 次每 4 毫秒一行、s 每 3 毫秒一行，z 第 2 次接在 z 第 1 次之后每 5 毫秒一行，
	 * 三个任务的时间互相交错；时间相同时主链的 z 排在子流程的 s 前面。返回按这个顺序排好的文本。
	 */
	const volume = async (counts: { z1: number; s: number; z2: number }, logScanBytes: number) => {
		const { a, b, runId } = await setup({ logScanBytes });
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		const z1At = (i: number) => 1_000 + i * 4;
		const sAt = (i: number) => 1_001 + i * 3;
		const z2At = (i: number) => 1_000 + counts.z1 * 4 + 5 + i * 5;
		const rows = (n: number, at: (i: number) => number, name: string) =>
			Array.from({ length: n }, (_, i) => ({ at: at(i), text: `${name} ${i + 1}` }));
		const z1Rows = rows(counts.z1, z1At, "z1");
		const sRows = rows(counts.s, sAt, "s");
		const z2Rows = rows(counts.z2, z2At, "z2");
		a.logs(
			z1,
			z1Rows.map((r, i) => line(a, i + 1, r.at, r.text)),
		);
		b.logs(
			s,
			sRows.map((r, i) => line(b, i + 1, r.at, r.text)),
		);
		await a.fail(z1, "boom");
		const z2 = await a.nextAssign();
		a.logs(
			z2,
			z2Rows.map((r, i) => line(a, i + 1, r.at, r.text)),
		);
		await landed(z1, counts.z1);
		await landed(s, counts.s);
		await landed(z2, counts.z2);
		const expected = [
			...z1Rows.map((r) => ({ ...r, sub: 0 })),
			...z2Rows.map((r) => ({ ...r, sub: 0 })),
			...sRows.map((r) => ({ ...r, sub: 1 })),
		]
			.sort((x, y) => x.at - y.at || x.sub - y.sub)
			.map((x) => x.text);
		return { runId, expected };
	};

	it("日志很多（超过一批）：下载与合并视图（往前翻页到开头）给出同一个顺序，也与按时间排好的结果一致", async () => {
		const { runId, expected } = await volume({ z1: 1500, s: 3500, z2: 800 }, 40_000);

		const { rows } = await download(runId);
		expect(texts(rows)).toEqual(expected);
		expect(rows).toEqual((await view(runId, 1000)).map(asDownloaded));
	});

	it("单次请求的扫描量上限小到每个任务一次只读得到一行：下载不受它限制，仍读全、顺序不变", async () => {
		const { runId, expected } = await volume({ z1: 800, s: 1000, z2: 600 }, 100);

		const { rows } = await download(runId);
		expect(texts(rows)).toEqual(expected);
	});

	it("没有控制面时间的旧行：下载时补齐成两种时间都有的格式（控制面时间为 null），与新写入的行一起按合并顺序输出", async () => {
		const { a, runId } = await setup();
		const z1 = await a.nextAssign();
		// 升级之前写入的日志文件：每行只有一个时间（当时记的是 Agent 时间）。
		const old = [
			{ seq: 1, time: "2024-05-01T00:00:01.000Z", source: "stdout", level: "info", text: "old 1" },
			{ seq: 2, time: "2024-05-01T00:00:02.000Z", source: "sdk", level: "warn", text: "old 2" },
		];
		const dir = join(cp.dataDir, "logs", runId);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, `${z1.taskId}.jsonl`),
			old.map((l) => `${JSON.stringify(l)}\n`).join(""),
		);
		a.logs(z1, [line(a, 3, 4_000, "new 3")]);
		await landed(z1, 3);

		const { rows } = await download(runId);
		const origin = { task_id: z1.taskId, subflow: null, node_id: "z", attempt: 1 };
		expect(rows).toEqual([
			{
				seq: 1,
				time: null,
				agent_time: "2024-05-01T00:00:01.000Z",
				source: "stdout",
				level: "info",
				text: "old 1",
				...origin,
			},
			{
				seq: 2,
				time: null,
				agent_time: "2024-05-01T00:00:02.000Z",
				source: "sdk",
				level: "warn",
				text: "old 2",
				...origin,
			},
			{
				seq: 3,
				time: iso(T0 + 4_000),
				agent_time: iso(AGENTS["agent-a"].agentT0 + 4_000),
				source: "stdout",
				level: "info",
				text: "new 3",
				...origin,
			},
		]);
	});

	it("范围：只下载指定节点每次尝试的日志（主链、子流程里的节点）；不给范围是全部节点，空范围是空文件", async () => {
		const { runId } = await basic();
		const { main, sub } = await chainIds(runId);
		const nodes = (scope: RunLogScope) => `nodes=${encodeURIComponent(encodeRunLogScope(scope))}`;

		const onlyZ = await download(runId, nodes([{ chain_instance_id: main, node_id: "z" }]));
		expect(texts(onlyZ.rows)).toEqual(["z1 first", "z1 second", "z2 first", "z2 second"]);
		const onlyS = await download(runId, nodes([{ chain_instance_id: sub, node_id: "s" }]));
		expect(texts(onlyS.rows)).toEqual(["s first", "s second", "s third"]);
		const both = await download(
			runId,
			nodes([
				{ chain_instance_id: sub, node_id: "s" },
				{ chain_instance_id: main, node_id: "z" },
			]),
		);
		expect(texts(both.rows)).toEqual(ALL);
		// 范围里的节点在另一条链上不存在时，不会匹配到同名的节点。
		const wrongChain = await download(runId, nodes([{ chain_instance_id: sub, node_id: "z" }]));
		expect(wrongChain.rows).toEqual([]);

		const none = await cp.fetch(downloadPath(runId, "nodes="));
		expect(none.status).toBe(200);
		expect(await none.text()).toBe("");

		for (const bad of ["nodes=no-colon", `nodes=${main}:`, `nodes=${main}:z&nodes=${main}:z`]) {
			const res = await cp.fetch(downloadPath(runId, bad));
			expect(res.status, bad).toBe(400);
			expect(await res.json(), bad).toMatchObject({ error: { code: "invalid_request" } });
		}
	});

	it("下载不受级别筛选影响：带 level 参数也是全部级别的行", async () => {
		const { runId } = await basic();
		const { rows } = await download(runId, "level=error");
		expect(texts(rows)).toEqual(ALL);
		expect(new Set(rows.map((r) => r.level))).toEqual(new Set(["info", "warn", "error"]));
		// 合并视图用同一个参数是会筛选的：下载不是漏了这个功能，而是不受它影响。
		expect(texts((await viewPage(runId, { level: "error" })).lines)).toEqual(["s second"]);
	});

	it("只包含请求那一刻已写入的内容：下载进行中才写进文件的行不在里面，再次下载才有", async () => {
		const { a, b, runId } = await setup();
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		// z 的日志文件有 10000 行、约 32 MB，远超连接两端的缓冲：客户端不读时下载会停在中途，z 的末尾还没读到。
		const rows = 10_000;
		const filler = "x".repeat(3_000);
		const rowsOfZ = Array.from({ length: rows }, (_, i) =>
			JSON.stringify({
				seq: i + 1,
				time: iso(T0 + 1_000 + i + 1),
				agent_time: iso(AGENTS["agent-a"].agentT0 + 1_000 + i + 1),
				source: "stdout",
				level: "info",
				text: `z1 ${i + 1} ${filler}`,
			}),
		);
		const dir = join(cp.dataDir, "logs", runId);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${z1.taskId}.jsonl`), `${rowsOfZ.join("\n")}\n`);
		b.logs(s, [line(b, 1, rows / 2 + 1_000, "s middle")]);
		await landed(s, 1);

		const res = await cp.fetch(downloadPath(runId));
		expect(res.status).toBe(200);
		const body = (res.body as ReadableStream<Uint8Array>).getReader();
		const chunks = [(await body.read()).value as Uint8Array];
		// 响应还没读完，z 的末尾又写进一行。
		a.logs(z1, [line(a, rows + 1, 100_000, "z1 written after the request")]);
		await landed(z1, rows + 1);
		for (let next = await body.read(); !next.done; next = await body.read()) {
			chunks.push(next.value);
		}
		const first = parseRows(Buffer.concat(chunks).toString("utf8"));
		expect(first).toHaveLength(rows + 1);
		expect(first.at(-1)?.text).toMatch(new RegExp(`^z1 ${rows} `));
		expect(first.some((r) => r.text === "z1 written after the request")).toBe(false);
		// s 的那一行按控制面时间排在 z 的第 rows / 2 行（时间相同，主链在前）之后。
		expect(first[rows / 2]?.text).toBe("s middle");

		const second = (await download(runId)).rows;
		expect(second).toHaveLength(rows + 2);
		expect(second.at(-1)?.text).toBe("z1 written after the request");
	});

	it("运行已过保留期时返回 410 expired；运行不存在时 404", async () => {
		const { api, a, b, runId } = await setup({ retentionDays: 1 });
		const z1 = await a.nextAssign();
		const s = await b.nextAssign();
		a.logs(z1, [line(a, 1, 1_000, "z1")]);
		await landed(z1, 1);
		await b.succeed(s);
		await a.succeed(z1);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		expect(texts((await download(runId)).rows)).toEqual(["z1"]);

		clock.advance(2 * DAY);
		await eventually(async () => expect((await viewPage(runId, {})).expired).toBe(true));
		const expired = await cp.fetch(downloadPath(runId));
		expect(expired.status).toBe(410);
		expect(await expired.json()).toMatchObject({ error: { code: "expired" } });

		const missing = "00000000-0000-4000-8000-000000000000";
		for (const id of [missing, "not-a-uuid"]) {
			const res = await cp.fetch(downloadPath(id));
			expect(res.status, id).toBe(404);
			expect(await res.json(), id).toMatchObject({ error: { code: "not_found" } });
		}
	});
});
