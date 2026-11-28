// 日志里早于子流程创建写下的行（#517）：日志写入时按「那一刻已知的」secret 参数打码；secret 参数声明在子流程入口上时，
// 要等那个子流程的实例创建才进入名单，在那之前写下的行里如果有后来才成为 secret 的值，文件里是原文。
// 读日志的每个出口都在读取时按这次运行此刻的 secret 值再打一遍：按任务读、按运行合并读、下载、实时推送、
// 关注项里「日志」类异常的说明。写入时已经打过码的行不受影响，没有 secret 参数的运行读出来的日志逐字不变。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type LogLineView, type RunFocus, runFocusApi, runSummaryApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OVERSIZE_NOTICE, secretSetOf } from "../src/logs/secrets.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { publishBench, putFocusItemsOk } from "./support/focus-items.js";
import { formsOf } from "./support/secret-forms.js";
import { withSecretLimits } from "./support/secret-limits.js";
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
const texts = (lines: ReadonlyArray<{ text: string }>) => lines.map((l) => l.text);
const jsonl = (body: string) =>
	body
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as RunLogLineView);
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

	describe("关注项里「日志」类异常的说明（上限 500 个字符）：打不打码只看完整的出现（#517）", () => {
		const limit = 500;
		const filler = (n: number) => "e".repeat(n);
		const partials = [LATE.slice(0, 1), LATE.slice(0, 6), LATE.slice(0, LATE.length - 1)];

		/** 触发；sa 写下的 ERROR 行都到了说明的上限；写入时 LATE 还不是 secret 值，库里和文件里是原文。 */
		async function start() {
			const run = await startRun(LATE_SECRET, true);
			let seq = 3;
			const writeError = async (text: string) => {
				agent.logs(run.sa, [line(seq, text, LogLevel.ERROR)]);
				seq += 1;
				await eventually(async () => {
					const page = await api.getJson<Page>(`/tasks/${run.sa.taskId}/logs`);
					expect(page.lines).toHaveLength(seq - 1);
				});
			};
			const createSubflow = async () => {
				await agent.succeed(run.b);
				await eventually(async () =>
					expect((await api.run(run.runId)).chains.map((c) => c.chain_id)).toContain("subB"),
				);
			};
			const message = async () => {
				const res = await cp.fetch(`/runs/${run.runId}/focus`);
				const text = await res.text();
				expect(res.status, text).toBe(200);
				return runFocusApi.focus.response.parse(JSON.parse(text)).items[0]?.anomaly?.message;
			};
			return { writeError, createSubflow, message };
		}

		it("最近一条 ERROR 的结尾是完整的值（写入时还不是 secret 值）：读取时盖住", async () => {
			const { writeError, createSubflow, message } = await start();
			await writeError(`${filler(limit - LATE.length)}${LATE}`);
			await createSubflow();
			await eventually(async () =>
				expect(await message()).toBe(`${filler(limit - LATE.length)}${MASK}`),
			);
		});

		it("结尾是值的前缀（半截）：读取时原样，没有掩码，也没有别的变化；不论是创建子流程之前还是之后写下的", async () => {
			const { writeError, createSubflow, message } = await start();
			const text = (part: string) => `${filler(limit - part.length)}${part}`;
			const longest = partials.at(-1) as string;
			await writeError(text(longest));
			await createSubflow();
			await eventually(async () => expect(await message()).toBe(text(longest)));
			for (const part of partials) {
				await writeError(text(part));
				await eventually(async () => expect(await message()).toBe(text(part)));
			}
		});
	});

	it("后来才成为 secret 的值用各种写法写进日志（#517）：任务日志下载、按页读、按运行下载读出来的每一行，和写入时打码的结果逐条相同", async () => {
		// 一个值里有非 ASCII、引号、反斜杠、制表符：Python 的 json.dumps 默认写法（\uXXXX）、JSON 的转义写法写进文件时又转义了一层
		const value = 'FAKE口令"q\\p\tz';
		const set = secretSetOf([value]);
		const id = await api.orchestrationWith(LATE_SECRET);
		const runId = await api.triggerOk(id, { user: value });
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
		const forms = formsOf(value);
		expect(forms.length).toBeGreaterThanOrEqual(5);
		const written = forms.map((form) => `before ${form} after`);
		agent.logs(
			sa,
			written.map((text, i) => line(i + 1, text)),
		);
		await eventually(async () => {
			const page = await api.getJson<Page>(`/tasks/${sa.taskId}/logs?limit=1000`);
			expect(page.lines).toHaveLength(written.length);
		});
		await agent.succeed(b);
		await eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);

		// 写入时就知道这个值的话，每一行会被打成这样
		const expected = written.map((text) => set.mask(text));
		expect(expected.filter((text, i) => text !== written[i]).length).toBeGreaterThanOrEqual(5);
		const page = await api.getJson<Page>(`/tasks/${sa.taskId}/logs?limit=1000`);
		expect(texts(page.lines)).toEqual(expected);
		const download = await (await cp.fetch(`/tasks/${sa.taskId}/logs/download`)).text();
		expect(texts(jsonl(download))).toEqual(expected);
		const merged = await (await cp.fetch(`/runs/${runId}/logs/download`)).text();
		expect(texts(jsonl(merged))).toEqual(expected);
		const mergedPage = await api.getJson<{ lines: LogLineView[] }>(
			`/runs/${runId}/logs?limit=1000`,
		);
		expect(texts(mergedPage.lines)).toEqual(expected);
	});

	it("下载按块、按批读：一块（按任务）、一批（按运行）里的长行用光预算（完整的出现太多），每一块、每一批一份新的预算，后面的行不会因为前面用掉了预算被整行盖住（#517）", async () => {
		const id = await api.orchestrationWith(LATE_SECRET);
		const runId = await api.triggerOk(id, { user: LATE });
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
		// 读取预算调成 800 段：6 行各有 900 处完整的出现，一行就用光；后面 1500 行各一处（约 250 KB，按任务下载要读好几块，每块几百行，
		// 按运行下载一批 1000 行，要读两批），一块、一批里加起来不到 800 段；写入时 LATE 还不是 secret 值，文件里是原文
		const long = `${LATE} `.repeat(900);
		const letters = (i: number) =>
			i.toString(26).replace(/\d/g, (d) => "qrstuvwxyz"[Number(d)] ?? d);
		const tail = Array.from({ length: 1500 }, (_, i) => `${LATE} line ${letters(i)}`);
		agent.logs(sa, [
			...Array.from({ length: 6 }, (_, i) => line(i + 1, long)),
			...tail.map((text, i) => line(i + 7, text)),
		]);
		await eventually(async () => {
			const page = await api.getJson<Page & { last_seq: number }>(
				`/tasks/${sa.taskId}/logs?limit=1`,
			);
			expect(page.last_seq).toBe(1506);
		});
		await agent.succeed(b);
		await eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);

		await withSecretLimits({ readMasks: 800 }, async () => {
			for (const path of [`/tasks/${sa.taskId}/logs/download`, `/runs/${runId}/logs/download`]) {
				const rows = texts(jsonl(await (await cp.fetch(path)).text()));
				expect(rows, path).toHaveLength(1506);
				// 长行都整行盖住（超过预算）；整个下载共用一份预算的话，前面就把它用光，后面的行也都被整行盖住。每一块、每一批各一份，后面的行只盖 secret 值
				expect(rows.slice(0, 6), path).toEqual(Array(6).fill(MASK));
				expect(rows.slice(-400), path).toEqual(tail.slice(-400).map((t) => t.replace(LATE, MASK)));
			}
			// 按页读（最近 100 行）：一页一份预算，后面的行只盖 secret 值
			const page = await api.getJson<Page>(`/tasks/${sa.taskId}/logs?limit=100`);
			expect(texts(page.lines)).toEqual(tail.slice(-100).map((t) => t.replace(LATE, MASK)));
			// 没有完整出现的行不花预算，再多也原样：这一页的预算是 800，读 1000 行没有 secret 值的行不受影响（见 log-mask 的用例）
		});
	}, 90_000);

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

