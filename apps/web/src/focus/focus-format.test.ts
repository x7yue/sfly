import type { FocusSource, MetricDeclaration, RunFocusItem } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { chartLines } from "#/monitor/charts";
import {
	focusSeriesName,
	formatAgo,
	latestSeriesName,
	readingFoot,
	readingLabel,
	readingState,
	valueText,
} from "./focus-format";

const NOW = "2026-01-01T00:10:00.000Z";
const at = (secondsAgo: number) => new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString();

function item(patch: Partial<RunFocusItem> = {}): RunFocusItem {
	return {
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
		series: [{ metric: "orders", labels: {}, points: [] }],
		bucket_seconds: 1,
		last_at: at(2),
		sample_interval_ms: null,
		final: false,
		anomaly: null,
		...patch,
	};
}

describe("多久前", () => {
	it("一分钟以内写秒，之后写分秒、时分", () => {
		expect(formatAgo(0)).toBe("0s");
		expect(formatAgo(2400)).toBe("2s");
		expect(formatAgo(59_999)).toBe("59s");
		expect(formatAgo(130_000)).toBe("2m 10s");
		expect(formatAgo(3_720_000)).toBe("1h 02m");
	});

	it("时间倒退（读数早于最后一个点）当作 0", () => {
		expect(formatAgo(-5000)).toBe("0s");
	});
});

describe("读数的文字", () => {
	it("最新值：数值卡写累计值，没有数据写破折号", () => {
		expect(valueText(item())).toBe("1.3M");
		expect(valueText(item({ latest: null }))).toBe("—");
	});

	it("脚注：节点 · 多久前；成功或已停止后是最终值", () => {
		expect(readingFoot(item(), NOW)).toBe("load · 2s 前");
		expect(readingFoot(item({ final: true }), NOW)).toBe("load · 最终值");
	});

	it("来源节点有显示名称时写成「显示名称（节点 ID）」，脚注和可访问名称都一样", () => {
		const named = item({ display_name: "压测" });
		expect(readingFoot(named, NOW)).toBe("压测（load） · 2s 前");
		expect(readingLabel(named, NOW)).toBe("母单量 1.3M 单，来自 压测（load）（执行中），2s 前");
	});

	it("最新值来自哪个序列：多个指标写指标名，带标签写标签值", () => {
		expect(latestSeriesName(item())).toBe("");
		const cpu = item({
			metrics: [{ name: "cpu", label_keys: ["pid", "host"] }],
			latest: { value: 3, metric: "cpu", labels: { pid: "100", host: "a" }, at: at(1) },
		});
		expect(latestSeriesName(cpu)).toBe("100 · a");
		const both = item({
			metrics: [
				{ name: "p50", label_keys: [] },
				{ name: "p99", label_keys: [] },
			],
			latest: { value: 3, metric: "p99", labels: {}, at: at(1) },
			series: [],
		});
		expect(latestSeriesName(both)).toBe("p99");
		expect(latestSeriesName(item({ latest: null }))).toBe("");
	});

	it("可访问名称：名称、值、来源节点和状态、多久前或最终值", () => {
		expect(readingLabel(item(), NOW)).toBe("母单量 1.3M 单，来自 load（执行中），2s 前");
		expect(
			readingLabel(
				item({
					final: true,
					source: { ...item().source, status: "success", ended_at: at(1) },
				}),
				NOW,
			),
		).toBe("母单量 1.3M 单，来自 load（成功），最终值");
		expect(readingLabel(item({ unavailable: "chart_missing", latest: null }), NOW)).toBe(
			"母单量，这个版本的节点没有图表「母单量」，来自 load（执行中）",
		);
	});
});

