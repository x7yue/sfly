import type { RunFocusItem } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { formatClock } from "#/lib/format";
import { cardFocusLabel } from "./CardFocus";

const NOW = "2026-01-01T00:10:00.000Z";
const at = (secondsAgo: number) => new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString();

const item = (patch: Partial<RunFocusItem> = {}): RunFocusItem => ({
	position: 1,
	node_id: "probe",
	chart: "level",
	title: "探活 level",
	chart_type: "line",
	unit: "",
	source: {
		status: "running",
		attempt: 1,
		task_id: "t1",
		chain_instance_id: "c1",
		started_at: at(600),
		ended_at: null,
	},
	latest: { value: 4, metric: "level", labels: {}, at: at(2) },
	metrics: [{ name: "level", label_keys: [] }],
	series: [],
	bucket_seconds: 1,
	last_at: at(2),
	sample_interval_ms: null,
	stale_since: null,
	final: false,
	anomaly: null,
	...patch,
});

const stale = { kind: "stale" as const, at: at(130), message: "" };

describe("节点卡片的可访问名称里的关注项", () => {
	it("没有异常时只有个数", () => {
		expect(cardFocusLabel([item(), item({ chart: "total" })], NOW)).toBe("2 个关注项");
	});

	it("有异常时写几项需要注意和原因（用图表自己的标题）", () => {
		expect(cardFocusLabel([item({ chart: "total", anomaly: stale }), item()], NOW)).toBe(
			"2 个关注项，1 项需要注意：total 已 2m 10s 无新数据",
		);
	});

	it("图表在节点包版本里不存在的项写明原因：卡片上这一行没有数值", () => {
		const missing = item({ chart: "水位", unavailable: "chart_missing", latest: null });
		expect(cardFocusLabel([item(), missing], NOW)).toBe("2 个关注项，这个版本的节点没有图表 水位");
		expect(cardFocusLabel([item({ anomaly: stale }), missing], NOW)).toBe(
			"2 个关注项，1 项需要注意：level 已 2m 10s 无新数据，这个版本的节点没有图表 水位",
		);
	});

	it("场景没设关注项时是这个节点的主指标：不数个数，写法和槽位格一致", () => {
		const retry = { kind: "retry" as const, at: at(30), message: "", count: undefined };
		const primary = item({
			title: "level",
			source: { ...item().source, attempt: 2 },
			anomaly: retry,
		});
		expect(cardFocusLabel([primary], NOW, "primary")).toBe(
			`1 项需要注意：主指标 level 重试（尝试 2）· ${formatClock(retry.at)}`,
		);
	});
});
