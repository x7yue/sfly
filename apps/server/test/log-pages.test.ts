// 切入点 A：完整日志（#18）。假 Agent 经 gRPC 上报日志，通过 HTTP 按偏移量分页读取、筛选、下载原始文件，
// 以及单个任务的日志上限（超出截断并写入截断标记）。
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent, LogLevel, LogSource } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface PagedLine {
	offset: number;
	seq: number;
	time: string;
	source: string;
	level: string;
	text: string;
}

interface LogPage {
	task_id: string;
	lines: PagedLine[];
	/** 本页扫描范围的起止字节偏移：往前翻用 `before=start`，往后翻用 `after=end`。 */
	start: number;
	end: number;
	/** 读取时日志文件的大小。 */
	size: number;
	last_seq: number;
	truncated: boolean;
	expired: boolean;
}

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

const LEVELS = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
const SOURCES = [LogSource.STDOUT, LogSource.STDERR, LogSource.SDK];

/** 第 n 行（从 1 开始）：级别按 debug/info/warn/error 轮换，来源按 stdout/stderr/sdk 轮换。 */
const line = (n: number) => ({
	seq: BigInt(n),
	timeUnixMs: BigInt(Date.UTC(2026, 0, 1, 0, 0, n)),
	level: LEVELS[(n - 1) % 4],
	source: SOURCES[(n - 1) % 3],
	text: `第 ${n} 行`,
});

