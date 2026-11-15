import type {
	ActionDetailView,
	ActionPage,
	ActionRecordDetail,
	ActionSummaryView,
	CountOnlySpan,
} from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	fromLatestPage,
	matchesFilter,
	newlyCapped,
	withLatestPage,
	withLive,
	withOlderPage,
} from "./action-details";

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** 第 id 个动作，在第 start 毫秒开始；不给 result 时还在做。 */
function action(
	id: number,
	start: number,
	result: ActionRecordDetail["result"] = "success",
	name = "下单",
): ActionRecordDetail {
	return {
		kind: "action",
		id,
		parent: null,
		depth: 0,
		name,
		fields: {},
		started_at: at(start),
		agent_started_at: at(start),
		result,
		ended_at: result === null ? null : at(start + 5),
		agent_ended_at: result === null ? null : at(start + 5),
		duration_ms: result === null ? null : 5,
		reason: result === "failed" ? "拒单" : null,
	};
}

const mark = (id: number, start: number, name = "首笔成交"): ActionDetailView => ({
	kind: "mark",
	id,
	parent: null,
	depth: 0,
	name,
	fields: {},
	started_at: at(start),
	agent_started_at: at(start),
});

const span = (name: string, from: number, count = 10): CountOnlySpan => ({
	name,
	reason: "name_limit",
	from: at(from),
	agent_from: at(from),
	to: null,
	count,
});

function page(
	actions: ActionDetailView[],
	before: string | null,
	countOnly: CountOnlySpan[] = [],
	rev = 7,
): ActionPage {
	return { task_id: "t", actions, before, count_only: countOnly, rev, expired: false };
}

const ids = (details: readonly ActionDetailView[]) => details.map((d) => d.id);

describe("动作明细的合并", () => {
	it("最新一页：按开始时间从新到旧保留，记下更早一页的游标和实时推送的起点", () => {
		const d = fromLatestPage(page([action(3, 300), action(2, 200)], "c2", [span("下单", 250)]));
		expect(ids(d.details)).toEqual([3, 2]);
		expect(d.before).toBe("c2");
		expect(d.rev).toBe(7);
		expect(d.countOnly).toHaveLength(1);
	});

	it("更早的一页接在后面；和已有的重复的 ID 只留一条，只计数的段按名称和原因去重", () => {
		const first = fromLatestPage(page([action(4, 400), action(3, 300)], "c3", [span("下单", 350)]));
		const d = withOlderPage(
			first,
			page(
				[action(3, 300), action(2, 200), mark(1, 100)],
				null,
				[span("下单", 350), span("预热", 150)],
				9,
			),
		);
		expect(ids(d.details)).toEqual([4, 3, 2, 1]);
		expect(d.before).toBeNull();
		expect(d.countOnly.map((s) => s.name)).toEqual(["下单", "预热"]);
		// 实时推送接着最新一页的修订号，更早一页的不算
		expect(d.rev).toBe(7);
	});

	it("推送来的新明细按开始时间插到它的位置；同一时刻开始的 ID 大的在前", () => {
		const first = fromLatestPage(page([action(5, 500), action(3, 300), action(1, 100)], null));
		const d = withLive(first, [action(6, 600), action(4, 300), action(2, 200)]);
		expect(ids(d.details)).toEqual([6, 5, 4, 3, 2, 1]);
	});

	it("推送来的明细已经有了：以后到的为准，位置不变", () => {
		const first = fromLatestPage(page([action(3, 300, null), action(2, 200, null)], null));
		const d = withLive(first, [action(2, 200, "failed")]);
		expect(ids(d.details)).toEqual([3, 2]);
		expect(d.details[1]).toMatchObject({ id: 2, result: "failed", reason: "拒单" });
		expect(ids(d.details)).toHaveLength(new Set(ids(d.details)).size);
	});

	it("还有更早的页没读时，早于已读到的最早一条的推送不放进来：读那一页时会读到它", () => {
		const first = fromLatestPage(page([action(5, 500), action(4, 400)], "c4"));
		const d = withLive(first, [action(6, 600), action(2, 200, "failed"), action(3, 400)]);
		expect(ids(d.details)).toEqual([6, 5, 4]);
		// 已经读到最早时都放进来
		const all = withLive(fromLatestPage(page([action(5, 500)], null)), [action(2, 200, "failed")]);
		expect(ids(all.details)).toEqual([5, 2]);
	});

	it("一批推送里同一个 ID 出现两次时取后一个", () => {
		const first = fromLatestPage(page([], null));
		const d = withLive(first, [action(1, 100, null), action(1, 100, "success")]);
		expect(d.details).toEqual([action(1, 100, "success")]);
	});

	it("筛选时只放进符合条件的推送", () => {
		const first = fromLatestPage(page([], null));
		const filter = { failed: true };
		const d = withLive(
			first,
			[action(1, 100, "success"), action(2, 200, "failed"), mark(3, 300)],
			(a) => matchesFilter(a, filter),
		);
		expect(ids(d.details)).toEqual([2]);
	});

	it("重新读最新一页：明细合并去重，只计数的段以新读到的为准，游标和推送的起点不变", () => {
		const loaded = withOlderPage(
			fromLatestPage(page([action(4, 400)], "c4", [], 7)),
			page([action(3, 300)], "c3", [span("预热", 350)]),
		);
		const d = withLatestPage(
			loaded,
			page([action(5, 500), action(4, 400)], "c4", [span("下单", 450, 3)], 12),
		);
		expect(ids(d.details)).toEqual([5, 4, 3]);
		expect(d.countOnly.map((s) => [s.name, s.count])).toEqual([
			["下单", 3],
			["预热", 10],
		]);
		expect(d.before).toBe("c3");
		expect(d.rev).toBe(7);
	});
});

