import { compareRunLogKeys, type RunLogLine, type RunLogPage, runLogKey } from "@sfly/schema";
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

/** 固定种子的伪随机数（mulberry32）：每次运行得到同样的数据，失败时能按种子复现。 */
function prng(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

/** small 是不是 big 的子序列（按顺序出现，中间可以夹别的）。 */
function subsequence(small: readonly string[], big: readonly string[]): boolean {
	let next = 0;
	for (const item of big) if (item === small[next]) next++;
	return next === small.length;
}

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

	// 纯计算、不等待任何东西：空闲时约 0.5 秒，pre-push 同时跑全部测试时慢到 5 秒以上，默认的 5 秒超时会误报。
	it("随机顺序、分批加入（有的任务控制面时间倒挂超过 2 秒）：每行只出现一次，同一任务内始终按序号，已有的行之间的先后不变；没有倒挂时就是排序键的顺序", () => {
		const tasks = ["a", "b", "c", "d", "e"];
		for (let seed = 1; seed <= 200; seed++) {
			const random = prng(seed);
			const inverted = seed % 2 === 0;
			const all = tasks.flatMap((task) => {
				const length = 5 + Math.floor(random() * 30);
				let ms = 0;
				return Array.from({ length }, (_, i) => {
					// 同一任务的时间不减（常有几个任务在同一毫秒）；倒挂时偶尔一行偏到了几秒之后，后面的行回到原来的时刻。
					ms += Math.floor(random() * 8) * 100;
					const spike = inverted && random() < 0.15 ? 3_000 + Math.floor(random() * 80) * 100 : 0;
					return line(task, i + 1, ms + spike);
				});
			});
			const shuffled = shuffle(all, random);
			let b = fromLatestPage(page([], "c0"));
			for (let at = 0; at < shuffled.length; ) {
				const end = at + 1 + Math.floor(random() * 9);
				const chunk = shuffled.slice(at, end);
				at = end;
				const before = keys(b);
				b = random() < 0.3 ? withOlderPage(b, page(chunk, `c${at}`)) : withLiveLines(b, chunk);
				const after = keys(b);
				expect(new Set(after).size, `seed ${seed}：重复的行`).toBe(after.length);
				expect(subsequence(before, after), `seed ${seed}：已有的行的先后变了`).toBe(true);
				for (const task of tasks) {
					const seqs = b.lines.filter((l) => l.task_id === task).map((l) => l.seq);
					expect(seqs, `seed ${seed}：${task} 的序号顺序`).toEqual([...seqs].sort((x, y) => x - y));
				}
			}
			expect(keys(b).sort(), `seed ${seed}：行不多不少`).toEqual(all.map(runLineKey).sort());
			if (!inverted) {
				const sorted = [...all].sort((x, y) => compareRunLogKeys(runLogKey(x), runLogKey(y)));
				expect(keys(b), `seed ${seed}：排序键的顺序`).toEqual(sorted.map(runLineKey));
			}
		}
	}, 30_000);

	it("缓冲区有几万行时再加入几万行：位置二分查找，不会因为每加一行就扫过整个缓冲区而慢到不能用", {
		timeout: 3_000,
	}, () => {
		const tasks = ["a", "b", "c", "d"];
		/** 第 i 行（全部 60000 行里的位置）：四个任务轮流，时间是 i。 */
		const at = (i: number) => line(tasks[i % 4] as string, Math.floor(i / 4) + 1, i);
		const history = Array.from({ length: 30_000 }, (_, i) => at(i));
		// 实时推送的行接在后面，每两行里先到的是后一行（前一行晚到，要插到它前面）。
		const live = Array.from({ length: 30_000 }, (_, i) => at(30_000 + (i ^ 1)));
		const b = withLiveLines(fromLatestPage(page(history, "c1")), live);
		expect(b.lines).toHaveLength(60_000);
		expect(b.lines.at(0)).toMatchObject({ task_id: "a", seq: 1 });
		expect(b.lines.at(-1)).toMatchObject({ task_id: "d", seq: 15_000 });
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
		expect(b.truncatedTasks[0]).toEqual({
			task_id: "a",
			chain_instance_id: "main",
			subflow: null,
			node_id: "a",
			attempt: 1,
		});
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
