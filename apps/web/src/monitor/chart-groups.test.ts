import type { CatalogNode, ChainRunView, RunView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { chartCountText, chartsCompact } from "./chart-groups";

const CHAIN = "6f1c2d3e-0000-4000-8000-000000000001";
const TASK = "6f1c2d3e-0000-4000-8000-0000000000a1";

const run: RunView = {
	id: "6f1c2d3e-0000-4000-8000-0000000000f0",
	orchestration_id: "6f1c2d3e-0000-4000-8000-0000000000f1",
	orchestration_version: 1,
	status: "failed",
	triggered_by: "tester",
	triggered_via: null,
	params: {},
	started_at: "2026-01-01T00:00:00.000Z",
	ended_at: "2026-01-01T00:00:01.000Z",
	cancel: null,
	run_notification: null,
	chains: [
		{
			id: CHAIN,
			chain_id: "entry",
			name: null,
			parent_chain_instance_id: null,
			async_node_id: null,
			depth: 0,
			status: "failed",
			params: {},
			started_at: "2026-01-01T00:00:00.000Z",
			ended_at: "2026-01-01T00:00:01.000Z",
			nodes: [
				{
					node_id: "load",
					kind: "package",
					status: "failed",
					agent: "agent-a",
					outputs: null,
					error: null,
					attempts: [],
				},
			],
		} satisfies ChainRunView,
	],
};

const entry = (over: Partial<CatalogNode>): CatalogNode => ({
	chain_instance_id: CHAIN,
	node_id: "load",
	package: "demo",
	node: "load",
	version: "1.0.0",
	metrics: [],
	charts: [],
	primary_metric: null,
	attempts: [
		{
			task_id: TASK,
			attempt: 1,
			truncated: false,
			series_capped: false,
			dropped_points: 0,
			metrics: [],
		},
	],
	...over,
});

describe("图表工作区收成一行的条件", () => {
	it("指标目录还没到：按有图表处理，版面不先收起", () => {
		expect(chartsCompact(run, undefined)).toBe(false);
	});

	it("目录到了、没有节点上报指标（目录为空，或节点类型没有声明图表）：收成一行", () => {
		expect(chartsCompact(run, { nodes: [] })).toBe(true);
		expect(chartsCompact(run, { nodes: [entry({ charts: [] })] })).toBe(true);
	});

	it("目录里的节点不在这次运行里：收成一行", () => {
		const stranger = entry({
			node_id: "elsewhere",
			charts: [{ title: "延迟", type: "line", metrics: ["latency_ms"], default: false }],
		});
		expect(chartsCompact(run, { nodes: [stranger] })).toBe(true);
	});

	it("有节点带图表：不收", () => {
		const charted = entry({
			charts: [{ title: "延迟", type: "line", metrics: ["latency_ms"], default: false }],
		});
		expect(chartsCompact(run, { nodes: [charted] })).toBe(false);
	});
});

describe("chartCountText", () => {
	it("写清图表来自哪里，零值不出现在文字里", () => {
		expect(chartCountText(3, 12, true)).toBe("12 张图表，来自 3 个节点和平台自带");
		expect(chartCountText(1, 1, false)).toBe("1 张图表，来自 1 个节点");
		expect(chartCountText(0, 4, true)).toBe("4 张平台自带图表");
		expect(chartCountText(0, 0, false)).toBe("没有图表");
	});
});
