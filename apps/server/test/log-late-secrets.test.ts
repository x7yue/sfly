// 日志里早于子流程创建写下的行（#517）：日志写入时按「那一刻已知的」secret 参数打码；secret 参数声明在子流程入口上时，
// 要等那个子流程的实例创建才进入名单，在那之前写下的行里如果有后来才成为 secret 的值，文件里是原文。
// 读日志的每个出口都在读取时按这次运行此刻的 secret 值再打一遍：按任务读、按运行合并读、下载、实时推送、
// 关注项里「日志」类异常的说明。写入时已经打过码的行不受影响，没有 secret 参数的运行读出来的日志逐字不变。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LogLineView, type RunFocus, runFocusApi, runSummaryApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { publishBench, putFocusItemsOk } from "./support/focus-items.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MASK = "******";
/** 后来才成为 secret 的值：入口参数 user 不是 secret，经参数映射传给子流程 subB 的 secret 参数 k 之后才是。 */
const LATE = "alice-late-value";

/** sa 在子流程 subA 里写日志；b 结束之后 x2 才创建 subB，它的 secret 参数 k 取 user 的值。 */
const LATE_SECRET = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "user", type: "string" }] },
		{ id: "x1", kind: "async", params: {} },
		{ id: "subA", kind: "subflow_entry", name: "A", params: [] },
		{ id: "sa", kind: "package", package: "bench", node: "load" },
		{ id: "b", kind: "package", package: "bench", node: "probe" },
		{ id: "x2", kind: "async", params: { k: "${{ params.user }}" } },
		{
			id: "subB",
			kind: "subflow_entry",
			name: "B",
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
	packages: { bench: "1.0.0" },
};

/** 同样的结构，没有任何 secret 参数。 */
const NO_SECRET = {
	...LATE_SECRET,
	nodes: LATE_SECRET.nodes.map((n) =>
		n.id === "subB" ? { ...n, params: [{ name: "k", type: "string" }] } : n,
	),
};

interface RunLogLineView extends LogLineView {
	task_id: string;
}
interface Page {
	lines: LogLineView[];
}

