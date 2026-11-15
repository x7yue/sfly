import type { RunFocusItem } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	formatAgo,
	latestSeriesName,
	readingAge,
	readingFoot,
	readingLabel,
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

	it("距离读数生成时的最后一个点；一个点都没有为 null", () => {
		expect(readingAge(item(), NOW)).toBe(2000);
		expect(readingAge(item({ last_at: null }), NOW)).toBeNull();
	});
});

describe("读数的文字", () => {
	it("最新值：数值卡写累计值，没有数据写破折号", () => {
		expect(valueText(item())).toBe("1.3M");
		expect(valueText(item({ latest: null }))).toBe("—");
	});

	it("脚注：节点 · 多久前；成功或已停止后是最终值；还没有数据时写明原因", () => {
		expect(readingFoot(item(), NOW)).toBe("load · 2s 前");
		expect(readingFoot(item({ final: true }), NOW)).toBe("load · 最终值");
		expect(readingFoot(item({ latest: null, last_at: null }), NOW)).toBe("load · 还没有数据");
		expect(
			readingFoot(
				item({
					latest: null,
					last_at: null,
					source: {
						status: "pending",
						attempt: 0,
						task_id: null,
						chain_instance_id: "c1",
						started_at: null,
						ended_at: null,
					},
				}),
				NOW,
			),
		).toBe("load · 还没有开始执行");
	});

	it("来源节点有显示名称时写成「显示名称（节点 ID）」，脚注和可访问名称都一样", () => {
		const named = item({ display_name: "压测" });
		expect(readingFoot(named, NOW)).toBe("压测（load） · 2s 前");
		expect(readingLabel(named, NOW)).toBe("母单量 1.3M 单，来自 压测（load）（执行中），2s 前");
	});

	it("最新值来自哪个序列：多个指标写指标名，带标签写标签值", () => {
		expect(latestSeriesName(item())).toBe("");
		const cpu = item({
			latest: { value: 3, metric: "cpu", labels: { pid: "100", host: "a" }, at: at(1) },
			series: [{ metric: "cpu", labels: { pid: "100", host: "a" }, points: [] }],
		});
		expect(latestSeriesName(cpu)).toBe("a · 100");
		const both = item({
			latest: { value: 3, metric: "p99", labels: {}, at: at(1) },
			series: [
				{ metric: "p50", labels: {}, points: [] },
				{ metric: "p99", labels: {}, points: [] },
			],
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
