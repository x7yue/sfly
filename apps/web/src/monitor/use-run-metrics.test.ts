import { type MetricSeries, metricsApi, queryKey } from "@sfly/schema";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyMetricIncrement, refetchSeries } from "./use-run-metrics";

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
	series_capped: false,
	series: [{ name: "tps", labels: {}, buckets: [] }],
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
			points: [
				{ name: "tps", labels: {}, time: "2026-01-01T00:00:01.000Z", value: 5, min: 5, max: 5 },
			],
		});

		const buckets = (key: readonly unknown[]) =>
			client.getQueryData<MetricSeries>(key)?.series[0]?.buckets.length;
		expect(buckets(keyOf(RUN))).toBe(1);
		expect(buckets(keyOf(OTHER))).toBe(0);
		expect(buckets(keyOf(RUN, { to: "2026-01-01T00:01:00.000Z" }))).toBe(0);
	});

	it("还没有数据或正在请求的序列不追加，而是取消进行中的请求后重新请求：请求的结果可能早于这些点生成（#47）", async () => {
		const client = new QueryClient();
		const never = () => new Promise<MetricSeries>(() => {});
		const idle = keyOf(RUN);
		const loading = keyOf(RUN, { attempt: "2" });
		const refetching = keyOf(RUN, { attempt: "3" });
		client.setQueryData(idle, series(RUN));
		client.setQueryData(refetching, series(RUN));
		// 进行中的请求：首次加载（还没有数据，取消后以 CancelledError 结束）和已有数据时的重新请求
		// （取消后回退到原来的数据）。两者的旧结果都不会再写进缓存。
		const inFlight = [
			client.fetchQuery({ queryKey: loading, queryFn: never }),
			client.fetchQuery({ queryKey: refetching, queryFn: never, staleTime: 0 }),
		].map((p) =>
			p.then(
				() => "resolved",
				() => "cancelled",
			),
		);

		await applyMetricIncrement(client, RUN, {
			task_id: series(RUN).task_id,
			chain_instance_id: CHAIN,
			node_id: "load",
			attempt: 1,
			points: [
				{ name: "tps", labels: {}, time: "2026-01-01T00:00:01.000Z", value: 5, min: 5, max: 5 },
			],
		});

		const state = (key: readonly unknown[]) => client.getQueryState<MetricSeries>(key);
		expect(state(idle)?.data?.series[0]?.buckets).toHaveLength(1);
		expect(state(idle)?.isInvalidated).toBe(false);
		expect(state(loading)?.isInvalidated).toBe(true);
		expect(state(refetching)?.data?.series[0]?.buckets).toHaveLength(0);
		expect(state(refetching)?.isInvalidated).toBe(true);
		expect(await Promise.all(inFlight)).toEqual(["cancelled", "resolved"]);
		expect(state(refetching)?.data?.series[0]?.buckets).toHaveLength(0);
	});

	it("事件流连上后重新获取序列：进行中的首次加载也要取消重发，它可能早于连上之前推送的点生成（#47）", async () => {
		const client = new QueryClient();
		const loading = keyOf(RUN);
		const other = keyOf(OTHER);
		const first = client
			.fetchQuery({ queryKey: loading, queryFn: () => new Promise<MetricSeries>(() => {}) })
			.then(
				() => "resolved",
				() => "cancelled",
			);
		client.setQueryData(other, series(OTHER));

		await refetchSeries(client, RUN);

		expect(await first).toBe("cancelled");
		expect(client.getQueryState(loading)?.isInvalidated).toBe(true);
		expect(client.getQueryState(other)?.isInvalidated).toBe(false);
	});
});