describe("读日志时按运行此刻的 secret 值再打一遍码", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	const streams: SseClient[] = [];

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		for (const s of streams.splice(0)) s.close();
		await agent.disconnect();
		await cp.close();
	});

	const line = (seq: number, text: string, level = LogLevel.INFO) => ({
		seq: BigInt(seq),
		timeUnixMs: BigInt(Date.UTC(2026, 0, 1)),
		source: LogSource.STDOUT,
		level,
		text,
	});

	/** 触发，取到 sa 和 b 两个任务；sa 先写两行（含后来才成为 secret 的值），其中一行是 ERROR。 */
	async function startRun(document: object, items = false) {
		const id = await api.orchestrationWith(document);
		if (items) await putFocusItemsOk(api, id, [{ node_id: "sa", chart: "TPS" }]);
		const runId = await api.triggerOk(id, { user: LATE });
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
		agent.logs(sa, [
			line(1, `user ${LATE} logged in`),
			line(2, `failed for ${LATE}`, LogLevel.ERROR),
		]);
		await eventually(async () => {
			const page = await api.getJson<Page>(`/tasks/${sa.taskId}/logs`);
			expect(page.lines).toHaveLength(2);
		});
		return { id, runId, sa, b };
	}

	/** b 结束之后 x2 创建 subB（它的 secret 参数 k 取 user 的值）；再写一行，这一行写入时就按新的名单打码。 */
	async function createLateSubflow(runId: string, sa: AssignedTask, b: AssignedTask) {
		await agent.succeed(b);
		await eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);
		agent.logs(sa, [line(3, `again ${LATE}`)]);
		await eventually(async () => {
			const page = await api.getJson<Page>(`/tasks/${sa.taskId}/logs`);
			expect(page.lines).toHaveLength(3);
		});
	}

	const texts = (lines: ReadonlyArray<{ text: string }>) => lines.map((l) => l.text);
	const jsonl = (body: string) =>
		body
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as RunLogLineView);
	/** 流里已经收到的日志行（按序号去重）。 */
	const collect = (sse: SseClient): LogLineView[] => {
		const bySeq = new Map<number, LogLineView>();
		for (const e of sse.received) {
			if (e.event !== "logs") continue;
			for (const l of (e.data as { lines: LogLineView[] }).lines) bySeq.set(l.seq, l);
		}
		return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
	};
	const expectedTexts = [`user ${MASK} logged in`, `failed for ${MASK}`, `again ${MASK}`];

	it("文件里确实留着早于子流程创建写下的原文（这样才是在读取时打的码）", async () => {
		const { runId, sa, b } = await startRun(LATE_SECRET);
		await createLateSubflow(runId, sa, b);
		const files = (
			await readdir(join(cp.dataDir, "logs"), { recursive: true, withFileTypes: true })
		)
			.filter((e) => e.isFile())
			.map((e) => join(e.parentPath, e.name));
		const stored = (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
		expect(stored).toContain(`user ${LATE} logged in`);
		expect(stored).toContain(`again ${MASK}`);
	});

	it("按任务读（分页、按时刻定位）和下载：早于子流程创建写下的行也是掩码，写入时打过码的行不变", async () => {
		const { runId, sa, b } = await startRun(LATE_SECRET);
		await createLateSubflow(runId, sa, b);

		const page = await api.getJson<Page & { locate: unknown }>(`/tasks/${sa.taskId}/logs`);
		expect(texts(page.lines)).toEqual(expectedTexts);
		const located = await api.getJson<Page>(
			`/tasks/${sa.taskId}/logs?at=${encodeURIComponent("2026-01-01T00:00:00.000Z")}`,
		);
		expect(texts(located.lines)).toEqual(expectedTexts);
		const earlier = await api.getJson<Page>(`/tasks/${sa.taskId}/logs?limit=1`);
		expect(texts(earlier.lines)).toEqual([`again ${MASK}`]);
		const filtered = await api.getJson<Page>(`/tasks/${sa.taskId}/logs?level=error`);
		expect(texts(filtered.lines)).toEqual([`failed for ${MASK}`]);

		const download = await (await cp.fetch(`/tasks/${sa.taskId}/logs/download`)).text();
		expect(download).not.toContain(LATE);
		expect(texts(jsonl(download))).toEqual(expectedTexts);
	});

	it("按运行合并读（分页、下载）：同样是掩码", async () => {
		const { runId, sa, b } = await startRun(LATE_SECRET);
		await createLateSubflow(runId, sa, b);

		const merged = await api.getJson<{ lines: LogLineView[] }>(`/runs/${runId}/logs`);
		expect(texts(merged.lines)).toEqual(expectedTexts);
		const forward = await api.getJson<{ lines: LogLineView[] }>(`/runs/${runId}/logs?limit=2`);
		expect(JSON.stringify(forward)).not.toContain(LATE);
		const download = await (await cp.fetch(`/runs/${runId}/logs/download`)).text();
		expect(download).not.toContain(LATE);
		expect(texts(jsonl(download))).toEqual(expectedTexts);
	});

	it("实时推送：连上时补发的文件尾部（按任务）和已经写入的行（按运行）都是掩码；之后新写的行也是", async () => {
		const { runId, sa, b } = await startRun(LATE_SECRET);
		await createLateSubflow(runId, sa, b);

		const byTask = await SseClient.open(cp, `/tasks/${sa.taskId}/logs/events`);
		const byRun = await SseClient.open(cp, `/runs/${runId}/logs/events`);
		streams.push(byTask, byRun);
		await eventually(() => {
			expect(collect(byTask)).toHaveLength(3);
			expect(collect(byRun)).toHaveLength(3);
		});
		expect(texts(collect(byTask))).toEqual(expectedTexts);
		expect(texts(collect(byRun))).toEqual(expectedTexts);

		agent.logs(sa, [line(4, `live ${LATE}`)]);
		await eventually(() => {
			expect(collect(byTask)).toHaveLength(4);
			expect(collect(byRun)).toHaveLength(4);
		});
		expect(collect(byTask).at(-1)?.text).toBe(`live ${MASK}`);
		expect(collect(byRun).at(-1)?.text).toBe(`live ${MASK}`);
		expect(JSON.stringify([byTask.received, byRun.received])).not.toContain(LATE);
	});

	it("运行摘要里失败的任务的日志尾部（#510）：早于子流程创建写下的行也是掩码，和其他读日志的出口同一个口径", async () => {
		const { runId, sa, b } = await startRun(LATE_SECRET);
		await createLateSubflow(runId, sa, b);
		await agent.fail(sa, `boom ${LATE}`);
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));

		const body = await (await cp.fetch(`/runs/${runId}/summary`)).text();
		expect(body).not.toContain(LATE);
		const report = runSummaryApi.summary.response.parse(JSON.parse(body));
		const failed = report.failed_tasks.find((task) => task.node_id === "sa");
		expect(failed?.error?.detail).toBe(`boom ${MASK}`);
		// 日志尾部读的是文件：早于子流程创建写下的两行也已经是掩码，和下面按任务读的结果一样。
		expect(texts(failed?.logs?.lines ?? [])).toEqual(expectedTexts);
	});

	it("关注项里「日志」类异常的说明文字：取自最近一条 ERROR，读取时按此刻的 secret 值打码", async () => {
		const { runId, sa, b } = await startRun(LATE_SECRET, true);
		await createLateSubflow(runId, sa, b);

		const res = await cp.fetch(`/runs/${runId}/focus`);
		const text = await res.text();
		expect(res.status, text).toBe(200);
		expect(text).not.toContain(LATE);
		const focus: RunFocus = runFocusApi.focus.response.parse(JSON.parse(text));
		expect(focus.items[0]?.anomaly).toMatchObject({
			kind: "log",
			level: "error",
			message: `failed for ${MASK}`,
		});
	});

	it("没有 secret 参数的运行：读出来的日志和文件里逐字相同（下载是文件的原样，分页是同样的行）", async () => {
		const { runId, sa, b } = await startRun(NO_SECRET);
		await agent.succeed(b);
		await eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);
		const file = (await readdir(join(cp.dataDir, "logs", runId), { withFileTypes: true })).find(
			(e) => e.name.startsWith(sa.taskId),
		);
		const stored = await readFile(join(cp.dataDir, "logs", runId, file?.name ?? ""), "utf8");
		expect(stored).toContain(`user ${LATE} logged in`);
		expect(await (await cp.fetch(`/tasks/${sa.taskId}/logs/download`)).text()).toBe(stored);
		const page = await api.getJson<Page>(`/tasks/${sa.taskId}/logs`);
		expect(texts(page.lines)).toEqual([`user ${LATE} logged in`, `failed for ${LATE}`]);
		const merged = await api.getJson<{ lines: LogLineView[] }>(`/runs/${runId}/logs`);
		expect(texts(merged.lines)).toEqual([`user ${LATE} logged in`, `failed for ${LATE}`]);
	});
});
