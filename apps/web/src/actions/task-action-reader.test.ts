import { describe, expect, it } from "vitest";
import { settled } from "#/lib/fake-ports";
import type { ActionFilter } from "./action-details";
import { action, actionPage, FakeTaskActions, mark, period } from "./fake-task-actions";
import {
	createTaskActionReader,
	emptyTaskActions,
	type TaskActionReader,
} from "./task-action-reader";

/** 新建读取器并等第一页读完。 */
async function open(log: FakeTaskActions, filter?: ActionFilter) {
	const reader = createTaskActionReader(log, filter);
	await settled();
	return reader;
}

async function older(reader: TaskActionReader) {
	reader.loadOlder();
	await settled();
}

const ids = (reader: TaskActionReader) => reader.get().details.map((d) => d.id);

/** 第 from 到第 to 个动作（ID 从大到小，开始时间随 ID 增长）。 */
const newest = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => action(to - i, (to - i) * 100));

describe("读取时序", () => {
	it("先读最新一页，读到之后才接上实时推送，从这一页的修订号接上", async () => {
		const log = new FakeTaskActions(newest(1, 5), { pageSize: 2, rev: 11 });
		const reader = createTaskActionReader(log);
		expect(reader.get()).toEqual(emptyTaskActions);
		expect(log.live.connections).toHaveLength(0);
		await settled();
		expect(log.pages.reads).toEqual([{}]);
		expect(ids(reader)).toEqual([5, 4]);
		expect(reader.get()).toMatchObject({ loaded: true, hasOlder: true, error: null });
		expect(log.live.connections.map((c) => [c.after, c.open])).toEqual([[11, true]]);
	});

	it("运行已超过保留期：显示已过期，不接实时推送", async () => {
		const log = new FakeTaskActions([], { pageSize: 2 });
		log.expired = true;
		const reader = await open(log);
		expect(reader.get()).toMatchObject({ loaded: true, expired: true, details: [] });
		expect(log.live.connections).toHaveLength(0);
	});

	it("同一个游标只读一次：读的过程中再翻不再发请求，读完之后才读下一页，读到最早的明细后不再读", async () => {
		const log = new FakeTaskActions(newest(1, 5), { pageSize: 2 });
		const reader = await open(log);
		for (let i = 0; i < 5; i++) reader.loadOlder();
		expect(reader.get().loadingOlder).toBe(true);
		expect(log.pages.reads).toEqual([{}, { before: "2" }]);
		await settled();
		expect(reader.get().loadingOlder).toBe(false);

		await older(reader);
		expect(ids(reader)).toEqual([5, 4, 3, 2, 1]);
		expect(reader.get().hasOlder).toBe(false);
		reader.loadOlder();
		expect(log.pages.reads).toEqual([{}, { before: "2" }, { before: "4" }]);
	});

	it("还没读到第一页时不往前翻", async () => {
		const log = new FakeTaskActions(newest(1, 5), { pageSize: 2 });
		const reader = createTaskActionReader(log);
		reader.loadOlder();
		await settled();
		expect(log.pages.reads).toEqual([{}]);
	});

	it("换读取器（任务或筛选条件变了）之后，读第一页的结果作废：不进状态，也不连实时推送", async () => {
		const log = new FakeTaskActions(newest(1, 5), { pageSize: 2 });
		log.pages.hold = true;
		const reader = createTaskActionReader(log);
		reader.dispose();
		await log.pages.release();
		expect(reader.get()).toEqual(emptyTaskActions);
		expect(log.live.connections).toHaveLength(0);
	});

	it("换读取器之后，往前翻页的结果作废，也不再读；实时推送断开，之后推来的明细不再进来", async () => {
		const log = new FakeTaskActions(newest(1, 5), { pageSize: 2 });
		const reader = await open(log);
		log.pages.hold = true;
		reader.loadOlder();
		reader.dispose();
		await log.pages.release();
		expect(ids(reader)).toEqual([5, 4]);
		expect(log.live.connections.map((c) => c.open)).toEqual([false]);
		log.emit([action(6, 600)]);
		expect(ids(reader)).toEqual([5, 4]);
		reader.loadOlder();
		expect(log.pages.reads).toHaveLength(2);
	});

	it("读第一页失败：显示读取失败的原因，没有明细，不连实时推送；重读只发一次请求，读到之后接上实时推送", async () => {
		const log = new FakeTaskActions(newest(1, 5), { pageSize: 2 });
		log.pages.failNext("控制面不可用");
		const reader = await open(log);
		expect(reader.get()).toMatchObject({ loaded: false, error: new Error("控制面不可用") });
		expect(log.live.connections).toHaveLength(0);

		reader.retry();
		reader.retry();
		expect(reader.get().error).toBeNull();
		await settled();
		expect(log.pages.reads).toEqual([{}, {}]);
		expect(ids(reader)).toEqual([5, 4]);
		expect(log.live.connections.map((c) => c.open)).toEqual([true]);

		// 已经读到了第一页：重读不再发请求。
		reader.retry();
		expect(log.pages.reads).toHaveLength(2);
	});

	it("往前翻页失败：已经读到的明细不变，读完这一次，再翻就重读", async () => {
		const log = new FakeTaskActions(newest(1, 5), { pageSize: 2 });
		const reader = await open(log);
		log.pages.failNext("超时");
		await older(reader);
		expect(reader.get()).toMatchObject({ error: new Error("超时"), loadingOlder: false });
		expect(ids(reader)).toEqual([5, 4]);

		await older(reader);
		expect(ids(reader)).toEqual([5, 4, 3, 2]);
		expect(log.pages.reads).toEqual([{}, { before: "2" }, { before: "2" }]);
	});
});

