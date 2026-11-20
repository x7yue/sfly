import { compareRunLogKeys, type RunLogLine, runLogKey } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { settled } from "#/lib/fake-ports";
import { FakeRunLog, runLine, runPage } from "./fake-run-log";
import {
	createRunLogReader,
	emptyRunLogs,
	type RunLogOptions,
	type RunLogReader,
	runLineKey,
} from "./run-log-reader";

/** 新建读取器并等最新一页读完（以及读完之后自动接着读的页）。 */
async function open(log: FakeRunLog, options?: RunLogOptions) {
	const reader = createRunLogReader(log, options);
	await settled();
	return reader;
}

/** 等一次往前翻页读完。 */
async function older(reader: RunLogReader) {
	reader.loadOlder();
	await settled();
}

const keys = (reader: RunLogReader) => reader.get().lines.map(runLineKey);
/** 任务 task 的第 from 到第 to 行，控制面时间等于序号。 */
const run = (task: string, from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => runLine(task, from + i));

describe("读取时序", () => {
	it("先读最新一页，读到之后才接上实时推送，从这一页的 live_after 接上", async () => {
		const log = new FakeRunLog(run("a", 1, 6), { pageSize: 2 });
		const reader = createRunLogReader(log);
		expect(reader.get()).toEqual(emptyRunLogs);
		expect(log.live.connections).toHaveLength(0);
		await settled();
		expect(log.pages.reads).toEqual([{}]);
		expect(keys(reader)).toEqual(["a:5", "a:6"]);
		expect(reader.get()).toMatchObject({ loaded: true, hasOlder: true, error: null });
		expect(log.live.connections.map((c) => [c.after, c.open])).toEqual([["live-1", true]]);
	});

	it("运行已超过保留期：显示已过期，不接实时推送", async () => {
		const log = new FakeRunLog([], { pageSize: 2 });
		log.expired = true;
		const reader = await open(log);
		expect(reader.get()).toMatchObject({ loaded: true, expired: true, lines: [] });
		expect(log.live.connections).toHaveLength(0);
	});

	it("同一个游标只读一次：读的过程中再翻不再发请求，读完之后才读下一页，读到开头后不再读", async () => {
		const log = new FakeRunLog(run("a", 1, 6), { pageSize: 2 });
		const reader = await open(log);
		for (let i = 0; i < 5; i++) reader.loadOlder();
		expect(reader.get().loadingOlder).toBe(true);
		expect(log.pages.reads).toEqual([{}, { before: "4" }]);
		await settled();
		expect(reader.get().loadingOlder).toBe(false);

		await older(reader);
		expect(log.pages.reads).toEqual([{}, { before: "4" }, { before: "2" }]);
		expect(keys(reader)).toEqual(["a:1", "a:2", "a:3", "a:4", "a:5", "a:6"]);
		expect(reader.get().hasOlder).toBe(false);
		reader.loadOlder();
		expect(log.pages.reads).toHaveLength(3);
	});

	it("重新读最新一页期间不往前翻，读到之前照常显示已有的行，读到之后推送从新的位置接上", async () => {
		const log = new FakeRunLog(run("a", 1, 6), { pageSize: 2 });
		const reader = await open(log);
		log.append(run("a", 7, 7));

		log.pages.hold = true;
		log.reload();
		expect(log.live.connections.map((c) => c.open)).toEqual([false]);
		expect(reader.get()).toMatchObject({ loaded: true, hasOlder: true });
		expect(keys(reader)).toEqual(["a:5", "a:6", "a:7"]);
		reader.loadOlder();
		expect(log.pages.reads).toEqual([{}, {}]);

		await log.pages.release();
		expect(keys(reader)).toEqual(["a:6", "a:7"]);
		expect(log.live.connections.map((c) => [c.after, c.open])).toEqual([
			["live-1", false],
			["live-2", true],
		]);
	});

	it("重新读最新一页时在途的往前翻页的结果作废：晚到也不并进新的缓冲区", async () => {
		const log = new FakeRunLog(run("a", 1, 6), { pageSize: 2 });
		const reader = await open(log);

		log.pages.hold = true;
		reader.loadOlder();
		expect(reader.get().loadingOlder).toBe(true);
		log.pages.hold = false;
		log.reload();
		await settled();
		expect(keys(reader)).toEqual(["a:5", "a:6"]);
		expect(reader.get().loadingOlder).toBe(false);

		// 旧游标读的那一页现在才回来。
		await log.pages.release();
		expect(keys(reader)).toEqual(["a:5", "a:6"]);
		expect(reader.get()).toMatchObject({ loadingOlder: false, hasOlder: true });
	});

	it("重新读最新一页失败：已有的行不变，显示读取失败的原因，不再接实时推送", async () => {
		const log = new FakeRunLog(run("a", 1, 6), { pageSize: 2 });
		const reader = await open(log);
		log.pages.failNext("控制面不可用");
		log.reload();
		await settled();
		expect(keys(reader)).toEqual(["a:5", "a:6"]);
		expect(reader.get()).toMatchObject({ loaded: true, error: "控制面不可用" });
		expect(log.live.connections.map((c) => c.open)).toEqual([false]);
	});

	it("换读取器（运行、范围或级别变了）之后，读最新一页的结果作废：不进状态，也不连实时推送", async () => {
		const log = new FakeRunLog(run("a", 1, 6), { pageSize: 2 });
		log.pages.hold = true;
		const reader = createRunLogReader(log);
		reader.dispose();
		await log.pages.release();
		expect(reader.get()).toEqual(emptyRunLogs);
		expect(log.live.connections).toHaveLength(0);
	});

	it("换读取器之后，往前翻页的结果作废，也不再读；实时推送断开，之后推来的行不再进来", async () => {
		const log = new FakeRunLog(run("a", 1, 6), { pageSize: 2 });
		const reader = await open(log);
		log.pages.hold = true;
		reader.loadOlder();
		reader.dispose();
		await log.pages.release();
		expect(keys(reader)).toEqual(["a:5", "a:6"]);
		expect(log.live.connections.map((c) => c.open)).toEqual([false]);
		log.append(run("a", 7, 7));
		expect(keys(reader)).toEqual(["a:5", "a:6"]);
		reader.loadOlder();
		expect(log.pages.reads).toHaveLength(2);
	});

	it("读最新一页失败：没有行、显示读取失败的原因，不连实时推送；前面没有游标，不往前读", async () => {
		const log = new FakeRunLog(run("a", 1, 6), { pageSize: 2 });
		log.pages.failNext("控制面不可用");
		const reader = await open(log);
		expect(reader.get()).toMatchObject({
			loaded: true,
			error: "控制面不可用",
			lines: [],
			hasOlder: false,
		});
		expect(log.live.connections).toHaveLength(0);
		reader.loadOlder();
		expect(log.pages.reads).toHaveLength(1);
	});

	it("往前翻页失败：已有的行不变，停下由用户重试；重试时清掉错误，成功后接上", async () => {
		const log = new FakeRunLog(run("a", 1, 6), { pageSize: 2 });
		const reader = await open(log);
		log.pages.failNext("超时");
		await older(reader);
		expect(reader.get()).toMatchObject({ error: "超时", loadingOlder: false });
		expect(keys(reader)).toEqual(["a:5", "a:6"]);

		log.pages.hold = true;
		reader.loadOlder();
		expect(reader.get()).toMatchObject({ error: null, loadingOlder: true });
		await log.pages.release();
		expect(keys(reader)).toEqual(["a:3", "a:4", "a:5", "a:6"]);
	});

	it("筛选很少匹配时一页可以没有行：已加载的页都是空的、前面还有内容就自动接着往前读，读到行或读到开头为止", async () => {
		// 唯一的 ERROR 是第 1 行，后面 6 行都是 INFO：每页扫描 2 行，前三页都是空的。
		const log = new FakeRunLog([runLine("a", 1, 1, "stdout", "error"), ...run("a", 2, 7)], {
			pageSize: 2,
			levels: ["error"],
		});
		const reader = await open(log);
		expect(log.pages.reads).toEqual([{}, { before: "5" }, { before: "3" }, { before: "1" }]);
		expect(keys(reader)).toEqual(["a:1"]);
		expect(reader.get()).toMatchObject({ loaded: true, hasOlder: false, error: null });
	});

	it("一直读到开头也没有匹配的行：不再接着读，没有行", async () => {
		const log = new FakeRunLog(run("a", 1, 5), { pageSize: 2, levels: ["error"] });
		const reader = await open(log);
		expect(log.pages.reads).toEqual([{}, { before: "3" }, { before: "1" }]);
		expect(reader.get()).toMatchObject({ loaded: true, lines: [], hasOlder: false });
	});

	it("自动接着往前读时读取失败：停下，不再自动读；用户点击重试后接着读", async () => {
		const log = new FakeRunLog([runLine("a", 1, 1, "stdout", "error"), ...run("a", 2, 7)], {
			pageSize: 2,
			levels: ["error"],
		});
		log.pages.hold = true;
		const reader = createRunLogReader(log);
		// 第一页（空的）回来之后自动接着读的那一次失败。
		log.pages.failNext("超时");
		await log.pages.release();
		expect(reader.get()).toMatchObject({ loaded: true, error: "超时", lines: [] });
		await settled();
		expect(log.pages.reads).toEqual([{}, { before: "5" }]);

		await older(reader);
		expect(reader.get().error).toBeNull();
		expect(keys(reader)).toEqual(["a:1"]);
	});

	it("实时推送的行多到丢掉更早的页之后仍超过上限时，断开推送、重新读最新一页再接上", async () => {
		const log = new FakeRunLog(run("a", 0, 2), { pageSize: 2 });
		const reader = await open(log, { maxLines: 4 });
		await older(reader);
		expect(keys(reader)).toEqual(["a:0", "a:1", "a:2"]);

		// 丢掉最早的一页（a:0）之后正好 4 行，不超过上限：不重新读。
		log.append(run("a", 3, 4));
		expect(keys(reader)).toEqual(["a:1", "a:2", "a:3", "a:4"]);
		expect(log.pages.reads).toHaveLength(2);

		// 没有更早的页可丢了还是超过：重新读最新一页，推送过的行都在新的最新一页里，推送从新的位置接上。
		log.append(run("a", 5, 5));
		expect(log.live.connections.map((c) => c.open)).toEqual([false]);
		await settled();
		expect(log.pages.reads).toEqual([{}, { before: "1" }, {}]);
		expect(keys(reader)).toEqual(["a:4", "a:5"]);
		expect(reader.get().hasOlder).toBe(true);
		expect(log.live.connections.map((c) => [c.after, c.open])).toEqual([
			["live-1", false],
			["live-2", true],
		]);
	});

	it("超过浏览器保留的 5000 行（默认上限）时重新读最新一页，之后的新行照常进来", async () => {
		const log = new FakeRunLog(run("a", 1, 3), { pageSize: 300 });
		const reader = await open(log);
		log.append(run("a", 4, 5004));
		await settled();
		expect(log.pages.reads).toEqual([{}, {}]);
		expect(reader.get().lines).toHaveLength(300);
		expect(reader.get().lines.at(-1)?.seq).toBe(5004);
		log.append(run("a", 5005, 5005));
		expect(reader.get().lines.at(-1)?.seq).toBe(5005);
		expect(log.pages.reads).toHaveLength(2);
	});
});

