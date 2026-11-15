import type { LogLineView, LogPage } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	fromLatestPage,
	fromLocatedPage,
	withLive,
	withNewerPage,
	withOlderPage,
} from "./log-buffer";

// 一份日志文件：第 n 行的内容与字节偏移（JSONL，与控制面写入的格式相同）。
const line = (seq: number, level: LogLineView["level"] = "info"): LogLineView => ({
	seq,
	time: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
	agent_time: new Date(Date.UTC(2027, 8, 6, 0, 0, seq)).toISOString(),
	source: "stdout",
	level,
	text: `line ${seq}`,
});
const bytes = (l: LogLineView) => new TextEncoder().encode(`${JSON.stringify(l)}\n`).length;
const file = (n: number, level = (_seq: number): LogLineView["level"] => "info") => {
	const lines: Array<LogLineView & { offset: number }> = [];
	let offset = 0;
	for (let seq = 1; seq <= n; seq++) {
		const l = line(seq, level(seq));
		lines.push({ ...l, offset });
		offset += bytes(l);
	}
	return { lines, size: offset, offsetOf: (seq: number) => lines[seq - 1]?.offset ?? offset };
};

/** 文件里 [from, to] 行组成的一页（start / end 是扫描范围）。 */
function page(f: ReturnType<typeof file>, from: number, to: number, lastSeq = to): LogPage {
	return {
		task_id: "t",
		lines: f.lines.slice(from - 1, to),
		start: f.offsetOf(from),
		end: f.offsetOf(to + 1),
		size: f.size,
		last_seq: lastSeq,
		truncated: false,
		expired: false,
		locate: null,
	};
}

/** 定位到某一刻读到的一页：[from, to] 行，那一刻在 atSeq 行的行首之前，exactSeq 是正好对应的行。 */
function located(
	f: ReturnType<typeof file>,
	from: number,
	to: number,
	atSeq: number,
	exactSeq: number | null,
): LogPage {
	return {
		...page(f, from, to, f.lines.length),
		locate: { at_offset: f.offsetOf(atSeq), exact_seq: exactSeq },
	};
}

/** 实时流推送的一批：[from, to] 行，offset 为第一行的偏移。 */
const chunk = (f: ReturnType<typeof file>, from: number, to: number) => ({
	task_id: "t",
	lines: f.lines.slice(from - 1, to).map(({ offset: _, ...l }) => l),
	offset: f.offsetOf(from),
});

const seqs = (b: { lines: Array<{ seq: number }> }) => b.lines.map((l) => l.seq);
const all = () => true;

