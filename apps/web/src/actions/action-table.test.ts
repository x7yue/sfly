import type {
	ActionDetailView,
	ActionNameCount,
	ActionRecordDetail,
	ActionSummaryView,
	CountOnlyPeriod,
	EndedActionView,
	RunningActionView,
} from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { fromLatestPage, withLive } from "./action-details";
import {
	type ActionRow,
	type ActionTableGroup,
	actionCount,
	actionTable,
	groupNotes,
} from "./action-table";

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const at = (ms: number) => new Date(T0 + ms).toISOString();

const running = (id: number, start: number, depth = 0, name = "保持"): RunningActionView => ({
	id,
	parent: depth === 0 ? null : id - 1,
	depth,
	name,
	fields: {},
	started_at: at(start),
	agent_started_at: at(start),
});

const ended = (
	id: number,
	start: number,
	result: EndedActionView["result"] = "success",
): EndedActionView => ({
	...running(id, start, 1, "下单"),
	ended_at: at(start + 7),
	agent_ended_at: at(start + 7),
	duration_ms: 7,
	result,
	reason: result === "failed" ? "拒单：余额不足" : null,
});

function detail(
	id: number,
	start: number,
	result: ActionRecordDetail["result"] = "success",
	depth = 1,
): ActionRecordDetail {
	return {
		kind: "action",
		id,
		parent: null,
		depth,
		name: "下单",
		fields: { 订单: `P-${id}` },
		started_at: at(start),
		agent_started_at: at(start),
		result,
		ended_at: result === null ? null : at(start + 9),
		agent_ended_at: result === null ? null : at(start + 9),
		duration_ms: result === null ? null : 9,
		reason: result === "failed" ? "超时" : null,
	};
}

const mark = (id: number, start: number): ActionDetailView => ({
	kind: "mark",
	id,
	parent: null,
	depth: 1,
	name: "首笔成交",
	fields: {},
	started_at: at(start),
	agent_started_at: at(start),
});

/** 一种名称的计数：给了 `cappedAt`（毫秒）就是从那时起只计数，`total − reported` 个没有明细。 */
const count = (
	name: string,
	total: number,
	reported = total,
	cappedAt?: number,
	failed = 0,
): ActionNameCount => ({
	name,
	total,
	failed,
	reported,
	capped_at: cappedAt === undefined ? null : at(cappedAt),
	agent_capped_at: cappedAt === undefined ? null : at(cappedAt),
});

function summary(parts: Partial<ActionSummaryView> = {}): ActionSummaryView {
	return {
		total: 0,
		marks: 0,
		reported: 0,
		capped: false,
		capped_at: null,
		agent_capped_at: null,
		names: [],
		running: [],
		running_complete: true,
		recent: [],
		recent_failed: [],
		...parts,
	};
}

/** 控制面兜底的一段（分页读到的）。 */
const dropped = (name: string, from: number, count = 40): CountOnlyPeriod => ({
	name,
	reason: "control_plane",
	from: at(from),
	agent_from: at(from),
	to: null,
	count,
});

const table = (
	parts: Partial<Parameters<typeof actionTable>[0]> & { summary?: ActionSummaryView } = {},
) =>
	actionTable({
		summary: summary(),
		details: [],
		controlPlanePeriods: [],
		hasOlder: false,
		endedAt: null,
		...parts,
	});

/** 每组的行写成「组名: 行」：动作和标记写 ID，只计数的段写 `~名称`。 */
const shape = (groups: ActionTableGroup[]) =>
	groups.map((g) => [g.name, g.rows.map((r) => (r.kind === "count-only" ? `~${r.name}` : r.id))]);

const rowOf = (groups: ActionTableGroup[], id: number) =>
	groups.flatMap((g) => g.rows).find((r) => r.kind !== "count-only" && r.id === id) as Exclude<
		ActionRow,
		{ kind: "count-only" }
	>;