describe("合并规则", () => {
	it("先读最新一页；前面还有行时可以往前翻，读到开头后不再翻", async () => {
		const log = new FakeRunLog([runLine("a", 1), runLine("b", 2), runLine("a", 3)], {
			pageSize: 2,
		});
		const reader = await open(log);
		expect(keys(reader)).toEqual(["b:2", "a:3"]);
		expect(reader.get()).toMatchObject({ loaded: true, hasOlder: true });
		const whole = await open(new FakeRunLog([runLine("a", 1)], { pageSize: 2 }));
		expect(whole.get().hasOlder).toBe(false);
	});

	it("往前翻的一页按排序键插进来，读到开头后不再有更早的行", async () => {
		const history = [
			runLine("a", 0),
			runLine("b", 1),
			runLine("a", 2),
			runLine("a", 3),
			runLine("b", 4),
		];
		const reader = await open(new FakeRunLog(history, { pageSize: 2 }));
		expect(keys(reader)).toEqual(["a:3", "b:4"]);
		await older(reader);
		expect(keys(reader)).toEqual(["b:1", "a:2", "a:3", "b:4"]);
		expect(reader.get().hasOlder).toBe(true);
		await older(reader);
		expect(keys(reader)).toEqual(["a:0", "b:1", "a:2", "a:3", "b:4"]);
		expect(reader.get().hasOlder).toBe(false);
	});

	it("按任务加序号去重：已经有的行不再加入，别的任务的同一序号照常加入", async () => {
		const log = new FakeRunLog([], { pageSize: 2 });
		log.pages.replyNext(runPage([runLine("a", 2), runLine("b", 2)], "c1"));
		const reader = await open(log);
		log.pages.replyNext(runPage([runLine("a", 1), runLine("b", 1), runLine("a", 2)], "c2"));
		await older(reader);
		expect(keys(reader)).toEqual(["a:1", "b:1", "a:2", "b:2"]);

		const before = reader.get();
		log.emit([runLine("b", 2), runLine("a", 2)]);
		expect(reader.get()).toBe(before);
		log.emit([runLine("b", 2), runLine("b", 3)]);
		expect(keys(reader)).toEqual(["a:1", "b:1", "a:2", "b:2", "b:3"]);
	});

	it("实时推送的行按排序键插到对应位置：新的接在最后，晚到的插在中间；比已加载的最早一行还早时成为第一行，之后往前翻到的页插到它前后", async () => {
		const log = new FakeRunLog([], { pageSize: 3 });
		log.pages.replyNext(
			runPage([runLine("a", 1, 10), runLine("b", 1, 20), runLine("a", 2, 30)], "c1"),
		);
		const reader = await open(log);
		log.emit([runLine("b", 2, 40)]);
		expect(keys(reader)).toEqual(["a:1", "b:1", "a:2", "b:2"]);
		// c 断线后补发：第 1 行在 a 的第 2 行之前，第 2 行在最后。
		log.emit([runLine("c", 1, 25), runLine("c", 2, 50)]);
		expect(keys(reader)).toEqual(["a:1", "b:1", "c:1", "a:2", "b:2", "c:2"]);
		// d 的晚到行比已加载的最早一行还早：成为第一行。
		log.emit([runLine("d", 1, 5)]);
		expect(keys(reader)).toEqual(["d:1", "a:1", "b:1", "c:1", "a:2", "b:2", "c:2"]);
		// 往前翻到的页（更早的行）插到它前后。
		log.pages.replyNext(
			runPage([runLine("b", 0, 3), runLine("a", 0, 7)], "c2", { reachedStart: true }),
		);
		await older(reader);
		expect(keys(reader)).toEqual(["b:0", "d:1", "a:0", "a:1", "b:1", "c:1", "a:2", "b:2", "c:2"]);
	});

	it("同一任务内控制面时间倒挂超过 2 秒时仍按序号：新行不插到这个任务序号更小的行前面，旧行不插到序号更大的行后面", async () => {
		const log = new FakeRunLog([], { pageSize: 2 });
		// a 的第 2 行偏到了未来（第 10 秒），第 3 行回到第 5 秒。
		log.pages.replyNext(runPage([runLine("b", 1, 4_000), runLine("a", 2, 10_000)], "c1"));
		const reader = await open(log);
		log.emit([runLine("a", 3, 5_000), runLine("b", 2, 11_000)]);
		expect(keys(reader)).toEqual(["b:1", "a:2", "a:3", "b:2"]);
		// 往前翻到 a 的第 1 行（第 12 秒，比它之后的行都晚）：仍排在 a 的第 2 行前面。
		log.pages.replyNext(runPage([runLine("a", 1, 12_000)], "c2", { reachedStart: true }));
		await older(reader);
		expect(keys(reader)).toEqual(["b:1", "a:1", "a:2", "a:3", "b:2"]);
	});

	// 纯计算，不等待真实的东西：空闲时约 1 秒，pre-push 同时跑全部测试时会慢到 5 秒以上，默认的 5 秒超时会误报。
	it("随机顺序、分批加入（有的任务控制面时间倒挂超过 2 秒）：每行只出现一次，同一任务内始终按序号，已有的行之间的先后不变；没有倒挂时就是排序键的顺序", async () => {
		const tasks = ["a", "b", "c", "d", "e"];
		for (let seed = 1; seed <= 100; seed++) {
			const random = prng(seed);
			const inverted = seed % 2 === 0;
			const all = tasks.flatMap((task) => {
				const length = 5 + Math.floor(random() * 30);
				let ms = 0;
				return Array.from({ length }, (_, i) => {
					// 同一任务的时间不减（常有几个任务在同一毫秒）；倒挂时偶尔一行偏到了几秒之后，后面的行回到原来的时刻。
					ms += Math.floor(random() * 8) * 100;
					const spike = inverted && random() < 0.15 ? 3_000 + Math.floor(random() * 80) * 100 : 0;
					return runLine(task, i + 1, ms + spike);
				});
			});
			const [first, ...rest] = shuffle(all, random) as [RunLogLine, ...RunLogLine[]];
			const log = new FakeRunLog([], { pageSize: 2 });
			log.pages.replyNext(runPage([first], "c0"));
			const reader = await open(log);
			for (let at = 0; at < rest.length; ) {
				const end = at + 1 + Math.floor(random() * 9);
				const chunk = rest.slice(at, end);
				at = end;
				const before = keys(reader);
				if (random() < 0.3) {
					log.pages.replyNext(runPage(chunk, `c${at}`));
					await older(reader);
				} else {
					log.emit(chunk);
				}
				const after = keys(reader);
				expect(new Set(after).size, `seed ${seed}：重复的行`).toBe(after.length);
				expect(subsequence(before, after), `seed ${seed}：已有的行的先后变了`).toBe(true);
				for (const task of tasks) {
					const seqs = reader
						.get()
						.lines.filter((l) => l.task_id === task)
						.map((l) => l.seq);
					expect(seqs, `seed ${seed}：${task} 的序号顺序`).toEqual([...seqs].sort((x, y) => x - y));
				}
			}
			expect([...keys(reader)].sort(), `seed ${seed}：行不多不少`).toEqual(
				all.map(runLineKey).sort(),
			);
			if (!inverted) {
				const sorted = [...all].sort((x, y) => compareRunLogKeys(runLogKey(x), runLogKey(y)));
				expect(keys(reader), `seed ${seed}：排序键的顺序`).toEqual(sorted.map(runLineKey));
			}
		}
	}, 30_000);

	it("缓冲区有几万行时再加入几万行：位置二分查找，不会因为每加一行就扫过整个缓冲区而慢到不能用", {
		timeout: 3_000,
	}, async () => {
		const tasks = ["a", "b", "c", "d"];
		/** 第 i 行（全部 60000 行里的位置）：四个任务轮流，时间是 i。 */
		const at = (i: number) => runLine(tasks[i % 4] as string, Math.floor(i / 4) + 1, i);
		const history = Array.from({ length: 30_000 }, (_, i) => at(i));
		// 实时推送的行接在后面，每两行里先到的是后一行（前一行晚到，要插到它前面）。
		const live = Array.from({ length: 30_000 }, (_, i) => at(30_000 + (i ^ 1)));
		const log = new FakeRunLog(history, { pageSize: 30_000 });
		const reader = await open(log, { maxLines: 100_000 });
		log.emit(live);
		const { lines } = reader.get();
		expect(lines).toHaveLength(60_000);
		expect(lines.at(0)).toMatchObject({ task_id: "a", seq: 1 });
		expect(lines.at(-1)).toMatchObject({ task_id: "d", seq: 15_000 });
	});

	it("超过 5000 行时丢掉最早的几页、保留最新的行；剩下最早那一页的游标能把丢掉的行读回来", async () => {
		// 任务 t 的第 1–6000 行，每页 300 行，从新到旧加载 20 页。
		const log = new FakeRunLog(run("t", 1, 6000), { pageSize: 300 });
		const reader = await open(log);
		for (let i = 1; i < 20; i++) await older(reader);
		expect(reader.get().lines).toHaveLength(6000);

		// 实时推送加入一行之后超过 5000：丢掉最早的 4 页（第 1–1200 行），最新一页总是保留。
		log.append(run("t", 6001, 6001));
		const { lines } = reader.get();
		expect(lines).toHaveLength(4801);
		expect(lines[0]?.seq).toBe(1201);
		expect(lines.at(-1)?.seq).toBe(6001);
		expect(reader.get().hasOlder).toBe(true);

		// 游标是剩下最早那一页的 before，读回的是丢掉的最晚那一页。
		await older(reader);
		expect(log.pages.reads.at(-1)).toEqual({ before: "1200" });
		expect(reader.get().lines[0]?.seq).toBe(901);
	});

	it("丢页只丢这些页的行：插在它们中间的实时推送的行（包括晚到的）保留，留下的页的行一行不少", async () => {
		const log = new FakeRunLog(run("a", 1, 9), { pageSize: 3 });
		const reader = await open(log, { maxLines: 6 });
		await older(reader);
		await older(reader);
		// b 的晚到行落在最早那一页中间，c 的新行在最后。
		log.emit([runLine("b", 1, 2)]);
		expect(keys(reader)).toEqual(["b:1", "a:7", "a:8", "a:9"]);
		log.emit([runLine("c", 1, 10)]);
		expect(keys(reader)).toEqual(["b:1", "a:7", "a:8", "a:9", "c:1"]);

		// 往前翻回丢掉的那一页：晚到的行仍在它应在的位置。
		await older(reader);
		expect(keys(reader)).toEqual(["b:1", "a:4", "a:5", "a:6", "a:7", "a:8", "a:9", "c:1"]);
	});

	it("实时推送的截断标记把这个任务记为已截断", async () => {
		const log = new FakeRunLog([runLine("a", 1)], { pageSize: 2 });
		const reader = await open(log);
		expect(reader.get().truncatedTasks).toEqual([]);
		log.emit([runLine("a", 2), runLine("a", 3, 3, "system")]);
		expect(reader.get().truncatedTasks.map((t) => t.task_id)).toEqual(["a"]);
		expect(reader.get().truncatedTasks[0]).toEqual({
			task_id: "a",
			chain_instance_id: "main",
			subflow: null,
			node_id: "a",
			attempt: 1,
		});
		log.emit([runLine("b", 1, 4, "system")]);
		expect(reader.get().truncatedTasks.map((t) => t.task_id)).toEqual(["a", "b"]);
	});
});

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