describe("日志分页与实时接续", () => {
	it("先读最后一页；前面还有行时可以往前翻", () => {
		const f = file(10);
		const b = fromLatestPage(page(f, 6, 10));
		expect(seqs(b)).toEqual([6, 7, 8, 9, 10]);
		expect(b).toMatchObject({ loaded: true, hasOlder: true, lastSeq: 10 });
		expect(fromLatestPage(page(f, 1, 10)).hasOlder).toBe(false);
	});

	it("往前翻页的行接在前面，翻到文件开头后不再有更早的行", () => {
		const f = file(10);
		const older = withOlderPage(fromLatestPage(page(f, 6, 10)), page(f, 1, 5));
		expect(seqs(older)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(older.hasOlder).toBe(false);
		expect(older.start).toBe(0);
	});

	it("实时流接在历史后面，算出每行的偏移；与历史重叠的行不重复", () => {
		const f = file(14);
		let b = fromLatestPage(page(f, 6, 10));
		b = withLive(b, chunk(f, 9, 12), all);
		expect(seqs(b)).toEqual([6, 7, 8, 9, 10, 11, 12]);
		expect(b.lines.at(-1)?.offset).toBe(f.offsetOf(12));
		b = withLive(b, chunk(f, 13, 14), all);
		expect(seqs(b)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
		expect(b.end).toBe(f.size);
	});

	it("实时行按同样的筛选条件过滤，不符合的行不显示但位置照样前进", () => {
		const f = file(8, (seq) => (seq % 2 === 0 ? "error" : "info"));
		const errors = (l: LogLineView) => l.level === "error";
		let b = fromLatestPage({ ...page(f, 1, 4), lines: page(f, 1, 4).lines.filter(errors) });
		b = withLive(b, chunk(f, 5, 8), errors);
		expect(seqs(b)).toEqual([2, 4, 6, 8]);
		expect(b.end).toBe(f.size);
	});

	it("历史页之后到实时流连上之间有缺口时，丢掉已加载的行，从实时流往前翻页", () => {
		const f = file(20);
		const b = withLive(fromLatestPage(page(f, 1, 5)), chunk(f, 12, 13), all);
		expect(seqs(b)).toEqual([12, 13]);
		expect(b).toMatchObject({ start: f.offsetOf(12), hasOlder: true });
		const filled = withOlderPage(b, page(f, 2, 11));
		expect(seqs(filled)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
	});

	it("超过保留的行数时丢掉最早的行，之后可以再往前翻回来", () => {
		const f = file(12);
		const b = withLive(fromLatestPage(page(f, 1, 6)), chunk(f, 7, 12), all, 8);
		expect(seqs(b)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
		expect(b).toMatchObject({ start: f.offsetOf(5), hasOlder: true });
	});

	it("截断标记（system 行）到达后标记为已截断", () => {
		const f = file(3);
		const marker = {
			seq: 4,
			time: line(4).time,
			agent_time: line(4).agent_time,
			source: "system" as const,
			level: "warn" as const,
		};
		const b = withLive(
			fromLatestPage(page(f, 1, 3)),
			{ task_id: "t", offset: f.size, lines: [{ ...marker, text: "truncated" }] },
			all,
		);
		expect(b.truncated).toBe(true);
		expect(seqs(b)).toEqual([1, 2, 3, 4]);
	});
});

describe("定位到某一刻的一页", () => {
	it("读到的是文件中间的一页：前面和后面都还有行，记下那一刻的位置和正好对应的行", () => {
		const f = file(100);
		const b = fromLocatedPage(located(f, 41, 60, 51, 50));
		expect(seqs(b)).toHaveLength(20);
		expect(b).toMatchObject({
			loaded: true,
			hasOlder: true,
			hasNewer: true,
			start: f.offsetOf(41),
			end: f.offsetOf(61),
			located: { at_offset: f.offsetOf(51), exact_seq: 50 },
		});
	});

	it("定位到第一页时前面没有行，定位到最后一页时后面没有行", () => {
		const f = file(100);
		const first = fromLocatedPage(located(f, 1, 20, 1, null));
		expect(first).toMatchObject({ hasOlder: false, hasNewer: true });
		const last = fromLocatedPage(located(f, 81, 100, 101, null));
		expect(last).toMatchObject({ hasOlder: true, hasNewer: false, located: { exact_seq: null } });
	});

	it("往前、往后翻的页接在两头：行连续，翻到两头后不再有更早或更新的行", () => {
		const f = file(100);
		let b = fromLocatedPage(located(f, 41, 60, 51, null));
		b = withOlderPage(b, page(f, 21, 40));
		b = withNewerPage(b, page(f, 61, 80));
		expect(seqs(b)).toEqual(Array.from({ length: 60 }, (_, i) => 21 + i));
		expect(b).toMatchObject({
			hasOlder: true,
			hasNewer: true,
			start: f.offsetOf(21),
			end: f.offsetOf(81),
		});
		b = withOlderPage(b, page(f, 1, 20));
		b = withNewerPage(b, page(f, 81, 100));
		expect(seqs(b)).toHaveLength(100);
		expect(b).toMatchObject({ hasOlder: false, hasNewer: false, end: f.size, lastSeq: 100 });
	});

	it("往后翻到文件末尾后，实时流从这一页的最后序号接上：与历史重叠的行不重复", () => {
		const f = file(30);
		let b = fromLocatedPage(located(f, 1, 10, 5, null));
		// 读这一页时文件里只写到第 28 行。
		b = withNewerPage(b, { ...page(f, 11, 28), size: f.offsetOf(29), last_seq: 28 });
		expect(b).toMatchObject({ hasNewer: false, lastSeq: 28, end: f.offsetOf(29) });
		// 之后又写到第 30 行：实时流补发第 29、30 行，也可能带上已经读到的第 28 行。
		b = withLive(b, chunk(f, 28, 30), all);
		expect(seqs(b)).toEqual(Array.from({ length: 30 }, (_, i) => 1 + i));
		expect(b.end).toBe(f.size);
	});

	it("按级别筛选时一页里只有符合的行，往后翻照样在末尾读完", () => {
		const f = file(40, (seq) => (seq % 4 === 0 ? "error" : "info"));
		const errors = (p: LogPage): LogPage => ({
			...p,
			lines: p.lines.filter((l) => l.level === "error"),
		});
		let b = fromLocatedPage(errors(located(f, 11, 20, 16, 16)));
		expect(seqs(b)).toEqual([12, 16, 20]);
		b = withNewerPage(b, errors(page(f, 21, 40)));
		expect(seqs(b)).toEqual([12, 16, 20, 24, 28, 32, 36, 40]);
		expect(b.hasNewer).toBe(false);
	});

	it("最新一页（没有定位）后面没有行，也没有定位结果", () => {
		const f = file(10);
		expect(fromLatestPage(page(f, 6, 10))).toMatchObject({ hasNewer: false, located: null });
	});
});