describe("动作表的三组", () => {
	it("正在做、最近 20 个取摘要，更早的明细取分页读到的；每组按开始时间从新到旧", () => {
		const groups = table({
			summary: summary({
				running: [running(1, 100), running(9, 900, 1)],
				recent: [ended(8, 800), ended(7, 850)],
			}),
			details: [detail(6, 600), detail(5, 500)],
		});
		expect(shape(groups)).toEqual([
			["running", [9, 1]],
			["recent", [7, 8]],
			["earlier", [6, 5]],
		]);
	});

	it("已经在正在做或最近 20 个里的 ID 不在更早的明细里重复", () => {
		const groups = table({
			summary: summary({ running: [running(9, 900)], recent: [ended(8, 800)] }),
			details: [detail(9, 900, null), detail(8, 800), detail(7, 700)],
		});
		expect(shape(groups)).toEqual([
			["running", [9]],
			["recent", [8]],
			["earlier", [7]],
		]);
	});

	it("没有行的组不出现；标记和摘要里没列出的正在做的明细都在更早的明细里", () => {
		const groups = table({ details: [detail(3, 300, null), mark(2, 200)] });
		expect(shape(groups)).toEqual([["earlier", [3, 2]]]);
		expect(rowOf(groups, 3)).toMatchObject({ kind: "action", outcome: { status: "running" } });
		expect(rowOf(groups, 2)).toMatchObject({ kind: "mark", name: "首笔成交" });
		expect(table()).toEqual([]);
	});
});

describe("动作表的行", () => {
	it("结果：进行中没有耗时；成功、未结束带耗时；失败带完整的原因", () => {
		const groups = table({
			summary: summary({ running: [running(9, 900)], recent: [ended(8, 800, "failed")] }),
			details: [detail(7, 700, "unfinished"), detail(6, 600, "success")],
		});
		expect(rowOf(groups, 9)).toMatchObject({ outcome: { status: "running" } });
		expect(rowOf(groups, 8)).toMatchObject({
			outcome: { status: "failed", durationMs: 7, reason: "拒单：余额不足" },
		});
		expect(rowOf(groups, 7)).toMatchObject({ outcome: { status: "unfinished", durationMs: 9 } });
		expect(rowOf(groups, 6)).toMatchObject({
			outcome: { status: "success", durationMs: 9 },
			fields: { 订单: "P-6" },
			startedAt: at(600),
		});
	});

	it("子动作按层级缩进，最多 3 层，更深的画在第 3 层", () => {
		const groups = table({
			summary: summary({ running: [running(1, 100, 0), running(2, 200, 2), running(3, 300, 5)] }),
		});
		expect(groups[0]?.rows.map((r) => r.kind !== "count-only" && r.indent)).toEqual([3, 2, 0]);
	});
});

