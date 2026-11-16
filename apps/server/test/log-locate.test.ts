// 切入点 A：任务日志按时刻定位（#347）。假 Agent 经 gRPC 上报日志，控制面用手动时钟，通过 HTTP
// `GET /tasks/:id/logs?at=<控制面时间>` 观察：返回包含那一刻的一页，写明有没有正好对应的那一行；
// 从这一页用 before / after 接着翻页。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logsApi } from "@sfly/schema";
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
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const AGENT_T0 = Date.parse("2027-09-06T00:00:00.000Z");
/** Agent 连上时的单调时钟读数。 */
const M0 = 5_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("任务日志按时刻定位", () => {
	let cp: TestControlPlane;
	let agent: FakeAgent;
	let task: AssignedTask;
	let runId: string;

	beforeEach(async () => {
		const clock = new ManualClock(iso(T0));
		cp = await startTestControlPlane({ clock });
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, {
			name: "agent-a",
			...agentClock(AGENT_T0, M0),
		});
		const api = new ApiClient(cp);
		runId = await api.triggerOk(await api.orchestrationWith(DOC));
		task = await agent.nextAssign();
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 控制面时间为 T0 之后 afterMs 毫秒的一行；Agent 时间原样给定（默认与控制面时间无关）。 */
	const lineAt = (
		seq: number,
		afterMs: number,
		extra: { agentTimeMs?: number; level?: LogLevel; text?: string } = {},
	) => ({
		seq: BigInt(seq),
		timeUnixMs: BigInt(extra.agentTimeMs ?? AGENT_T0 + afterMs),
		monotonicMs: BigInt(M0 + afterMs),
		source: LogSource.STDOUT,
		level: extra.level ?? LogLevel.INFO,
		text: extra.text ?? `第 ${seq} 行`,
	});

	const fetchPage = (query: string) => cp.fetch(`/tasks/${task.taskId}/logs?${query}`);
	const page = async (query: string) => {
		const res = await fetchPage(query);
		expect(res.status).toBe(200);
		return logsApi.page.response.parse(await res.json());
	};
	const seqs = (p: { lines: { seq: number }[] }) => p.lines.map((l) => l.seq);
	const range = (from: number, to: number) =>
		Array.from({ length: to - from + 1 }, (_, i) => from + i);

	/** 写入这些行，等它们都进了日志文件。 */
	const write = async (lines: ReturnType<typeof lineAt>[]) => {
		agent.logs(task, lines);
		const last = Number(lines.at(-1)?.seq);
		await eventually(async () => expect((await page("limit=1")).last_seq).toBe(last));
	};

	/** 第 1 到 n 行，第 k 行在控制面时间 T0 之后 k × 10 秒。 */
	const everyTenSeconds = (n: number) => write(range(1, n).map((k) => lineAt(k, k * 10_000)));

	it("那一刻正好有一行（50 毫秒以内只有这一行）：返回包含它的一页，写明是哪一行，那一刻的位置在它之前或之后的第一行", async () => {
		await everyTenSeconds(100);
		const all = await page("limit=1000");
		const offsetOf = (seq: number) => all.lines.find((l) => l.seq === seq)?.offset;

		// 第 50 行之后 40 毫秒：那一刻落在第 50、51 行之间。
		const after = await page(`limit=20&at=${iso(T0 + 500_040)}`);
		expect(after.locate).toEqual({ at_offset: offsetOf(51), exact_seq: 50 });
		expect(seqs(after)).toEqual(range(41, 60));
		expect(after.start).toBe(offsetOf(41));
		expect(after.end).toBe(offsetOf(61));

		// 第 50 行之前 40 毫秒：那一刻落在第 49、50 行之间。
		const before = await page(`limit=20&at=${iso(T0 + 499_960)}`);
		expect(before.locate).toEqual({ at_offset: offsetOf(50), exact_seq: 50 });
		expect(seqs(before)).toEqual(range(40, 59));

		// 正好是第 50 行的时间。
		const same = await page(`limit=20&at=${iso(T0 + 500_000)}`);
		expect(same.locate).toEqual({ at_offset: offsetOf(50), exact_seq: 50 });
	});

	it("日志远大于一次读取的块、中间还夹着一行比块还长的：每一行都能按它的时间定位到", async () => {
		const filler = "x".repeat(700);
		const long = "y".repeat(150_000);
		// 第 k 行在第 k × 10 秒；第 700 行有 15 万个字符。
		const all = range(1, 1500).map((k) =>
			lineAt(k, k * 10_000, { text: k === 700 ? long : `第 ${k} 行 ${filler}` }),
		);
		for (let i = 0; i < all.length; i += 100) agent.logs(task, all.slice(i, i + 100));
		await eventually(async () => expect((await page("limit=1")).last_seq).toBe(1500), 20_000);

		for (const k of [1, 2, 399, 400, 699, 700, 701, 1000, 1499, 1500]) {
			const exact = await page(`limit=7&at=${iso(T0 + k * 10_000)}`);
			expect(exact.locate?.exact_seq, `第 ${k} 行`).toBe(k);
			const seqsAround = seqs(exact);
			expect(seqsAround).toContain(k);
			expect(seqsAround, `第 ${k} 行所在的一页连续`).toEqual(
				range(seqsAround[0] as number, seqsAround.at(-1) as number),
			);
			const gap = await page(`limit=7&at=${iso(T0 + k * 10_000 + 5_000)}`);
			expect(gap.locate?.exact_seq, `第 ${k} 行之后 5 秒`).toBeNull();
			expect(seqs(gap)).toContain(Math.min(k + 1, 1500));
		}
	}, 60_000);

	it("相差正好 50 毫秒算正好有那一行，多 1 毫秒就不算（相差 0.4 秒也不算：日志按批次到达，那一行可能是另一笔订单的）", async () => {
		await everyTenSeconds(100);

		const edge = await page(`limit=20&at=${iso(T0 + 500_050)}`);
		expect(edge.locate?.exact_seq).toBe(50);
		const over = await page(`limit=20&at=${iso(T0 + 500_051)}`);
		expect(over.locate?.exact_seq).toBeNull();
		const early = await page(`limit=20&at=${iso(T0 + 499_950)}`);
		expect(early.locate?.exact_seq).toBe(50);
		const tooEarly = await page(`limit=20&at=${iso(T0 + 499_949)}`);
		expect(tooEarly.locate?.exact_seq).toBeNull();
		const batched = await page(`limit=20&at=${iso(T0 + 500_400)}`);
		expect(batched.locate?.exact_seq).toBeNull();
	});

	it("50 毫秒以内有不止一行时不算正好有那一行：分不出是哪一笔的，只写那一刻的位置", async () => {
		await write([
			lineAt(1, 10_000),
			lineAt(2, 20_000),
			lineAt(3, 20_030),
			lineAt(4, 20_120),
			lineAt(5, 30_000),
		]);

		// 第 2、3 行都在 50 毫秒以内。
		expect((await page(`at=${iso(T0 + 20_015)}`)).locate?.exact_seq).toBeNull();
		// 离第 3、4 行都是 45 毫秒。
		expect((await page(`at=${iso(T0 + 20_075)}`)).locate?.exact_seq).toBeNull();
		// 只有第 4 行在 50 毫秒以内（第 3 行差 80 毫秒）。
		expect((await page(`at=${iso(T0 + 20_110)}`)).locate?.exact_seq).toBe(4);
	});

	it("没有正好对应的行：不指定任何一行，写明那一刻在日志里的位置，页里前后的行照常给出", async () => {
		await everyTenSeconds(100);
		const all = await page("limit=1000");
		const offsetOf = (seq: number) => all.lines.find((l) => l.seq === seq)?.offset;

		// 第 50 行（500 秒）与第 51 行（510 秒）正中间。
		const gap = await page(`limit=20&at=${iso(T0 + 505_000)}`);
		expect(gap.locate).toEqual({ at_offset: offsetOf(51), exact_seq: null });
		expect(seqs(gap)).toEqual(range(41, 60));
		expect(gap.last_seq).toBe(100);
		expect(gap.size).toBe(all.size);

		// 往前、往后接着翻页：与这一页首尾相接，不重复不遗漏。
		const older = await page(`limit=20&before=${gap.start}`);
		expect(seqs(older)).toEqual(range(21, 40));
		expect(older.end).toBe(gap.start);
		const newer = await page(`limit=20&after=${gap.end}`);
		expect(seqs(newer)).toEqual(range(61, 80));
		expect(newer.start).toBe(gap.end);
	});

	it("那一刻早于第一行：返回第一页；晚于最后一行：返回最后一页", async () => {
		await everyTenSeconds(100);
		const all = await page("limit=1000");

		const first = await page(`limit=20&at=${iso(T0 - 60_000)}`);
		expect(seqs(first)).toEqual(range(1, 20));
		expect(first.start).toBe(0);
		expect(first.locate).toEqual({ at_offset: 0, exact_seq: null });

		const last = await page(`limit=20&at=${iso(T0 + 5_000_000)}`);
		expect(seqs(last)).toEqual(range(81, 100));
		expect(last.end).toBe(last.size);
		expect(last.locate).toEqual({ at_offset: all.size, exact_seq: null });
	});

	it("靠近开头或末尾时一页仍是满的：不足的那一侧由另一侧补上", async () => {
		await everyTenSeconds(100);

		const nearStart = await page(`limit=20&at=${iso(T0 + 25_000)}`);
		expect(seqs(nearStart)).toEqual(range(1, 20));
		expect(nearStart.locate?.exact_seq).toBeNull();

		const nearEnd = await page(`limit=20&at=${iso(T0 + 975_000)}`);
		expect(seqs(nearEnd)).toEqual(range(81, 100));
		expect(nearEnd.locate?.exact_seq).toBeNull();
	});

	it("日志不足一页时就是整份日志，那一刻在中间也一样", async () => {
		await everyTenSeconds(5);
		const middle = await page(`limit=20&at=${iso(T0 + 25_000)}`);
		expect(seqs(middle)).toEqual([1, 2, 3, 4, 5]);
		expect(middle.locate?.exact_seq).toBeNull();
	});

	it("按控制面时间定位：Agent 时间跳变过（1970 年、2099 年、倒退）的日志也不受影响", async () => {
		await write([
			lineAt(1, 10_000),
			// Agent 时间被改到 1970 年。
			lineAt(2, 20_000, { agentTimeMs: 86_400_000 }),
			// 再改到 2099 年。
			lineAt(3, 30_000, { agentTimeMs: Date.parse("2099-12-31T23:59:59.000Z") }),
			// 倒退回比第一行还早。
			lineAt(4, 40_000, { agentTimeMs: AGENT_T0 - 3_600_000 }),
			lineAt(5, 50_000, { agentTimeMs: AGENT_T0 + 50_000 }),
		]);

		const third = await page(`limit=2&at=${iso(T0 + 30_000)}`);
		expect(third.locate?.exact_seq).toBe(3);
		expect(seqs(third)).toEqual([2, 3]);
		// 第 4 行的 Agent 时间比第 1 行还早：按 Agent 时间会排到最前，按控制面时间它在第 3、5 行之间。
		const fourth = await page(`limit=3&at=${iso(T0 + 40_000)}`);
		expect(fourth.locate?.exact_seq).toBe(4);
		expect(seqs(fourth)).toEqual([3, 4, 5]);
		// 拿第 3 行的 Agent 时间（2099 年）去定位，不是控制面时间的那一刻：晚于最后一行。
		const agentTime = await page(`limit=2&at=2099-12-31T23:59:59.000Z`);
		expect(agentTime.locate?.exact_seq).toBeNull();
		expect(seqs(agentTime)).toEqual([4, 5]);
	});

	it("升级之前写入的行没有控制面时间：排在最前，不会被当成正好对应的行；那一刻在它们之后照常定位", async () => {
		const old = [
			{ seq: 1, time: "2024-05-01T00:00:01.000Z", source: "stdout", level: "info", text: "旧 1" },
			{ seq: 2, time: "2024-05-01T00:00:02.000Z", source: "sdk", level: "warn", text: "旧 2" },
		];
		const dir = join(cp.dataDir, "logs", runId);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, `${task.taskId}.jsonl`),
			old.map((l) => `${JSON.stringify(l)}\n`).join(""),
		);
		await write([lineAt(3, 10_000), lineAt(4, 20_000), lineAt(5, 30_000)]);

		const middle = await page(`limit=10&at=${iso(T0 + 20_000)}`);
		expect(middle.locate?.exact_seq).toBe(4);
		expect(seqs(middle)).toEqual([1, 2, 3, 4, 5]);
		// 旧行的时间是 Agent 时间：即使它恰好等于那一刻也不算。
		const agentTime = await page(`limit=10&at=2024-05-01T00:00:01.500Z`);
		expect(agentTime.locate?.exact_seq).toBeNull();
		expect(agentTime.locate?.at_offset).toBe(
			Buffer.byteLength(old.map((l) => `${JSON.stringify(l)}\n`).join("")),
		);
	});

	it("按级别筛选时只在筛出的行里定位：页里只有符合的行，正好对应的行也必须符合", async () => {
		await write(
			range(1, 40).map((k) =>
				lineAt(k, k * 10_000, { level: k % 4 === 0 ? LogLevel.ERROR : LogLevel.INFO }),
			),
		);

		// 第 21 行是 INFO，筛 ERROR 后正好对应的行没有，页里是它前后的 ERROR 行。
		const missing = await page(`limit=4&level=error&at=${iso(T0 + 210_000)}`);
		expect(missing.locate?.exact_seq).toBeNull();
		expect(seqs(missing)).toEqual([16, 20, 24, 28]);
		const match = await page(`limit=4&level=error&at=${iso(T0 + 240_000)}`);
		expect(match.locate?.exact_seq).toBe(24);
		expect(seqs(match)).toEqual([16, 20, 24, 28]);
	});

	it("还没有日志的任务：空页，那一刻的位置是 0", async () => {
		const empty = await page(`at=${iso(T0)}`);
		expect(empty.lines).toEqual([]);
		expect(empty.locate).toEqual({ at_offset: 0, exact_seq: null });
	});

	it("不带 at 时 locate 是 null；at 不能和 before / after 同时给，也必须是控制面的时间格式", async () => {
		await everyTenSeconds(3);
		expect((await page("limit=2")).locate).toBeNull();

		for (const query of [
			`at=${iso(T0)}&before=100`,
			`at=${iso(T0)}&after=0`,
			`at=${encodeURIComponent("昨天下午")}`,
			"at=1767225600000",
		]) {
			const res = await fetchPage(query);
			expect(res.status, query).toBe(400);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				"invalid_request",
			);
		}
		// 空字符串等于没给。
		expect((await page("at=")).locate).toBeNull();
	});
});