describe("序列的名字和详情里同一条序列的一样", () => {
	const cpu: MetricDeclaration = { name: "cpu", unit: "%", kind: "gauge", labels: ["pid", "host"] };
	const mem: MetricDeclaration = { name: "mem", unit: "MB", kind: "gauge" };
	const detailNames = (
		names: string[],
		series: Array<{ name: string; labels: Record<string, string> }>,
	) =>
		chartLines(
			names,
			[cpu, mem],
			series.map((s) => ({ ...s, buckets: [] })),
		).map((line) => line.name);

	it("标签值按声明的标签键的顺序排，不按键名排", () => {
		const labels = { host: "a", pid: "100" };
		const overview = item({
			metrics: [{ name: "cpu", label_keys: ["pid", "host"] }],
			latest: { value: 3, metric: "cpu", labels, at: at(1) },
		});
		expect(latestSeriesName(overview)).toBe("100 · a");
		expect(latestSeriesName(overview)).toBe(detailNames(["cpu"], [{ name: "cpu", labels }])[0]);
	});

	it("图表读了好几个指标时前面写指标名，序列还没有点（points 为 0）时也一样", () => {
		const labels = { pid: "100", host: "a" };
		const overview = item({
			metrics: [
				{ name: "cpu", label_keys: ["pid", "host"] },
				{ name: "mem", label_keys: [] },
			],
			series: [],
		});
		expect(focusSeriesName(overview, { metric: "cpu", labels })).toBe("cpu · 100 · a");
		expect(focusSeriesName(overview, { metric: "mem", labels: {} })).toBe("mem");
		expect([
			focusSeriesName(overview, { metric: "cpu", labels }),
			focusSeriesName(overview, { metric: "mem", labels: {} }),
		]).toEqual(
			detailNames(
				["cpu", "mem"],
				[
					{ name: "cpu", labels },
					{ name: "mem", labels: {} },
				],
			),
		);
	});
});

describe("读数的状态：脚注、可访问名称和图表的空状态都由它决定", () => {
	const source = (
		status: FocusSource["status"],
		patch: Partial<FocusSource> = {},
	): FocusSource => ({
		status,
		attempt: 0,
		task_id: null,
		chain_instance_id: "c1",
		started_at: null,
		ended_at: null,
		...patch,
	});
	const empty = (status: FocusSource["status"], patch: Partial<FocusSource> = {}, final = false) =>
		item({ latest: null, last_at: null, final, source: source(status, patch) });

	it.each([
		["还没开始（待执行）", empty("pending"), "还没有开始执行"],
		[
			"排队中：已有任务，但没有开始",
			empty("queued", { attempt: 1, task_id: "t1" }),
			"还没有开始执行",
		],
		["派发后还没开始", empty("dispatched", { attempt: 1, task_id: "t1" }), "还没有开始执行"],
		["被跳过", empty("skipped"), "已跳过，没有执行"],
		["没开始就被取消", empty("cancelled"), "在开始前被取消，没有执行"],
		[
			"所在子流程被停止，节点没开始（读数里 final 为 true）",
			empty("stopped", {}, true),
			"子流程被停止，没有执行",
		],
	])("%s：写这个状态没有执行的原因，不写「最终值」", (_name, reading, text) => {
		expect(readingState(reading, NOW)).toEqual({ kind: "empty", text });
		expect(readingFoot(reading, NOW)).toBe(`load · ${text}`);
		expect(readingLabel(reading, NOW)).toMatch(new RegExp(`，${text}$`));
		expect(readingLabel(reading, NOW)).not.toContain("最终值");
	});

	it("已经开始但还没有点：执行中和已结束都写「还没有数据」，已结束也不写「最终值」", () => {
		const started = { attempt: 1, task_id: "t1", started_at: at(60) };
		const running = empty("running", started);
		const done = empty("success", { ...started, ended_at: at(30) }, true);
		for (const reading of [running, done]) {
			expect(readingState(reading, NOW)).toEqual({ kind: "empty", text: "还没有数据" });
			expect(readingFoot(reading, NOW)).toBe("load · 还没有数据");
			expect(readingLabel(reading, NOW)).toMatch(/，还没有数据$/);
		}
	});

	it("有值：来源节点还在是多久前，成功或已停止后是最终值", () => {
		expect(readingState(item(), NOW)).toEqual({ kind: "live", ageMs: 2000 });
		expect(readingState(item({ final: true }), NOW)).toEqual({ kind: "final" });
	});

	it("图表在这次运行的节点包版本里不存在：没有值可说，脚注只写来源节点", () => {
		const missing = item({
			unavailable: "chart_missing",
			latest: null,
			last_at: null,
			final: true,
			source: { ...item().source, status: "success", ended_at: at(1) },
		});
		expect(readingFoot(missing, NOW)).toBe("load");
		expect(readingLabel(missing, NOW)).toBe(
			"母单量，这个版本的节点没有图表「母单量」，来自 load（成功）",
		);
	});
});