describe("只计数的段", () => {
	it("放在开始时间早于它起点的第一条明细前面", () => {
		const groups = table({
			details: [detail(5, 500), detail(4, 400), detail(3, 300)],
			controlPlanePeriods: [dropped("下单", 450), dropped("预热", 350)],
		});
		expect(shape(groups)).toEqual([["earlier", [5, "~下单", 4, "~预热", 3]]]);
	});

	it("和明细同一时刻开始的放在那条明细后面；比全部明细都早的放在最后，比全部都晚的放在最前", () => {
		const groups = table({
			details: [detail(5, 500), detail(4, 400)],
			controlPlanePeriods: [dropped("预热", 100), dropped("下单", 400), dropped("加压", 900)],
		});
		expect(shape(groups)).toEqual([["earlier", ["~加压", 5, 4, "~下单", "~预热"]]]);
	});

	it("没有更早的明细时，只计数的段自己组成「更早的明细」；不跟着已经去重的明细走", () => {
		const groups = table({
			summary: summary({ recent: [ended(4, 400)] }),
			details: [detail(4, 400)],
			controlPlanePeriods: [dropped("下单", 300)],
		});
		expect(shape(groups)).toEqual([
			["recent", [4]],
			["earlier", ["~下单"]],
		]);
	});

	it("SDK 上限的段由摘要算出：每种名称一段，从只计数的时刻起，个数是没有明细的那些；原因按先碰到的上限", () => {
		const groups = table({
			summary: summary({
				capped_at: at(500),
				names: [count("下单", 50_300, 50_000, 300), count("预热", 9), count("撤单", 120, 100, 600)],
			}),
			controlPlanePeriods: [dropped("加压", 200, 5)],
		});
		expect(groups[0]?.rows).toMatchObject([
			{ kind: "count-only", name: "撤单", reason: "total_limit", from: at(600), count: 20 },
			{ kind: "count-only", name: "下单", reason: "name_limit", from: at(300), count: 300 },
			{ kind: "count-only", name: "加压", reason: "control_plane", from: at(200), count: 5 },
		]);
	});

	it("打开时还没超出上限，之后某个名称开始只计数、期间又推送来很多明细：这一段出现在它开始的位置", () => {
		const opened = fromLatestPage({
			task_id: "t",
			actions: Array.from({ length: 200 }, (_, i) => detail(1000 - i, 10_000 - i * 10)),
			before: "c801",
			count_only: [],
			rev: 7,
			expired: false,
		});
		const before = table({
			summary: summary({ names: [count("下单", 1000)] }),
			details: opened.details,
			hasOlder: true,
		});
		expect(before.flatMap((g) => g.rows).some((r) => r.kind === "count-only")).toBe(false);

		// 推送来 500 条更新的明细，「下单」从第 12 秒起只计数：比重新读一次最新一页的最早一条还早。
		const pushed = Array.from({ length: 500 }, (_, i) => detail(1001 + i, 10_010 + i * 10));
		const later = withLive(opened, pushed);
		const groups = table({
			summary: summary({ names: [count("下单", 1800, 1500, 12_000)] }),
			details: later.details,
			hasOlder: later.before !== null,
		});
		const earlier = shape(groups).find(([name]) => name === "earlier")?.[1] ?? [];
		const at12s = earlier.indexOf("~下单");
		expect(earlier.slice(at12s - 1, at12s + 2)).toEqual([1200, "~下单", 1199]);
		expect(groups.flatMap((g) => g.rows).find((r) => r.kind === "count-only")).toMatchObject({
			count: 300,
		});
	});

	it("还有更早的明细没读时，起点早于已读到的最早一条的段先不显示；读到最早的明细以后显示在最后", () => {
		const parts = {
			summary: summary({ names: [count("下单", 500, 400, 100)] }),
			details: [detail(4, 400), detail(3, 300)],
		};
		expect(shape(table({ ...parts, hasOlder: true }))).toEqual([["earlier", [4, 3]]]);
		expect(shape(table({ ...parts, hasOlder: false }))).toEqual([["earlier", [4, 3, "~下单"]]]);
	});

	it("还在执行时到「至今」；任务结束后到任务的结束时间", () => {
		const capped = summary({ names: [count("下单", 500, 400, 300)] });
		expect(table({ summary: capped })[0]?.rows[0]).toMatchObject({ until: null });
		expect(table({ summary: capped, endedAt: at(5000) })[0]?.rows[0]).toMatchObject({
			until: at(5000),
		});
		const done = table({
			controlPlanePeriods: [{ ...dropped("下单", 300), to: at(4000) }],
			endedAt: at(5000),
		});
		expect(done[0]?.rows[0]).toMatchObject({ until: at(4000) });
	});
});

