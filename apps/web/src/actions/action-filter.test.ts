import type { ActionNameCount, ActionSummaryView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { failedTotal, filterAnnouncement, isFiltered, withFailed, withName } from "./action-filter";

const count = (name: string, total: number, failed = 0): ActionNameCount => ({
	name,
	total,
	failed,
	reported: total,
	capped_at: null,
	agent_capped_at: null,
});

const summary = (names: ActionNameCount[], marks = 0): ActionSummaryView => ({
	total: names.reduce((n, c) => n + c.total, 0),
	marks,
	reported: 0,
	capped: false,
	control_plane_capped: false,
	capped_at: null,
	agent_capped_at: null,
	failed_total: names.reduce((n, c) => n + c.failed, 0),
	names,
	names_complete: true,
	unlisted: null,
	running: [],
	running_complete: true,
	lists_trimmed: false,
	recent: [],
	recent_failed: [],
});

describe("筛选条件", () => {
	it("名称或只看失败有一个就算筛选了", () => {
		expect(isFiltered({})).toBe(false);
		expect(isFiltered({ failed: false })).toBe(false);
		expect(isFiltered({ name: "下单" })).toBe(true);
		expect(isFiltered({ failed: true })).toBe(true);
	});

	it("同一个名称再点一次取消；换名称和只看失败互不影响", () => {
		expect(withName({ failed: true }, "下单")).toEqual({ name: "下单", failed: true });
		expect(withName({ name: "下单" }, "下单")).toEqual({});
		expect(withName({ name: "下单", failed: true }, "预热")).toEqual({
			name: "预热",
			failed: true,
		});
		expect(withName({ name: "下单" }, undefined)).toEqual({});
	});

	it("只看失败开关", () => {
		expect(withFailed({ name: "下单" }, true)).toEqual({ name: "下单", failed: true });
		expect(withFailed({ name: "下单", failed: true }, false)).toEqual({ name: "下单" });
	});
});

describe("失败的个数", () => {
	const s = summary([count("下单", 100, 17), count("预热", 1), count("撤单", 8, 3)]);

	it("不给名称是所有名称的失败总数，给了名称只算这个名称", () => {
		expect(failedTotal(s)).toBe(20);
		expect(failedTotal(s, "撤单")).toBe(3);
		expect(failedTotal(s, "预热")).toBe(0);
	});

	it("摘要里没有这个名称时是 0", () => {
		expect(failedTotal(s, "没有")).toBe(0);
	});

	it("名称表没列全时用合计好的失败数：没进表的名称的失败不在各项里，加起来会少算（#726）", () => {
		const partial: ActionSummaryView = {
			...summary([count("下单", 100, 2), count("预热", 1)]),
			failed_total: 7,
			names_complete: false,
			unlisted: { total: 40, failed: 5, reported: 40 },
		};
		expect(failedTotal(partial)).toBe(7); // 不是 2
		expect(failedTotal(partial, "下单")).toBe(2); // 给名称还是表里那一项
		expect(filterAnnouncement(partial, { failed: true })).toBe("筛选后 7 个动作");
	});
});

describe("读屏播报的筛选结果", () => {
	const names = [count("下单", 1_284_814, 17), count("预热", 1), count("收到第一笔成交", 1)];

	it("只看失败：失败的动作个数", () => {
		expect(filterAnnouncement(summary(names, 1), { failed: true })).toBe("筛选后 17 个动作");
		expect(filterAnnouncement(summary(names, 1), { name: "下单", failed: true })).toBe(
			"筛选后 17 个动作",
		);
	});

	it("按名称筛选：任务里没有标记时都是动作", () => {
		expect(filterAnnouncement(summary(names, 0), { name: "下单" })).toBe("筛选后 1,284,814 个动作");
	});

	it("按名称筛选：任务里有标记时，这个名称的个数里可能有标记，不说成都是动作", () => {
		expect(filterAnnouncement(summary(names, 1), { name: "下单" })).toBe(
			"筛选后 1,284,814 个动作和标记",
		);
	});

	it("名称不在摘要里（还没有推送到）是 0 个", () => {
		expect(filterAnnouncement(summary(names), { name: "新的" })).toBe("筛选后 0 个动作");
	});

	it("没有失败的动作时写 0 个，不写成没有结果", () => {
		expect(filterAnnouncement(summary([count("下单", 5)]), { failed: true })).toBe(
			"筛选后 0 个动作",
		);
	});

	it("清除筛选", () => {
		expect(filterAnnouncement(summary(names), {})).toBe("已清除筛选");
	});
});
