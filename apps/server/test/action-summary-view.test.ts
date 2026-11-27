import { ACTION_LIMITS } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	type ActionSummaryEvent,
	actionSummaryView,
	EMPTY_SUMMARY,
	parseActionSummary,
	summaryOfTask,
} from "../src/actions/action-summary.js";
import { NO_SECRETS } from "../src/logs/secrets.js";

// 摘要事件换成接口里的样子（#726 加的几项）：合计的失败数、名称表是不是全部、没列出的名称合计、列表有没有省去。
// 纯逻辑，不连库；旧的 SDK 写的摘要没有这几项，要按旧的写法补。

const at = (mono: number) => new Date(1_700_000_000_000 + mono);

const name = (index: number, failed = 0, total = 1) => ({
	name: `n${index}`,
	total,
	failed,
	reported: total,
	capped_ts: null,
	capped_mono: null,
});

const running = (id: number) => ({
	id,
	parent: null,
	depth: 0,
	name: `r${id}`,
	fields: {},
	ts: 1_700_000_000_000,
	mono: id,
});

const event = (parts: Partial<ActionSummaryEvent> = {}): ActionSummaryEvent => ({
	type: "action_summary",
	total: 0,
	marks: 0,
	reported: 0,
	capped_ts: null,
	capped_mono: null,
	names: [],
	running: [],
	recent: [],
	recent_failed: [],
	...parts,
});

const view = (parts: Partial<ActionSummaryEvent>) =>
	actionSummaryView(event(parts), at, NO_SECRETS).summary;

describe("新的 SDK 写的摘要", () => {
	it("合计的失败数、没列出的名称合计、名称表不是全部：原样带到接口里", () => {
		const summary = view({
			failed: 9,
			names: [name(0, 2)],
			names_complete: false,
			unlisted: { total: 40, failed: 7, reported: 30 },
		});
		expect(summary.failed_total).toBe(9); // 不是名称表里加起来的 2
		expect(summary.names_complete).toBe(false);
		expect(summary.unlisted).toEqual({ total: 40, failed: 7, reported: 30 });
	});

	it("名称都列出来了：names_complete 为 true，没有 unlisted", () => {
		const summary = view({ failed: 2, names: [name(0, 2)], names_complete: true, unlisted: null });
		expect(summary.failed_total).toBe(2);
		expect(summary.names_complete).toBe(true);
		expect(summary.unlisted).toBeNull();
	});

	it("正在做的是不是全部由 SDK 说：列满 50 个但正好是全部时为 true，列了 3 个但装不下时为 false", () => {
		const fifty = Array.from({ length: ACTION_LIMITS.running }, (_, i) => running(i + 1));
		expect(view({ running: fifty, running_complete: true }).running_complete).toBe(true);
		expect(view({ running: fifty, running_complete: false }).running_complete).toBe(false);
		expect(view({ running: fifty.slice(0, 3), running_complete: false }).running_complete).toBe(
			false,
		);
		expect(view({ running: fifty.slice(0, 3), running_complete: true }).running_complete).toBe(
			true,
		);
	});

	it("被改过的 SDK 写出超过 50 个正在做的：不论它怎么说都不算全部", () => {
		const many = Array.from({ length: ACTION_LIMITS.running + 1 }, (_, i) => running(i + 1));
		const summary = view({ running: many, running_complete: true });
		expect(summary.running).toHaveLength(ACTION_LIMITS.running);
		expect(summary.running_complete).toBe(false);
	});

	it("列表因为摘要的大小被省去了：lists_trimmed 带到接口里", () => {
		expect(view({ lists_trimmed: true }).lists_trimmed).toBe(true);
		expect(view({ lists_trimmed: false }).lists_trimmed).toBe(false);
	});
});