describe("值集合太大的运行：任务日志里有一行平台写的说明，其余的文字整段盖住（#517）", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const line = (seq: number, text: string) => ({
		seq: BigInt(seq),
		timeUnixMs: BigInt(Date.UTC(2026, 0, 1)),
		source: LogSource.STDOUT,
		level: LogLevel.INFO,
		text,
	});

	it("总长超过上限的 secret 参数：第一批写入时在最前面写一行说明（系统写的 WARN，不含值），每个任务一行；读出来（分页、下载、按运行合并读）说明原样，其余整段是掩码", async () => {
		// 触发时值集合已经太大会被拒绝（#632）：先触发，再把上限调小，和值集合在运行中才变大是同一个状态
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "cfg", type: "json", secret: true }] },
				{ id: "sa", kind: "package", package: "bench", node: "load" },
			],
			edges: [{ from: "entry", to: "sa", kind: "chain" }],
			packages: { bench: "1.0.0" },
		});
		const values = Array.from({ length: 20 }, (_, i) => `fake-oversize-${i}-${"p".repeat(40)}`);
		const runId = await api.triggerOk(id, { cfg: values });
		await withSecretLimits({ automatonChars: 300 }, async () => {
			const task = await agent.nextAssign();
			agent.logs(task, [line(1, "first line"), line(2, `uses ${values[3]} here`)]);
			await eventually(async () => {
				const page = await api.getJson<Page>(`/tasks/${task.taskId}/logs`);
				expect(page.lines).toHaveLength(3);
			});
			// 第二批：不再写说明
			agent.logs(task, [line(3, "third line")]);
			await eventually(async () => {
				const page = await api.getJson<Page>(`/tasks/${task.taskId}/logs`);
				expect(page.lines).toHaveLength(4);
			});

			const expected = [OVERSIZE_NOTICE, MASK, MASK, MASK];
			const page = await api.getJson<Page>(`/tasks/${task.taskId}/logs`);
			expect(texts(page.lines)).toEqual(expected);
			expect(page.lines[0]).toMatchObject({ source: "system", level: "warn" });
			expect(page.lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
			const download = await (await cp.fetch(`/tasks/${task.taskId}/logs/download`)).text();
			expect(texts(jsonl(download))).toEqual(expected);
			const merged = await (await cp.fetch(`/runs/${runId}/logs/download`)).text();
			expect(texts(jsonl(merged))).toEqual(expected);
			const mergedPage = await api.getJson<{ lines: LogLineView[] }>(`/runs/${runId}/logs`);
			expect(texts(mergedPage.lines)).toEqual(expected);
			// 说明里没有值
			expect(download).not.toContain("fake-oversize");
		});
	}, 60_000);

	it("说明那一行的时间取这一批第一行的时间：Agent 攒着发、这一批的行比收到时早好几秒，文件里的时间也不倒着走", async () => {
		await agent.disconnect();
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
		// 触发时值集合已经太大会被拒绝（#632）：先触发，再把上限调小，和值集合在运行中才变大是同一个状态
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "cfg", type: "json", secret: true }] },
				{ id: "sa", kind: "package", package: "bench", node: "load" },
			],
			edges: [{ from: "entry", to: "sa", kind: "chain" }],
			packages: { bench: "1.0.0" },
		});
		const values = Array.from({ length: 20 }, (_, i) => `fake-oversize-${i}-${"p".repeat(40)}`);
		await api.triggerOk(id, { cfg: values });
		await withSecretLimits({ automatonChars: 300 }, async () => {
			const task = await agent.nextAssign();
			const now = cp.clock.now().getTime();
			const old = (seq: number, agoMs: number) => ({
				...line(seq, `line ${seq}`),
				timeUnixMs: BigInt(now - agoMs),
				monotonicMs: agent.monotonicAt(now - agoMs),
			});
			agent.logs(task, [old(1, 5000), old(2, 4000), old(3, 1000)]);
			await eventually(async () => {
				const page = await api.getJson<Page>(`/tasks/${task.taskId}/logs`);
				expect(page.lines).toHaveLength(4);
			});
			const page = await api.getJson<Page>(`/tasks/${task.taskId}/logs`);
			expect(texts(page.lines)).toEqual([OVERSIZE_NOTICE, MASK, MASK, MASK]);
			const times = page.lines.map((l) => Date.parse(l.time ?? ""));
			expect(times).toEqual([now - 5000, now - 5000, now - 4000, now - 1000]);
		});
	}, 60_000);

	it("说明的时间取第一条真正写入的行：值集合后来才变大，这一批以重发的旧行开头，说明的时间也不倒退，这一批没有要写入的行时不写说明（#657）", async () => {
		await agent.disconnect();
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
		// 触发时值集合已经太大会被拒绝（#632）：先触发，再把上限调小，和值集合在运行中才变大是同一个状态
		// 子流程 subB 的 secret 参数 k 取 user 的值：值本身要写出很多种写法（原样、转义、\uXXXX），合计超过 300 个字符才算太大
		const big = "é".repeat(150);
		const id = await api.orchestrationWith(LATE_SECRET);
		const runId = await api.triggerOk(id, { user: big });
		await withSecretLimits({ automatonChars: 300 }, async () => {
			const first = await agent.nextAssign();
			const second = await agent.nextAssign();
			const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
			const now = cp.clock.now().getTime();
			const at = (seq: number, agoMs: number, text: string) => ({
				...line(seq, text),
				timeUnixMs: BigInt(now - agoMs),
				monotonicMs: agent.monotonicAt(now - agoMs),
			});
			const pageOf = () => api.getJson<Page>(`/tasks/${sa.taskId}/logs`);
			agent.logs(sa, [at(1, 4000, "first"), at(2, 3000, "second")]);
			await eventually(async () => expect((await pageOf()).lines).toHaveLength(2));
			// 值集合现在才变大（子流程创建之后）
			await agent.succeed(b);
			await eventually(async () =>
				expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
			);
			// 只有重发的旧行（序号不大于已写入的）：没有要写入的行，不写说明，文件不变（先等这一批处理完，再查）
			agent.logs(sa, [at(2, 20_000, "second")]);
			await agent.sync();
			const unchanged = await pageOf();
			expect(texts(unchanged.lines)).toEqual([MASK, MASK]);
			expect(unchanged.lines.map((l) => l.seq)).toEqual([1, 2]);
			// 重发的旧行开头（时间比文件里最后一行早得多）、后面是新行：说明取新行的时间
			agent.logs(sa, [at(2, 20_000, "second"), at(3, 1000, "third")]);
			await eventually(async () => expect((await pageOf()).lines).toHaveLength(4));
			const page = await pageOf();
			expect(texts(page.lines)).toEqual([MASK, MASK, OVERSIZE_NOTICE, MASK]);
			const times = page.lines.map((l) => Date.parse(l.time ?? ""));
			expect(times).toEqual([now - 4000, now - 3000, now - 1000, now - 1000]);
			expect(times).toEqual([...times].sort((x, y) => x - y));
		});
	}, 60_000);
});