describe("合并规则", () => {
	it("最新一页：按开始时间从新到旧保留，记下更早一页的游标、实时推送的起点和控制面兜底的只计数的段", async () => {
		const log = new FakeTaskActions([], { pageSize: 2 });
		log.pages.replyNext(
			actionPage([action(3, 300), action(2, 200)], "c2", [
				period("下单", 250),
				period("预热", 260, "name_limit"),
			]),
		);
		const reader = await open(log);
		expect(ids(reader)).toEqual([3, 2]);
		expect(reader.get().hasOlder).toBe(true);
		expect(log.live.connections.map((c) => c.after)).toEqual([7]);
		// SDK 上限的段由摘要算，不从分页取。
		expect(reader.get().controlPlanePeriods.map((s) => s.name)).toEqual(["下单"]);
	});

	it("更早的一页接在后面；和已有的重复的 ID 只留一条，只计数的段按名称去重；实时推送的起点仍是最新一页的修订号", async () => {
		const log = new FakeTaskActions([], { pageSize: 2 });
		log.pages.replyNext(actionPage([action(4, 400), action(3, 300)], "c3", [period("下单", 350)]));
		const reader = await open(log);
		log.pages.replyNext(
			actionPage(
				[action(3, 300), action(2, 200), mark(1, 100)],
				null,
				[period("下单", 350), period("预热", 150)],
				9,
			),
		);
		await older(reader);
		expect(ids(reader)).toEqual([4, 3, 2, 1]);
		expect(reader.get().hasOlder).toBe(false);
		expect(reader.get().controlPlanePeriods.map((s) => s.name)).toEqual(["下单", "预热"]);
		expect(log.live.connections.map((c) => c.after)).toEqual([7]);
	});

	it("推送来的新明细按开始时间插到它的位置；同一时刻开始的 ID 大的在前", async () => {
		const log = new FakeTaskActions([action(5, 500), action(3, 300), action(1, 100)], {
			pageSize: 10,
		});
		const reader = await open(log);
		log.emit([action(6, 600), action(4, 300), action(2, 200)]);
		expect(ids(reader)).toEqual([6, 5, 4, 3, 2, 1]);
	});

	it("推送来的明细已经有了：以后到的为准，位置不变", async () => {
		const log = new FakeTaskActions([action(3, 300, null), action(2, 200, null)], { pageSize: 10 });
		const reader = await open(log);
		log.emit([action(2, 200, "failed")]);
		expect(ids(reader)).toEqual([3, 2]);
		expect(reader.get().details[1]).toMatchObject({ id: 2, result: "failed", reason: "拒单" });
	});

	it("还有更早的页没读时，早于已读到的最早一条的推送不放进来：读那一页时会读到它；读到最早时都放进来", async () => {
		const log = new FakeTaskActions([action(5, 500), action(4, 400), action(2, 200)], {
			pageSize: 2,
		});
		const reader = await open(log);
		log.emit([action(6, 600), action(2, 200, "failed"), action(3, 400)]);
		expect(ids(reader)).toEqual([6, 5, 4]);

		// 已经读到最早的明细时，早的也放进来。
		const complete = new FakeTaskActions([action(5, 500)], { pageSize: 2 });
		const whole = await open(complete);
		complete.emit([action(2, 200, "failed")]);
		expect(ids(whole)).toEqual([5, 2]);
	});

	it("一批推送里同一个 ID 出现两次时取后一个", async () => {
		const log = new FakeTaskActions([], { pageSize: 10 });
		const reader = await open(log);
		log.emit([action(1, 100, null), action(1, 100, "success")]);
		expect(reader.get().details).toEqual([action(1, 100, "success")]);
	});

	it("筛选时只放进符合条件的推送", async () => {
		const log = new FakeTaskActions([], { pageSize: 10 });
		const reader = await open(log, { failed: true });
		log.emit([action(1, 100, "success"), action(2, 200, "failed"), mark(3, 300)]);
		expect(ids(reader)).toEqual([2]);
	});
});
