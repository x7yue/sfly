import type { RunFocus, RunFocusItem, RunningTaskView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { formatClock } from "#/lib/format";
import { slotContent } from "./slot-content";

const NOW = "2026-01-01T00:10:00.000Z";
const at = (secondsAgo: number) => new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString();

const task = (patch: Partial<RunningTaskView> = {}): RunningTaskView => ({
	task_id: "t1",
	run_id: "r1",
	orchestration_id: "o1",
	orchestration_name: "撮合浸泡",
	node_id: "load",
	node_type: "trade-sim/order_load",
	chain_instance_id: "c1",
	chain_name: null,
	attempt: 1,
	status: "running",
	started_at: at(600),
	current_action: null,
	progress: null,
	...patch,
});

const item = (patch: Partial<RunFocusItem> = {}): RunFocusItem => ({
	position: 1,
	node_id: "load",
	chart: "母单量",
	title: "母单量",
	chart_type: "stat",
	unit: "单",
	source: {
		status: "running",
		attempt: 1,
		task_id: "t1",
		chain_instance_id: "c1",
		started_at: at(600),
		ended_at: null,
	},
	latest: { value: 1284814, metric: "orders", labels: {}, at: at(2) },
	metrics: [{ name: "orders", label_keys: [] }],
	series: [],
	bucket_seconds: 1,
	last_at: at(2),
	sample_interval_ms: null,
	final: false,
	anomaly: null,
	...patch,
});

const focus = (items: RunFocusItem[], mode: RunFocus["mode"] = "focus"): RunFocus => ({
	generated_at: NOW,
	mode,
	expired: false,
	items,
});

const warn = {
	kind: "log" as const,
	level: "warn" as const,
	at: "2026-01-01T00:08:41.000Z",
	message: "超时",
};

describe("槽位格里的内容", () => {
	it("没有动作、没有进度、没有读数时什么都没有，可访问名称不加说明", () => {
		expect(slotContent(task(), undefined)).toEqual({
			activity: null,
			focus: null,
			summary: undefined,
		});
		expect(slotContent(task(), focus([]))).toEqual({
			activity: null,
			focus: null,
			summary: undefined,
		});
	});

	it("有正在做的动作取动作；没有动作取进度的说明；可访问名称写「正在做 X」", () => {
		const hold = { name: "保持 4 小时", started_at: at(6180) };
		const action = slotContent(task({ current_action: hold }), undefined);
		expect(action.activity).toEqual({
			kind: "action",
			name: "保持 4 小时",
			startedAt: Date.parse(hold.started_at),
		});
		expect(action.summary).toBe("正在做 保持 4 小时");

		const progress = { current: 3, total: 10, message: "第 3 批", time: null, agent_time: null };
		const message = slotContent(task({ progress }), undefined);
		expect(message.activity).toEqual({ kind: "progress", message: "第 3 批" });
		expect(message.summary).toBe("正在做 第 3 批");
	});

	it("派发阶段（还没开始执行）的任务没有「正在做」", () => {
		const progress = { current: 3, total: 10, message: "第 3 批", time: null, agent_time: null };
		expect(
			slotContent(task({ status: "dispatched", started_at: null, progress }), undefined),
		).toEqual({ activity: null, focus: null, summary: undefined });
	});

	it("只取来源是这个任务的关注项：同一个运行里别的任务、同一个节点别的链实例的项不算", () => {
		const mine = item({ title: "母单量" });
		const other = item({
			title: "子单量",
			node_id: "noise",
			source: { ...mine.source, task_id: "t2" },
		});
		const content = slotContent(task(), focus([other, mine]));
		expect(content.focus?.shown.map((i) => i.title)).toEqual(["母单量"]);
		expect(content.focus?.more).toBe(0);
		expect(slotContent(task({ task_id: "t3" }), focus([mine, other])).focus).toBeNull();
	});

	it("前两个关注项按读数的顺序（控制面把有异常的排在最前，这里不再排），多出的算在「还有」里", () => {
		const items = [
			item({ title: "丙", anomaly: warn }),
			item({ title: "甲" }),
			item({ title: "乙" }),
			item({ title: "丁" }),
		];
		const content = slotContent(task(), focus(items));
		expect(content.focus?.shown.map((i) => i.title)).toEqual(["丙", "甲"]);
		expect(content.focus?.more).toBe(2);
		expect(content.focus?.generatedAt).toBe(NOW);
	});

	it("可访问名称写出有异常的关注项的个数、名称和原因；有几项写几项，不只是显示出来的两项", () => {
		const items = [
			item({ title: "下单延迟", anomaly: warn }),
			item({ title: "母单量" }),
			item({
				title: "内存",
				anomaly: { kind: "stale", at: at(130), message: "" },
			}),
			item({ title: "CPU", anomaly: warn }),
		];
		const content = slotContent(
			task({ current_action: { name: "保持 4 小时", started_at: at(60) } }),
			focus(items),
		);
		const clock = formatClock(warn.at);
		expect(content.summary).toBe(
			`正在做 保持 4 小时，3 项需要注意：下单延迟 1 条 WARN · ${clock}；内存 已 2m 10s 无新数据；CPU 1 条 WARN · ${clock}`,
		);
	});

	it("没设关注项时是主指标，标出是主指标，模式带出去让格子写明原因", () => {
		const content = slotContent(
			task(),
			focus([item({ title: "level", chart_type: "stat" })], "primary"),
		);
		expect(content.focus?.mode).toBe("primary");
		expect(content.focus?.shown.map((i) => i.title)).toEqual(["level"]);
	});
});