describe("完整日志", () => {
	let cp: TestControlPlane;
	const agents: FakeAgent[] = [];
	const streams: SseClient[] = [];

	afterEach(async () => {
		for (const s of streams.splice(0)) s.close();
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const setup = async (options: { logLimitBytes?: number } = {}) => {
		cp = await startTestControlPlane(options);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(agent);
		const api = new ApiClient(cp);
		const runId = await api.triggerOk(await api.orchestrationWith(DOC));
		const task = await agent.nextAssign();
		return { agent, task, runId, api };
	};

	const page = async (taskId: string, query = ""): Promise<LogPage> => {
		const res = await cp.fetch(`/tasks/${taskId}/logs${query ? `?${query}` : ""}`);
		expect(res.status).toBe(200);
		return (await res.json()) as LogPage;
	};

	/** 发送 1..n 行，等它们都写进日志文件。 */
	const write = async (agent: FakeAgent, task: AssignedTask, n: number, from = 1) => {
		for (let i = from; i <= n; i += 50) {
			const batch = [];
			for (let j = i; j < i + 50 && j <= n; j++) batch.push(line(j));
			agent.logs(task, batch);
		}
		await eventually(async () => expect((await page(task.taskId)).last_seq).toBe(n));
	};

	it("默认读取尾部；用 before=start 往前翻页直到开头，每行带自己的字节偏移", async () => {
		const { agent, task } = await setup();
		await write(agent, task, 120);

		const tail = await page(task.taskId, "limit=50");
		expect(tail.lines.map((l) => l.seq)).toEqual(range(71, 120));
		expect(tail.lines[0]).toMatchObject({
			seq: 71,
			time: "2026-01-01T00:01:11.000Z",
			level: "warn",
			source: "stderr",
			text: "第 71 行",
		});
		expect(tail.end).toBe(tail.size);
		expect(tail.start).toBe(tail.lines[0]?.offset);
		expect(tail.truncated).toBe(false);
		expect(tail.expired).toBe(false);

		const older = await page(task.taskId, `limit=50&before=${tail.start}`);
		expect(older.lines.map((l) => l.seq)).toEqual(range(21, 70));
		expect(older.end).toBe(tail.start);
		const oldest = await page(task.taskId, `limit=50&before=${older.start}`);
		expect(oldest.lines.map((l) => l.seq)).toEqual(range(1, 20));
		expect(oldest.start).toBe(0);
		expect(oldest.lines[0]?.offset).toBe(0);
	});

	it("用 after=offset 从任意行首往后读；偏移不在行首时从下一行开始", async () => {
		const { agent, task } = await setup();
		await write(agent, task, 30);
		const all = await page(task.taskId, "limit=1000");
		const tenth = all.lines[9] as PagedLine;

		const forward = await page(task.taskId, `after=${tenth.offset}&limit=5`);
		expect(forward.lines.map((l) => l.seq)).toEqual([10, 11, 12, 13, 14]);
		expect(forward.start).toBe(tenth.offset);
		expect(forward.end).toBe(all.lines[14]?.offset);

		const next = await page(task.taskId, `after=${forward.end}&limit=100`);
		expect(next.lines.map((l) => l.seq)).toEqual(range(15, 30));
		expect(next.end).toBe(next.size);

		const misaligned = await page(task.taskId, `after=${tenth.offset + 3}&limit=2`);
		expect(misaligned.lines.map((l) => l.seq)).toEqual([11, 12]);
	});

	it("按级别和来源筛选：只返回匹配的行，翻页时跳过不匹配的行", async () => {
		const { agent, task } = await setup();
		await write(agent, task, 60);

		const errors = await page(task.taskId, "level=error&limit=5");
		// error 是第 4、8、12… 行。
		expect(errors.lines.map((l) => l.seq)).toEqual([40, 44, 48, 52, 56, 60].slice(-5));
		const earlier = await page(task.taskId, `level=error&limit=100&before=${errors.start}`);
		expect(earlier.lines.map((l) => l.seq)).toEqual([4, 8, 12, 16, 20, 24, 28, 32, 36, 40]);
		expect(earlier.start).toBe(0);

		const mixed = await page(task.taskId, "level=warn,error&source=sdk&limit=100");
		// sdk 是第 3、6、9… 行；其中 warn（3 mod 4）或 error（0 mod 4）。
		expect(mixed.lines.map((l) => l.seq)).toEqual(
			range(1, 60).filter((n) => n % 3 === 0 && (n % 4 === 3 || n % 4 === 0)),
		);

		const bad = await cp.fetch(`/tasks/${task.taskId}/logs?level=fatal`);
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_query");
	});

	it("先读历史再用 after_seq 接上实时流：不重复也不遗漏", async () => {
		const { agent, task } = await setup();
		await write(agent, task, 10);
		const tail = await page(task.taskId, "limit=5");
		expect(tail.last_seq).toBe(10);

		agent.logs(task, [line(11)]);
		await eventually(async () => expect((await page(task.taskId)).last_seq).toBe(11));
		const sse = await SseClient.open(
			cp,
			`/tasks/${task.taskId}/logs/events?after_seq=${tail.last_seq}`,
		);
		streams.push(sse);
		const snapshot = await sse.next<{ lines: Array<{ seq: number }> }>("logs");
		expect(snapshot.data.lines.map((l) => l.seq)).toEqual([11]);
		agent.logs(task, [line(12)]);
		const live = await sse.next<{ lines: Array<{ seq: number }> }>("logs");
		expect(live.data.lines.map((l) => l.seq)).toEqual([12]);
	});

	it("可以下载原始日志文件（JSONL，每行一条）", async () => {
		const { agent, task } = await setup();
		await write(agent, task, 3);

		const res = await cp.fetch(`/tasks/${task.taskId}/logs/download`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
		expect(res.headers.get("content-disposition")).toContain("a-1.log.jsonl");
		const text = await res.text();
		const rows = text
			.trimEnd()
			.split("\n")
			.map((l) => JSON.parse(l) as { seq: number; text: string });
		expect(rows.map((r) => [r.seq, r.text])).toEqual([
			[1, "第 1 行"],
			[2, "第 2 行"],
			[3, "第 3 行"],
		]);
	});

	it("还没有日志的任务：空页、下载得到空文件；任务不存在时 404", async () => {
		const { task } = await setup();
		const empty = await page(task.taskId);
		expect(empty).toMatchObject({ lines: [], start: 0, end: 0, size: 0, last_seq: 0 });
		const res = await cp.fetch(`/tasks/${task.taskId}/logs/download`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");

		const missing = "00000000-0000-4000-8000-000000000000";
		expect((await cp.fetch(`/tasks/${missing}/logs`)).status).toBe(404);
		expect((await cp.fetch(`/tasks/${missing}/logs/download`)).status).toBe(404);
		expect((await cp.fetch("/tasks/not-a-uuid/logs")).status).toBe(404);
	});

	it("单个任务的日志超过上限时截断：写入一行截断标记，之后的行被丢弃", async () => {
		// 上限调小：每行约 100 字节，2000 字节大约能写 20 行。
		const { agent, task } = await setup({ logLimitBytes: 2000 });
		for (let i = 1; i <= 100; i += 10) agent.logs(task, range(i, i + 9).map(line));
		await eventually(async () => expect((await page(task.taskId)).truncated).toBe(true));
		// 截断之后再来的行也被丢弃。
		agent.logs(task, [line(101)]);
		await new Promise((r) => setTimeout(r, 100));

		const all = await page(task.taskId, "limit=1000");
		const marker = all.lines.at(-1) as PagedLine;
		expect(marker).toMatchObject({ source: "system", level: "warn" });
		expect(marker.text).toContain("截断");
		const kept = all.lines.slice(0, -1);
		expect(kept.map((l) => l.seq)).toEqual(range(1, kept.length));
		expect(kept.length).toBeGreaterThan(10);
		expect(marker.seq).toBe(kept.length + 1);
		expect(all.size).toBeLessThanOrEqual(2000 + 300);
		expect(all.last_seq).toBe(marker.seq);

		// 控制面重启后仍然认为已截断，不再写入。
		await cp.restart();
		agents.splice(0).forEach((a) => void a.disconnect());
		const again = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(again);
		again.logs(task, [line(200)]);
		await new Promise((r) => setTimeout(r, 100));
		const after = await page(task.taskId, "limit=1000");
		expect(after.truncated).toBe(true);
		expect(after.lines.length).toBe(all.lines.length);
	});

	it("截断标记也推送到实时流", async () => {
		const { agent, task } = await setup({ logLimitBytes: 500 });
		const sse = await SseClient.open(cp, `/tasks/${task.taskId}/logs/events`);
		streams.push(sse);
		await sse.next("logs");
		agent.logs(task, range(1, 20).map(line));
		const event = await sse.next<{ lines: Array<{ source: string; text: string }> }>("logs");
		expect(event.data.lines.at(-1)).toMatchObject({ source: "system" });
	});
});

function range(from: number, to: number): number[] {
	return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