describe("筛选", () => {
	const other = (id: number, start: number): EndedActionView => ({
		...ended(id, start),
		name: "预热",
	});
	const parts = {
		summary: summary({
			running: [running(1, 100), { ...running(2, 200, 1), name: "预热" }],
			recent: [ended(8, 800), ended(7, 700, "failed"), other(6, 600)],
		}),
		details: [detail(5, 500, "failed"), detail(4, 400), { ...detail(3, 300), name: "预热" }],
	};

	it("按名称：正在做、最近 20 个和更早的明细都只留这个名称的", () => {
		expect(shape(table({ ...parts, filter: { name: "预热" } }))).toEqual([
			["running", [2]],
			["recent", [6]],
			["earlier", [3]],
		]);
	});

	it("只看失败：正在做的还没有结果，不算失败；最近 20 个和更早的明细只留失败的", () => {
		expect(shape(table({ ...parts, filter: { failed: true } }))).toEqual([
			["recent", [7]],
			["earlier", [5]],
		]);
	});

	it("名称和只看失败一起用", () => {
		expect(shape(table({ ...parts, filter: { name: "下单", failed: true } }))).toEqual([
			["recent", [7]],
			["earlier", [5]],
		]);
		expect(table({ ...parts, filter: { name: "预热", failed: true } })).toEqual([]);
	});

	it("标记不是失败的动作：只看失败时不出现", () => {
		const groups = table({
			details: [mark(2, 200), detail(1, 100, "failed")],
			filter: { failed: true },
		});
		expect(shape(groups)).toEqual([["earlier", [1]]]);
	});

	it("换筛选条件时缓冲里还是上一个条件读到的明细：不符合的不显示", () => {
		expect(shape(table({ details: parts.details, filter: { name: "预热" } }))).toEqual([
			["earlier", [3]],
		]);
	});

	it("筛选了名称：只留这个名称的只计数的段", () => {
		const capped = summary({
			capped_at: at(500),
			names: [count("下单", 50_300, 50_000, 300), count("撤单", 120, 100, 600)],
		});
		const groups = table({
			summary: capped,
			controlPlanePeriods: [dropped("加压", 200, 5)],
			filter: { name: "撤单" },
		});
		expect(shape(groups)).toEqual([["earlier", ["~撤单"]]]);
	});
});

describe("只看失败时只计数的段", () => {
	/** 「下单」从 300 起每种名称的上限、合计满在 500，共 17 个失败。 */
	const full = summary({
		capped_at: at(500),
		names: [
			count("下单", 50_300, 50_000, 300, 17),
			count("预热", 900, 800, 700, 0),
			count("撤单", 120, 100, 600, 2),
		],
	});
	const rows = (groups: ActionTableGroup[]) =>
		groups.flatMap((g) => g.rows).filter((r) => r.kind === "count-only");

	it("合计已满：这一段的个数包括成功的，失败的个数不知道，只写这个名称一共失败多少个", () => {
		expect(rows(table({ summary: full, filter: { failed: true } }))).toMatchObject([
			{ name: "撤单", reason: "total_limit", count: 20, failedGap: { total: 2 } },
			{ name: "下单", reason: "name_limit", count: 300, failedGap: { total: 17 } },
		]);
	});

	it("这个名称一个都没有失败过：没有失败的明细缺口，这一段不显示", () => {
		const names = rows(table({ summary: full, filter: { failed: true } })).map((r) => r.name);
		expect(names).not.toContain("预热");
		expect(rows(table({ summary: full })).map((r) => r.name)).toContain("预热");
	});

	it("合计没满：超过每种名称上限之后失败的动作仍有明细，这一段不显示", () => {
		const open = { ...full, capped_at: null };
		expect(rows(table({ summary: open, filter: { failed: true } }))).toEqual([]);
	});

	it("控制面兜底丢弃的段：失败的个数同样不知道；摘要里还没有这个名称时不知道一共失败多少个", () => {
		const groups = table({
			summary: full,
			controlPlanePeriods: [dropped("下单", 450, 40), dropped("新的", 100, 5)],
			filter: { failed: true },
		});
		expect(rows(groups)).toMatchObject([
			{ name: "撤单", failedGap: { total: 2 } },
			{ name: "下单", reason: "control_plane", count: 40, failedGap: { total: 17 } },
			{ name: "下单", reason: "name_limit" },
			{ name: "新的", reason: "control_plane", failedGap: { total: null } },
		]);
	});

	it("没有筛选失败时不带这个说明", () => {
		expect(rows(table({ summary: full }))[0]).toMatchObject({ failedGap: null });
		expect(rows(table({ summary: full, filter: { name: "下单" } }))[0]).toMatchObject({
			failedGap: null,
		});
	});

	it("合计已满时，名称上限的段说明合计也满了：之后失败的也没有明细", () => {
		expect(rows(table({ summary: full }))).toMatchObject([
			{ name: "预热", totalFull: true },
			{ name: "撤单", totalFull: true },
			{ name: "下单", reason: "name_limit", totalFull: true },
		]);
		expect(rows(table({ summary: { ...full, capped_at: null } }))[0]).toMatchObject({
			totalFull: false,
		});
	});
});

