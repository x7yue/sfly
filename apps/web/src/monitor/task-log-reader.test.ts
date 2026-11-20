import { describe, expect, it } from "vitest";
import { settled } from "#/lib/fake-ports";
import { FakeTaskLog, logLine, secondsIn } from "./fake-task-log";
import {
	createTaskLogReader,
	emptyTaskLogs,
	type TaskLogOptions,
	type TaskLogReader,
} from "./task-log-reader";

/** 新建读取器并等第一页读完。 */
async function open(log: FakeTaskLog, options?: TaskLogOptions) {
	const reader = createTaskLogReader(log, options);
	await settled();
	return reader;
}

/** 等一次翻页读完。 */
async function older(reader: TaskLogReader) {
	reader.loadOlder();
	await settled();
}
async function newer(reader: TaskLogReader) {
	reader.loadNewer();
	await settled();
}

const seqs = (reader: TaskLogReader) => reader.get().lines.map((l) => l.seq);
const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("读取时序", () => {
	it("先读最后一页，读到之后才接上实时流，从这一页的最后序号接上", async () => {
		const log = new FakeTaskLog(10, { pageSize: 5 });
		const reader = createTaskLogReader(log);
		expect(reader.get()).toBe(emptyTaskLogs);
		expect(log.live.connections).toHaveLength(0);
		await settled();
		expect(log.pages.reads).toEqual([{}]);
		expect(seqs(reader)).toEqual(range(6, 10));
		expect(reader.get()).toMatchObject({
			loaded: true,
			hasOlder: true,
			hasNewer: false,
			lastSeq: 10,
		});
		expect(log.live.connections.map((c) => [c.after, c.open])).toEqual([[10, true]]);
	});

	it("定位读到的是文件中间的一页：还有更新的行时不连实时流，往后翻到末尾之后才接上", async () => {
		const log = new FakeTaskLog(100, { pageSize: 20 });
		const reader = await open(log, { at: secondsIn(51) });
		expect(log.pages.reads).toEqual([{ at: secondsIn(51) }]);
		expect(reader.get().hasNewer).toBe(true);
		expect(log.live.connections).toHaveLength(0);

		// 往后翻页的每一页都从上一页的终点接着读；读到末尾之前一直不连。
		while (reader.get().hasNewer) {
			expect(log.live.connections).toHaveLength(0);
			await newer(reader);
		}
		expect(log.pages.reads.slice(1)).toEqual([
			{ after: log.offsetOf(60) },
			{ after: log.offsetOf(80) },
		]);
		expect(log.live.connections.map((c) => [c.after, c.open])).toEqual([[100, true]]);
	});

	it("定位读到的就是最后一页时，不必往后翻，直接接上实时流", async () => {
		const log = new FakeTaskLog(100, { pageSize: 20 });
		const reader = await open(log, { at: secondsIn(101) });
		expect(reader.get()).toMatchObject({ hasNewer: false, hasOlder: true });
		expect(log.live.connections.map((c) => c.after)).toEqual([100]);
	});

	it("同一页只读一次：读的过程中再翻同一个方向不再发请求，读完之后才读下一页", async () => {
		const log = new FakeTaskLog(100, { pageSize: 20 });
		const reader = await open(log, { at: secondsIn(51) });
		log.pages.reads.length = 0;

		for (let i = 0; i < 5; i++) reader.loadOlder();
		expect(reader.get().loadingOlder).toBe(true);
		expect(log.pages.reads).toEqual([{ before: log.offsetOf(40) }]);
		await settled();
		expect(reader.get().loadingOlder).toBe(false);

		await older(reader);
		expect(log.pages.reads).toEqual([{ before: log.offsetOf(40) }, { before: log.offsetOf(20) }]);

		log.pages.reads.length = 0;
		for (let i = 0; i < 5; i++) reader.loadNewer();
		expect(reader.get().loadingNewer).toBe(true);
		expect(log.pages.reads).toEqual([{ after: log.offsetOf(60) }]);
	});

	it("往前和往后各自读，可以同时在读", async () => {
		const log = new FakeTaskLog(100, { pageSize: 20 });
		const reader = await open(log, { at: secondsIn(51) });
		log.pages.reads.length = 0;
		reader.loadOlder();
		reader.loadNewer();
		expect(log.pages.reads).toEqual([{ before: log.offsetOf(40) }, { after: log.offsetOf(60) }]);
		await settled();
		expect(seqs(reader)).toEqual(range(21, 80));
	});

	it("前面没有更早的行时不读，还没读到第一页时也不读", async () => {
		const log = new FakeTaskLog(5, { pageSize: 5 });
		const reader = createTaskLogReader(log);
		reader.loadOlder();
		reader.loadNewer();
		await settled();
		reader.loadOlder();
		reader.loadNewer();
		expect(log.pages.reads).toEqual([{}]);
	});

	it("换读取器（任务、级别或定位的时刻变了）之后，读第一页的结果作废：不进状态，也不连实时流", async () => {
		const log = new FakeTaskLog(10, { pageSize: 5 });
		log.pages.hold = true;
		const reader = createTaskLogReader(log);
		reader.dispose();
		await log.pages.release();
		expect(reader.get()).toBe(emptyTaskLogs);
		expect(log.live.connections).toHaveLength(0);
	});

	it("换读取器之后，翻页的结果作废：行不再变，往后翻到末尾也不再连实时流", async () => {
		const log = new FakeTaskLog(100, { pageSize: 20 });
		const reader = await open(log, { at: secondsIn(51) });
		log.pages.hold = true;
		reader.loadOlder();
		reader.dispose();
		await log.pages.release();
		expect(seqs(reader)).toEqual(range(41, 60));

		const other = await open(log, { at: secondsIn(81) });
		log.pages.hold = true;
		other.loadNewer();
		other.dispose();
		await log.pages.release();
		expect(other.get().hasNewer).toBe(true);
		expect(log.live.connections).toHaveLength(0);
	});

	it("换读取器之后断开实时流，之后推来的行不再进来；已经换掉的读取器不再发请求", async () => {
		const log = new FakeTaskLog(10, { pageSize: 5 });
		const reader = await open(log);
		reader.dispose();
		expect(log.live.connections.map((c) => c.open)).toEqual([false]);
		log.append(3);
		expect(seqs(reader)).toEqual(range(6, 10));
		reader.loadOlder();
		expect(log.pages.reads).toEqual([{}]);
	});

	it("读第一页失败：显示读取失败的原因，没有行，不连实时流", async () => {
		const log = new FakeTaskLog(10, { pageSize: 5 });
		log.pages.failNext("控制面不可用");
		const reader = await open(log);
		expect(reader.get()).toMatchObject({
			loaded: true,
			error: "控制面不可用",
			lines: [],
			hasOlder: false,
		});
		expect(log.live.connections).toHaveLength(0);
	});

	it("翻页失败：已经读到的行不变，读完这一次，之后可以再读", async () => {
		const log = new FakeTaskLog(10, { pageSize: 5 });
		const reader = await open(log);
		log.pages.failNext("超时");
		await older(reader);
		expect(reader.get()).toMatchObject({ error: "超时", loadingOlder: false });
		expect(seqs(reader)).toEqual(range(6, 10));

		await older(reader);
		expect(seqs(reader)).toEqual(range(1, 10));
		expect(log.pages.reads).toHaveLength(3);
	});
});

