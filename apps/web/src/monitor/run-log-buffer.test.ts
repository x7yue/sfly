import type { RunLogLine, RunLogPage } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	emptyRunBuffer,
	fromLatestPage,
	keepLatest,
	needsOlder,
	needsReload,
	olderCursor,
	type RunLogBuffer,
	runLineKey,
	withLiveLines,
	withOlderPage,
} from "./run-log-buffer";

const T0 = Date.UTC(2026, 0, 1);
const iso = (ms: number) => new Date(T0 + ms).toISOString();

/**
 * 任务 task 的第 seq 行，控制面时间是第 ms 毫秒（默认等于 seq）。每个任务是主链上的一个节点，
 * 节点在链上的位置按任务名的字母顺序：控制面时间相同时 a 排在 b 前面。
 */
const line = (
	task: string,
	seq: number,
	ms = seq,
	source: RunLogLine["source"] = "stdout",
): RunLogLine => ({
	seq,
	time: iso(ms),
	agent_time: null,
	source,
	level: "info",
	text: `${task} ${seq}`,
	task_id: task,
	chain_instance_id: "main",
	subflow: null,
	node_id: task,
	attempt: 1,
	chain_depth: 0,
	chain_started_at: iso(0),
	node_index: task.charCodeAt(0) - 97,
	task_started_at: iso(0),
});

/** 控制面返回的一页（行已按排序键排好）；游标对前端不透明，这里用能看出是哪一页的字符串。 */
const page = (lines: RunLogLine[], before: string, reachedStart = false): RunLogPage => ({
	run_id: "r",
	lines,
	before,
	after: `after ${before}`,
	reached_start: reachedStart,
	reached_end: true,
	live_after: "live",
	truncated_tasks: [],
	expired: false,
});

const keys = (b: RunLogBuffer) => b.lines.map(runLineKey);

