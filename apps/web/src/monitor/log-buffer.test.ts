import type { LogLineView, LogPage } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { fromLatestPage, withLive, withOlderPage } from "./log-buffer";

// 一份日志文件：第 n 行的内容与字节偏移（JSONL，与控制面写入的格式相同）。
const line = (seq: number, level: LogLineView["level"] = "info"): LogLineView => ({
	seq,
	time: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
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
