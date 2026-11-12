import type { RunLogLine, RunLogPage } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	emptyRunBuffer,
	fromLatestPage,
	keepLatest,
	needsOlder,
	olderCursor,
	runLineKey,
	withOlderPage,
} from "./run-log-buffer";

/** 任务 task 的第 seq 行（来源字段只看 task_id）。 */
const line = (task: string, seq: number): RunLogLine => ({
	seq,
	time: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seq)).toISOString(),
	agent_time: null,
	source: "stdout",
	level: "info",
	text: `${task} ${seq}`,
	task_id: task,
	chain_instance_id: "main",
	subflow: null,
	node_id: task,
	attempt: 1,
	chain_depth: 0,
	chain_started_at: "2026-01-01T00:00:00.000Z",
	node_index: 1,
	task_started_at: "2026-01-01T00:00:00.000Z",
});

/** 控制面返回的一页；游标对前端不透明，这里用能看出是哪一页的字符串。 */
const page = (lines: RunLogLine[], before: string, reachedStart = false): RunLogPage => ({
	run_id: "r",
	lines,
	before,
	after: `after ${before}`,
	reached_start: reachedStart,
	reached_end: true,
	truncated_tasks: [],
	expired: false,
});

const keys = (b: { lines: RunLogLine[] }) => b.lines.map(runLineKey);

describe("合并视图的日志缓冲区", () => {
	it("先读最新一页；前面还有行时可以往前翻，读到开头后不再翻", () => {
		const latest = fromLatestPage(page([line("a", 3), line("b", 1)], "c1"));
		expect(keys(latest)).toEqual(["a:3", "b:1"]);
		expect(latest.loaded).toBe(true);
		expect(olderCursor(latest)).toBe("c1");
		expect(olderCursor(fromLatestPage(page([line("a", 1)], "c0", true)))).toBeNull();
	});

	it("往前翻的一页接在前面，游标换成这一页的 before，读到开头后为 null", () => {
		let b = fromLatestPage(page([line("a", 3), line("b", 2)], "c1"));
		b = withOlderPage(b, page([line("b", 1), line("a", 2)], "c2"));
		expect(keys(b)).toEqual(["b:1", "a:2", "a:3", "b:2"]);
		expect(olderCursor(b)).toBe("c2");
		b = withOlderPage(b, page([line("a", 1)], "c3", true));
		expect(keys(b)).toEqual(["a:1", "b:1", "a:2", "a:3", "b:2"]);
		expect(olderCursor(b)).toBeNull();
	});

	it("按任务加序号去重：已经有的行不再加入，别的任务的同一序号照常加入", () => {
		let b = fromLatestPage(page([line("a", 2), line("b", 2)], "c1"));
		b = withOlderPage(b, page([line("a", 1), line("b", 1), line("a", 2)], "c2"));
		expect(keys(b)).toEqual(["a:1", "b:1", "a:2", "b:2"]);
		expect(b.lines).toHaveLength(4);
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