describe("合并视图的日志缓冲区", () => {
	it("先读最新一页；前面还有行时可以往前翻，读到开头后不再翻", () => {
		const latest = fromLatestPage(page([line("b", 1), line("a", 3)], "c1"));
		expect(keys(latest)).toEqual(["b:1", "a:3"]);
		expect(latest.loaded).toBe(true);
		expect(olderCursor(latest)).toBe("c1");
		expect(olderCursor(fromLatestPage(page([line("a", 1)], "c0", true)))).toBeNull();
	});

	it("往前翻的一页按排序键插进来，游标换成这一页的 before，读到开头后为 null", () => {
		let b = fromLatestPage(page([line("a", 3), line("b", 4)], "c1"));
		b = withOlderPage(b, page([line("b", 1), line("a", 2)], "c2"));
		expect(keys(b)).toEqual(["b:1", "a:2", "a:3", "b:4"]);
		expect(olderCursor(b)).toBe("c2");
		b = withOlderPage(b, page([line("a", 0)], "c3", true));
		expect(keys(b)).toEqual(["a:0", "b:1", "a:2", "a:3", "b:4"]);
		expect(olderCursor(b)).toBeNull();
	});

	it("按任务加序号去重：已经有的行不再加入，别的任务的同一序号照常加入", () => {
		let b = fromLatestPage(page([line("a", 2), line("b", 2)], "c1"));
		b = withOlderPage(b, page([line("a", 1), line("b", 1), line("a", 2)], "c2"));
		expect(keys(b)).toEqual(["a:1", "b:1", "a:2", "b:2"]);
		const again = withLiveLines(b, [line("b", 2), line("a", 2)]);
		expect(again).toBe(b);
		expect(keys(withLiveLines(b, [line("b", 2), line("b", 3)]))).toEqual([
			"a:1",
			"b:1",
			"a:2",
			"b:2",
			"b:3",
		]);
	});

	it("实时推送的行按排序键插到对应位置：新的接在最后，晚到的插在中间；比已加载的最早一行还早时成为第一行，之后往前翻到的页插到它前后", () => {
		let b = fromLatestPage(page([line("a", 1, 10), line("b", 1, 20), line("a", 2, 30)], "c1"));
		b = withLiveLines(b, [line("b", 2, 40)]);
		expect(keys(b)).toEqual(["a:1", "b:1", "a:2", "b:2"]);
		// c 断线后补发：第 1 行在 a 的第 2 行之前，第 2 行在最后。
		b = withLiveLines(b, [line("c", 1, 25), line("c", 2, 50)]);
		expect(keys(b)).toEqual(["a:1", "b:1", "c:1", "a:2", "b:2", "c:2"]);
		// d 的晚到行比已加载的最早一行还早：成为第一行。
		b = withLiveLines(b, [line("d", 1, 5)]);
		expect(keys(b)).toEqual(["d:1", "a:1", "b:1", "c:1", "a:2", "b:2", "c:2"]);
		expect(b.pages).toHaveLength(1);
		// 往前翻到的页（更早的行）插到它前后。
		b = withOlderPage(b, page([line("b", 0, 3), line("a", 0, 7)], "c2", true));
		expect(keys(b)).toEqual(["b:0", "d:1", "a:0", "a:1", "b:1", "c:1", "a:2", "b:2", "c:2"]);
	});

	it("同一任务内控制面时间倒挂超过 2 秒时仍按序号：新行不插到这个任务序号更小的行前面，旧行不插到序号更大的行后面", () => {
		// a 的第 2 行偏到了未来（第 10 秒），第 3 行回到第 5 秒。
		let b = fromLatestPage(page([line("b", 1, 4_000), line("a", 2, 10_000)], "c1"));
		b = withLiveLines(b, [line("a", 3, 5_000), line("b", 2, 11_000)]);
		expect(keys(b)).toEqual(["b:1", "a:2", "a:3", "b:2"]);
		// 往前翻到 a 的第 1 行（第 12 秒，比它之后的行都晚）：仍排在 a 的第 2 行前面。
		b = withOlderPage(b, page([line("a", 1, 12_000)], "c2", true));
		expect(keys(b)).toEqual(["b:1", "a:1", "a:2", "a:3", "b:2"]);
	});

	it("超过 5000 行时丢掉最早的几页、保留最新的行；剩下最早那一页的游标能把丢掉的行读回来", () => {
		// 20 页，每页 300 行（任务 t 的第 1–6000 行），从新到旧加载。
		const pageOf = (i: number) =>
			page(
				Array.from({ length: 300 }, (_, j) => line("t", 6000 - i * 300 - 299 + j)),
				`c${i + 1}`,
				i === 19,
			);
		let b = fromLatestPage(pageOf(0));
		for (let i = 1; i < 20; i++) b = withOlderPage(b, pageOf(i));
		expect(b.lines).toHaveLength(6000);
		expect(keepLatest(b, 6000)).toBe(b);

		const kept = keepLatest(b, 5000);
		expect(kept.lines).toHaveLength(4800);
		expect(kept.lines[0]?.seq).toBe(1201);
		expect(kept.lines.at(-1)?.seq).toBe(6000);
		// 丢掉的是最早的 4 页（第 1–1200 行）；游标是剩下最早那一页的 before，读回的是丢掉的最晚那一页。
		expect(olderCursor(kept)).toBe("c16");
		const reloaded = withOlderPage(kept, pageOf(16));
		expect(reloaded.lines[0]?.seq).toBe(901);
		expect(olderCursor(reloaded)).toBe("c17");
	});

	it("丢页只丢这些页的行：插在它们中间的实时推送的行（包括晚到的）保留，留下的页的行一行不少", () => {
		let b = fromLatestPage(page([line("a", 7), line("a", 8), line("a", 9)], "c1"));
		b = withOlderPage(b, page([line("a", 4), line("a", 5), line("a", 6)], "c2"));
		b = withOlderPage(b, page([line("a", 1), line("a", 2), line("a", 3)], "c3"));
		// b 的晚到行落在最早那一页中间，c 的新行在最后。
		b = withLiveLines(b, [line("b", 1, 2)]);
		b = withLiveLines(b, [line("c", 1, 10)]);
		expect(keys(b)).toEqual([
			"a:1",
			"a:2",
			"b:1",
			"a:3",
			"a:4",
			"a:5",
			"a:6",
			"a:7",
			"a:8",
			"a:9",
			"c:1",
		]);

		const kept = keepLatest(b, 6);
		expect(keys(kept)).toEqual(["b:1", "a:7", "a:8", "a:9", "c:1"]);
		expect(olderCursor(kept)).toBe("c1");
		// 往前翻回丢掉的那一页：晚到的行仍在它应在的位置。
		expect(
			keys(withOlderPage(kept, page([line("a", 4), line("a", 5), line("a", 6)], "c2"))),
		).toEqual(["b:1", "a:4", "a:5", "a:6", "a:7", "a:8", "a:9", "c:1"]);
	});

	it("实时推送的行多到丢掉更早的页之后仍超过上限时，要从最新一页重新读", () => {
		let b = fromLatestPage(page([line("a", 1), line("a", 2)], "c1"));
		b = withOlderPage(b, page([line("a", 0)], "c2", true));
		b = withLiveLines(b, [line("a", 3), line("a", 4)]);
		expect(needsReload(b, 4)).toBe(false);
		b = keepLatest(b, 4);
		expect(keys(b)).toEqual(["a:1", "a:2", "a:3", "a:4"]);
		expect(needsReload(b, 4)).toBe(false);
		b = keepLatest(withLiveLines(b, [line("a", 5)]), 4);
		expect(b.lines).toHaveLength(5);
		expect(needsReload(b, 4)).toBe(true);
	});

	it("实时推送的截断标记把这个任务记为已截断", () => {
		let b = fromLatestPage(page([line("a", 1)], "c1"));
		expect(b.truncatedTasks).toEqual([]);
		b = withLiveLines(b, [line("a", 2), line("a", 3, 3, "system")]);
		expect(b.truncatedTasks.map((t) => t.task_id)).toEqual(["a"]);
		b = withLiveLines(b, [line("b", 1, 4, "system")]);
		expect(b.truncatedTasks.map((t) => t.task_id)).toEqual(["a", "b"]);
	});

	it("筛选很少匹配时一页可以没有行：已加载的页都是空的、前面还有内容就要接着往前读，读到行或读到开头为止", () => {
		expect(needsOlder(emptyRunBuffer)).toBe(false);
		let b = fromLatestPage(page([], "c1"));
		expect(b.loaded).toBe(true);
		expect(needsOlder(b)).toBe(true);
		b = withOlderPage(b, page([], "c2"));
		expect(needsOlder(b)).toBe(true);
		expect(olderCursor(b)).toBe("c2");
		b = withOlderPage(b, page([line("a", 1)], "c3"));
		expect(needsOlder(b)).toBe(false);
		expect(olderCursor(b)).toBe("c3");

		// 一直读到开头也没有匹配的行：不再接着读，页面显示「没有符合条件的日志」。
		const none = withOlderPage(fromLatestPage(page([], "c1")), page([], "c2", true));
		expect(none.lines).toEqual([]);
		expect(needsOlder(none)).toBe(false);
		expect(olderCursor(none)).toBeNull();
	});

	it("最新一页总是保留", () => {
		const b = fromLatestPage(page([line("a", 1), line("a", 2), line("a", 3)], "c1"));
		expect(keepLatest(b, 2)).toBe(b);
	});
});