describe("合并规则", () => {
	it("往前翻页的行接在前面，翻到文件开头后不再有更早的行", async () => {
		const log = new FakeTaskLog(10, { pageSize: 5 });
		const reader = await open(log);
		await older(reader);
		expect(seqs(reader)).toEqual(range(1, 10));
		expect(reader.get()).toMatchObject({ hasOlder: false, start: 0 });
		reader.loadOlder();
		expect(log.pages.reads).toHaveLength(2);
	});

	it("实时流接在历史后面，算出每行的偏移；与历史重叠的行不重复", async () => {
		const log = new FakeTaskLog(10, { pageSize: 5 });
		const reader = await open(log);
		log.write(4);
		log.push(9, 12);
		expect(seqs(reader)).toEqual(range(6, 12));
		expect(reader.get().lines.at(-1)?.offset).toBe(log.offsetOf(11));
		log.push(13, 14);
		expect(seqs(reader)).toEqual(range(6, 14));
		expect(reader.get().end).toBe(log.size);
	});

	it("实时行按同样的级别筛选过滤，不符合的行不显示，位置照样前进", async () => {
		const log = new FakeTaskLog(4, {
			pageSize: 10,
			levels: ["error"],
			levelOf: (seq) => (seq % 2 === 0 ? "error" : "info"),
		});
		const reader = await open(log);
		expect(seqs(reader)).toEqual([2, 4]);
		log.append(4);
		expect(seqs(reader)).toEqual([2, 4, 6, 8]);
		expect(reader.get().end).toBe(log.size);
	});

	it("历史页之后到实时流连上之间有缺口时，丢掉已加载的行，从实时流往前翻页", async () => {
		const log = new FakeTaskLog(5, { pageSize: 10 });
		const reader = await open(log);
		log.write(6);
		log.append(2);
		expect(seqs(reader)).toEqual([12, 13]);
		expect(reader.get()).toMatchObject({ start: log.offsetOf(11), hasOlder: true });
		await older(reader);
		expect(seqs(reader)).toEqual(range(2, 13));
	});

	it("超过保留的行数时丢掉最早的行，之后可以再往前翻回来", async () => {
		const log = new FakeTaskLog(6, { pageSize: 10 });
		const reader = await open(log, { maxLines: 8 });
		log.append(6);
		expect(seqs(reader)).toEqual(range(5, 12));
		expect(reader.get()).toMatchObject({ start: log.offsetOf(4), hasOlder: true });
		await older(reader);
		expect(seqs(reader)).toEqual(range(1, 12));
	});

	it("截断标记（system 行）到达后标记为已截断", async () => {
		const log = new FakeTaskLog(3, { pageSize: 10 });
		const reader = await open(log);
		expect(reader.get().truncated).toBe(false);
		log.appendLines([logLine(4, "warn", "system")]);
		expect(reader.get().truncated).toBe(true);
		expect(seqs(reader)).toEqual(range(1, 4));
	});

	it("定位读到的是文件中间的一页：前面和后面都还有行，记下那一刻的位置和正好对应的行", async () => {
		const log = new FakeTaskLog(100, { pageSize: 20 });
		const reader = await open(log, { at: secondsIn(51) });
		expect(seqs(reader)).toEqual(range(41, 60));
		expect(reader.get()).toMatchObject({
			loaded: true,
			hasOlder: true,
			hasNewer: true,
			start: log.offsetOf(40),
			end: log.offsetOf(60),
			located: { at_offset: log.offsetOf(50), exact_seq: 51 },
		});
	});

	it("定位到第一页时前面没有行，没有正好对应的行时 exact_seq 为 null", async () => {
		const log = new FakeTaskLog(100, { pageSize: 20 });
		const reader = await open(log, { at: new Date(Date.UTC(2025, 0, 1)).toISOString() });
		expect(reader.get()).toMatchObject({
			hasOlder: false,
			hasNewer: true,
			located: { at_offset: 0, exact_seq: null },
		});
	});

	it("定位到最后一页时后面没有行；最新一页（没有定位）后面没有行，也没有定位结果", async () => {
		const log = new FakeTaskLog(100, { pageSize: 20 });
		const last = await open(log, { at: secondsIn(101) });
		expect(last.get()).toMatchObject({
			hasOlder: true,
			hasNewer: false,
			located: { at_offset: log.size, exact_seq: null },
		});
		const latest = await open(log);
		expect(latest.get()).toMatchObject({ hasNewer: false, located: null });
	});

	it("往前、往后翻的页接在两头：行连续，翻到两头后不再有更早或更新的行", async () => {
		const log = new FakeTaskLog(100, { pageSize: 20 });
		const reader = await open(log, { at: secondsIn(51) });
		await older(reader);
		await newer(reader);
		expect(seqs(reader)).toEqual(range(21, 80));
		expect(reader.get()).toMatchObject({
			hasOlder: true,
			hasNewer: true,
			start: log.offsetOf(20),
			end: log.offsetOf(80),
		});
		await older(reader);
		await newer(reader);
		expect(seqs(reader)).toEqual(range(1, 100));
		expect(reader.get()).toMatchObject({
			hasOlder: false,
			hasNewer: false,
			end: log.size,
			lastSeq: 100,
		});
	});

	it("往后翻到文件末尾后，实时流从这一页的最后序号接上：补发的行与历史重叠也不重复", async () => {
		// 读这些页时文件里只写到第 28 行。
		const log = new FakeTaskLog(28, { pageSize: 10 });
		const reader = await open(log, { at: secondsIn(5) });
		await newer(reader);
		await newer(reader);
		expect(reader.get()).toMatchObject({ hasNewer: false, lastSeq: 28, end: log.size });
		expect(log.live.connections.map((c) => c.after)).toEqual([28]);
		// 之后又写到第 30 行：实时流补发第 29、30 行，也可能带上已经读到的第 28 行。
		log.write(2);
		log.push(28, 30);
		expect(seqs(reader)).toEqual(range(1, 30));
		expect(reader.get().end).toBe(log.size);
	});

	it("按级别筛选时一页里只有符合的行，往后翻照样在末尾读完", async () => {
		const log = new FakeTaskLog(40, {
			pageSize: 10,
			levels: ["error"],
			levelOf: (seq) => (seq % 4 === 0 ? "error" : "info"),
		});
		const reader = await open(log, { at: secondsIn(16) });
		expect(seqs(reader)).toEqual([12, 16, 20]);
		await newer(reader);
		await newer(reader);
		expect(seqs(reader)).toEqual([12, 16, 20, 24, 28, 32, 36, 40]);
		expect(reader.get().hasNewer).toBe(false);
	});
});
