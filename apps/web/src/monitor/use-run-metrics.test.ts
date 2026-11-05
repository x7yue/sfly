import { type MetricSeries, metricsApi, queryKey } from "@sfly/schema";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyMetricIncrement } from "./use-run-metrics";

const RUN = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const CHAIN = "00000000-0000-4000-8000-0000000000c1";

const series = (runId: string): MetricSeries => ({
	run_id: runId,
	expired: false,
	chain_instance_id: CHAIN,
	node_id: "load",
	task_id: "00000000-0000-4000-8000-0000000000a1",
	attempt: 1,
	from: "2026-01-01T00:00:00.000Z",
	to: null,
	bucket_seconds: 1,
	truncated: false,
	series: [{ name: "tps", buckets: [] }],
});
const keyOf = (runId: string, extra: Record<string, string> = {}) =>
	queryKey(metricsApi.series, {
		params: { id: runId },
		query: { chain_instance_id: CHAIN, node_id: "load", ...extra },
	} as never);

describe("指标增量追加进序列缓存", () => {
	it("只追加到这个运行、这个节点、没有指定结束时间的序列查询", () => {
		const client = new QueryClient();
		client.setQueryData(keyOf(RUN), series(RUN));
		client.setQueryData(keyOf(OTHER), series(OTHER));
		client.setQueryData(keyOf(RUN, { to: "2026-01-01T00:01:00.000Z" }), series(RUN));

		applyMetricIncrement(client, RUN, {
			task_id: series(RUN).task_id,
			chain_instance_id: CHAIN,
			node_id: "load",
			attempt: 1,
			points: [{ name: "tps", time: "2026-01-01T00:00:01.000Z", value: 5, min: 5, max: 5 }],
		});

		const buckets = (key: readonly unknown[]) =>
			client.getQueryData<MetricSeries>(key)?.series[0]?.buckets.length;
		expect(buckets(keyOf(RUN))).toBe(1);
		expect(buckets(keyOf(OTHER))).toBe(0);
		expect(buckets(keyOf(RUN, { to: "2026-01-01T00:01:00.000Z" }))).toBe(0);
	});
});