describe("筛选条件", () => {
	it("按名称：动作和标记都按名称；只看失败：只有失败的动作", () => {
		expect(matchesFilter(action(1, 0, "success", "预热"), { name: "预热" })).toBe(true);
		expect(matchesFilter(mark(2, 0, "预热"), { name: "预热" })).toBe(true);
		expect(matchesFilter(action(3, 0, "success", "下单"), { name: "预热" })).toBe(false);
		expect(matchesFilter(action(4, 0, "failed"), { failed: true })).toBe(true);
		expect(matchesFilter(action(5, 0, null), { failed: true })).toBe(false);
		expect(matchesFilter(mark(6, 0), { failed: true })).toBe(false);
		expect(matchesFilter(mark(7, 0), {})).toBe(true);
	});
});

describe("有名称刚开始只计数", () => {
	const summary = (capped: Record<string, number | null>): ActionSummaryView => ({
		total: 0,
		marks: 0,
		reported: 0,
		capped: false,
		capped_at: null,
		agent_capped_at: null,
		names: Object.entries(capped).map(([name, from]) => ({
			name,
			total: 1,
			failed: 0,
			reported: 1,
			capped_at: from === null ? null : at(from),
			agent_capped_at: from === null ? null : at(from),
		})),
		running: [],
		running_complete: true,
		recent: [],
		recent_failed: [],
	});

	it("某个名称从有明细变成只计数时为 true，已经只计数的不算", () => {
		expect(newlyCapped(summary({ 下单: null }), summary({ 下单: 100 }))).toBe(true);
		expect(newlyCapped(summary({ 下单: 100 }), summary({ 下单: 100, 预热: null }))).toBe(false);
		expect(newlyCapped(summary({ 下单: 100 }), summary({ 下单: 100, 预热: 300 }))).toBe(true);
		expect(newlyCapped(summary({}), summary({}))).toBe(false);
	});

	it("没有上一份摘要时不算", () => {
		expect(newlyCapped(undefined, summary({ 下单: 100 }))).toBe(false);
	});
});
