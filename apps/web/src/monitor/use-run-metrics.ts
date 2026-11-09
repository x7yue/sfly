import {
	type MetricIncrement,
	type MetricSeries,
	type MetricSeriesQuery,
	metricsApi,
	queryKey,
	type RunView,
} from "@sfly/schema";
import { keepPreviousData, type Query, type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { apiQuery } from "#/lib/api";
import { STATUS_POLL_MS } from "#/lib/polling";
import { appendIncrement } from "./charts";

/**
 * 图表工作区的数据：运行的指标目录、每个节点的序列（降采样）、平台自带图表（契约 metricsApi）。
 * 实时增量来自运行 SSE 的 metrics 事件（MonitorPage 与 run / progress 共用一条连接），
 * 由 {@link applyMetricIncrement} 追加进缓存里的序列；断线重连后用 {@link refetchSeries} 补齐错过的点。
 */

/** 开始与结束过的尝试：变化时重新获取目录（新节点、新尝试）与平台自带图表。 */
export const attemptsSignature = (run: RunView) =>
	run.chains
		.flatMap((c) =>
			c.nodes.flatMap((n) =>
				n.attempts.flatMap((a) =>
					a.started_at === null ? [] : [`${a.task_id}${a.ended_at === null ? "" : "."}`],
				),
			),
		)
		.join(",");

/** signature 变化时（不含第一次）调用 refetch。 */
function useRefetchOn(signature: string, refetch: () => unknown) {
	const last = useRef(signature);
	useEffect(() => {
		if (last.current === signature) return;
		last.current = signature;
		void refetch();
	}, [signature, refetch]);
}

export function useMetricCatalog(runId: string, signature: string, enabled = true) {
	const query = useQuery({
		...apiQuery(metricsApi.catalog, { params: { id: runId } }),
		enabled,
	});
	useRefetchOn(signature, query.refetch);
	return query;
}

export const PLATFORM_POINTS = 120;

export function usePlatformMetrics(runId: string, signature: string, live: boolean) {
	const query = useQuery({
		...apiQuery(metricsApi.platform, { params: { id: runId }, query: { points: PLATFORM_POINTS } }),
		// 并发与槽位占用随时间变化（其他运行的任务也占槽位），运行中定时刷新。
		refetchInterval: live ? STATUS_POLL_MS : false,
		placeholderData: keepPreviousData,
	});
	useRefetchOn(signature, query.refetch);
	return query;
}

type SeriesQuery = Pick<
	MetricSeriesQuery,
	"chain_instance_id" | "node_id" | "attempt" | "from" | "to"
> & {
	points?: number;
	/** 只查这些指标（逗号分隔，与契约的查询参数相同）；不给时查节点类型声明的全部指标。 */
	metrics?: string;
};

/** 查询参数里的指标名；没有指定时为 undefined（全部指标）。 */
const requestedMetrics = (query: Partial<SeriesQuery>) =>
	query.metrics === undefined ? undefined : new Set(query.metrics.split(","));

/** 一个节点一次尝试的序列查询选项；缩放时带上时间范围（按秒取整），得到更细的桶。 */
export function seriesQuery(runId: string, query: SeriesQuery, finished: boolean) {
	return {
		...apiQuery(metricsApi.series, { params: { id: runId }, query }),
		placeholderData: keepPreviousData,
		// 结束了的尝试不会再有新的点；执行中的靠 SSE 增量追加。
		staleTime: finished ? Number.POSITIVE_INFINITY : 0,
	};
}

type SeriesKeyVars = { params?: { id?: string }; query?: Partial<SeriesQuery> };

/** 这个运行的序列查询（query key 按 `queryKey()` 的前缀匹配，DESIGN-SYSTEM §8），再按查询参数筛选。 */
const seriesOf = (runId: string, match: (q: Partial<SeriesQuery>) => boolean) => ({
	// 只给出 params 的 key 是前缀（TanStack Query 按对象部分匹配），不是一次完整的请求，所以不按请求类型检查。
	queryKey: queryKey(metricsApi.series, { params: { id: runId } } as never),
	predicate: (q: { queryKey: readonly unknown[] }) => {
		const vars = varsOf(q);
		return vars?.params?.id === runId && !!vars.query && match(vars.query);
	},
});

/** 序列查询的参数（query key 的最后一项）。 */
const varsOf = (q: { queryKey: readonly unknown[] }) =>
	q.queryKey.at(-1) as SeriesKeyVars | undefined;

/**
 * 把一条 metrics 增量追加进这个节点的序列缓存（只追加没有指定时间范围的查询：缩放的范围是固定的）。
 * 只查部分指标的查询（每张图表一个查询，#153）只追加它查的指标的点，增量里没有这些指标时不动它。
 *
 * 还没有数据或正在请求的序列不追加，而是重新请求（#47）：进行中的请求可能在这些点之前生成，
 * 晚于增量到达时会覆盖追加的点（没有数据时增量更是直接丢失），之后没有新增量就一直没有这些点。
 * 控制面先记录点再推送增量，所以收到增量后发出的请求一定包含它们。返回重新请求完成的 Promise（测试用）。
 */
export function applyMetricIncrement(
	client: QueryClient,
	runId: string,
	increment: MetricIncrement,
): Promise<void> {
	const filters = seriesOf(
		runId,
		(q) =>
			q.chain_instance_id === increment.chain_instance_id &&
			q.node_id === increment.node_id &&
			q.to === undefined,
	);
	const pending = new Set<string>();
	for (const query of client.getQueryCache().findAll(filters)) {
		const names = requestedMetrics(varsOf(query)?.query ?? {});
		const points = names ? increment.points.filter((p) => names.has(p.name)) : increment.points;
		if (points.length === 0) continue;
		if (query.state.data === undefined || query.state.fetchStatus === "fetching") {
			pending.add(query.queryHash);
			continue;
		}
		client.setQueryData<MetricSeries>(query.queryKey, (old) =>
			old ? appendIncrement(old, { ...increment, points }) : old,
		);
	}
	if (pending.size === 0) return Promise.resolve();
	return refetchFresh(client, { predicate: (q) => pending.has(q.queryHash) });
}

/**
 * 重新获取这个运行的全部序列。运行事件流每次连上（包括第一次）都要调用：连上之前推送的增量收不到，
 * 而之前发出的序列请求可能早于这些点生成（#47）。控制面在发出响应头时就已订阅，
 * 所以连上之后发出的请求与之后收到的增量合起来不会漏点。
 */
export function refetchSeries(client: QueryClient, runId: string): Promise<void> {
	return refetchFresh(
		client,
		seriesOf(runId, () => true),
	);
}

/**
 * 重新请求匹配的序列，保证结果是在调用之后生成的：先取消进行中的请求——没有数据时
 * TanStack Query 的重新请求会复用进行中的请求（只有已有数据时 cancelRefetch 才取消它）。
 */
function refetchFresh(
	client: QueryClient,
	filters: { predicate: (q: Query) => boolean; queryKey?: readonly unknown[] },
): Promise<void> {
	return client.cancelQueries(filters).then(() => client.invalidateQueries(filters));
}