describe("旧的 SDK 写的摘要（没有这几项）", () => {
	it("失败数是名称表里各项加起来的，名称都列出来了，列表没有省去，正在做的按条数判断", () => {
		const summary = view({ names: [name(0, 2), name(1, 3)] });
		expect(summary.failed_total).toBe(5);
		expect(summary.names_complete).toBe(true);
		expect(summary.unlisted).toBeNull();
		expect(summary.lists_trimmed).toBe(false);
		expect(summary.running_complete).toBe(true);
		const fifty = Array.from({ length: ACTION_LIMITS.running }, (_, i) => running(i + 1));
		expect(view({ running: fifty }).running_complete).toBe(false); // 列满 50 个：可能有遗漏
	});

	it("名称超过控制面存的 1000 种：控制面自己截掉的也算没列出，合计和失败数照样准确", () => {
		const names = Array.from({ length: ACTION_LIMITS.summaryNames + 30 }, (_, i) =>
			name(i, i >= ACTION_LIMITS.summaryNames ? 1 : 0, 2),
		);
		const summary = view({ names });
		expect(summary.names).toHaveLength(ACTION_LIMITS.summaryNames);
		expect(summary.names_complete).toBe(false);
		expect(summary.unlisted).toEqual({ total: 60, failed: 30, reported: 60 });
		expect(summary.failed_total).toBe(30); // 截掉的名称的失败也数在里面
	});

	it("新的 SDK 加上控制面自己截掉的：没列出的合在一起", () => {
		const names = Array.from({ length: ACTION_LIMITS.summaryNames + 2 }, (_, i) => name(i, 0, 3));
		const summary = view({
			names,
			names_complete: false,
			unlisted: { total: 10, failed: 4, reported: 8 },
			failed: 4,
		});
		expect(summary.unlisted).toEqual({ total: 16, failed: 4, reported: 14 });
		expect(summary.failed_total).toBe(4);
	});
});

describe("之前存下的摘要（读出来时补上后来加的字段）", () => {
	it("没有后来加的字段：失败数用名称表里加起来的，别的取「全部列出、没有省去」", () => {
		const { failed_total, names_complete, unlisted, lists_trimmed, ...legacy } = {
			...EMPTY_SUMMARY,
			names: [
				{
					name: "下单",
					total: 5,
					failed: 2,
					reported: 5,
					capped_at: null,
					agent_capped_at: null,
				},
			],
		};
		expect([failed_total, names_complete, unlisted, lists_trimmed]).toEqual([0, true, null, false]);
		const summary = summaryOfTask({ status: "success", actionCapped: false }, legacy);
		expect(summary.failed_total).toBe(2);
		expect(summary.names_complete).toBe(true);
		expect(summary.unlisted).toBeNull();
		expect(summary.lists_trimmed).toBe(false);
	});

	it("新存的摘要原样读出", () => {
		const stored = { ...EMPTY_SUMMARY, failed_total: 7, names_complete: false, unlisted: null };
		const summary = summaryOfTask({ status: "running", actionCapped: false }, stored);
		expect([summary.failed_total, summary.names_complete]).toEqual([7, false]);
	});

	it("没有记录过动作的任务：合计的失败数是 0，名称都列出来了", () => {
		const summary = summaryOfTask({ status: "running", actionCapped: false }, null);
		expect([summary.failed_total, summary.names_complete, summary.unlisted]).toEqual([
			0,
			true,
			null,
		]);
	});
});

describe("解析", () => {
	it("新加的几项可以没有，也可以是 null（旧的 SDK 没有；没列出的名称为 null 时）", () => {
		const parsed = parseActionSummary(
			JSON.stringify({ ...event(), failed: 1, names_complete: true, unlisted: null }),
		);
		expect(parsed).toBeDefined();
		expect(parseActionSummary(JSON.stringify(event()))).toBeDefined();
	});

	it("新加的几项类型不对的不是合法的摘要", () => {
		expect(parseActionSummary(JSON.stringify({ ...event(), failed: "1" }))).toBeUndefined();
		expect(
			parseActionSummary(JSON.stringify({ ...event(), unlisted: { total: 1 } })),
		).toBeUndefined();
	});
});