describe("页签上的动作个数", () => {
	it("标记不算", () => {
		expect(actionCount(summary({ total: 1_284_820, marks: 1 }))).toBe(1_284_819);
	});
});

describe("三组的说明", () => {
	const notes = (
		parts: Partial<Parameters<typeof groupNotes>[0]> & { summary?: ActionSummaryView } = {},
	) =>
		groupNotes({
			summary: summary(),
			controlPlanePeriods: [],
			hasOlder: false,
			failedOnly: false,
			...parts,
		});

	it("没有超出上限、没有筛选：没有说明", () => {
		expect(notes()).toEqual({});
	});

	it("正在做的列满 50 个：说可能还有没列出的", () => {
		const listed = Array.from({ length: 50 }, (_, i) => running(i + 1, i));
		expect(notes({ summary: summary({ running: listed, running_complete: false }) }).running).toBe(
			"列满 50 个，可能还有没列出的",
		);
	});

	it("最近 20 个：SDK 超出上限、或者读到了控制面丢弃的段，才写超过上限后也一直更新", () => {
		expect(notes({ summary: summary({ capped: true }) }).recent).toBe("超过上限后也一直更新");
		expect(notes({ controlPlanePeriods: [dropped("下单", 500)] }).recent).toBe(
			"超过上限后也一直更新",
		);
	});

	describe("只看失败时第三组", () => {
		const earlier = (parts: Parameters<typeof notes>[0]) =>
			notes({ failedOnly: true, ...parts }).earlier;

		it("没有筛选时不写", () => {
			expect(notes({ summary: summary({ capped_at: at(3_000) }) }).earlier).toBeUndefined();
		});

		it("合计没满、更早的页都读完了、没有控制面丢弃的段：失败的动作都有明细", () => {
			expect(earlier({})).toBe("失败的动作仍有明细");
		});

		it("合计满了：失败的动作也没有明细，有没有控制面丢弃的段都一样", () => {
			const full = summary({ capped_at: at(3_000) });
			expect(earlier({ summary: full })).toBe("合计满 10 万个以后，失败的动作也没有明细");
			expect(earlier({ summary: full, controlPlanePeriods: [dropped("下单", 500)] })).toBe(
				"合计满 10 万个以后，失败的动作也没有明细",
			);
		});

		it("合计没满、读到了控制面丢弃的段：控制面丢弃的除外", () => {
			expect(earlier({ controlPlanePeriods: [dropped("下单", 500)] })).toBe(
				"失败的动作仍有明细，控制面丢弃的除外",
			);
		});

		it("合计没满、更早的页还没读完：不知道有没有控制面丢弃的段，也写除外", () => {
			expect(earlier({ hasOlder: true })).toBe("失败的动作仍有明细，控制面丢弃的除外");
		});
	});
});
