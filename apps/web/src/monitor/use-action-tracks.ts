import {
	type ActionPage,
	type ActionSummaryView,
	type AttemptView,
	actionsApi,
	MAX_ACTION_PAGE,
	type RunView,
} from "@sfly/schema";
import { type QueryKey, useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { apiQuery } from "#/lib/api";
import { STATUS_POLL_MS } from "#/lib/polling";
import {
	type PreparedTracks,
	prepareTracks,
	RARE_MAX,
	rareNames,
	type TrackSource,
} from "./action-tracks";
import { nodeKey } from "./monitor-state";

/** 少见的名称最多单独读几种（个数少的先读）；更多的只在最新一页里有。 */
const RARE_PAGES = 10;

interface Started {
	/** 节点的键（monitor-state 的 nodeKey）。 */
	node: string;
	attempt: AttemptView & { started_at: string };
}

type PageQuery = { limit: number; failed?: "true"; name?: string };

/** 一次尝试除了最新一页还要读的页：失败的、每种少见的名称。 */
function extraPages(summary: ActionSummaryView): { query: PageQuery; version: string }[] {
	const pages: { query: PageQuery; version: string }[] = [];
	const failed = summary.names.reduce((n, c) => n + c.failed, 0);
	if (failed > 0) {
		pages.push({ query: { limit: MAX_ACTION_PAGE, failed: "true" }, version: String(failed) });
	}
	const rare = rareNames(summary.names);
	const names = summary.names
		.filter((n) => rare.has(n.name))
		.sort((a, b) => a.total - b.total)
		.slice(0, RARE_PAGES);
	for (const n of names) {
		const running = summary.running.filter((a) => a.name === n.name).map((a) => a.id);
		pages.push({
			query: { limit: RARE_MAX, name: n.name },
			version: `${n.total}|${n.failed}|${running.join(",")}`,
		});
	}
	return pages;
}

const pageQuery = (taskId: string, query: PageQuery) =>
	apiQuery(actionsApi.page, { params: { id: taskId }, query });

/**
 * 时间线上的动作轨道要用的数据（use-task-actions.ts 之外的另一个读者）：运行里每个开始执行过的包节点的每次尝试读一份摘要
 * （和底部面板共用缓存，执行中每 {@link STATUS_POLL_MS} 重读，结束时再读一次），有动作的再读最新一页明细
 * （{@link MAX_ACTION_PAGE} 条，明细不多时就是全部）；最新一页不是全部时，再读失败的一页和每种少见名称的一页。
 * 不连推送：每个有动作的节点一条 SSE 会占满浏览器对同源的连接数（polling.ts）。摘要里相关的计数变了才重读对应的页，
 * 所以执行中、动作很多的节点约每 5 秒重读一次最新一页。返回每个有动作的节点（nodeKey）合好的轨道数据。
 */
export function useActionTracks(run: RunView): ReadonlyMap<string, PreparedTracks> {
	const queryClient = useQueryClient();
	const started = useMemo(
		() =>
			run.chains.flatMap((chain) =>
				chain.nodes
					.filter((n) => n.kind === "package")
					.flatMap((n) =>
						n.attempts
							.filter((a): a is Started["attempt"] => a.started_at !== null)
							.map(
								(attempt): Started => ({
									node: nodeKey({ chainInstanceId: chain.id, nodeId: n.node_id }),
									attempt,
								}),
							),
					),
			),
		[run],
	);

	const summaries = useQueries({
		queries: started.map(({ attempt }) => ({
			...apiQuery(actionsApi.summary, { params: { id: attempt.task_id } }),
			refetchInterval: attempt.status === "running" ? STATUS_POLL_MS : false,
		})),
	});
	const withActions = started.flatMap((s, i) => {
		const summary = summaries[i]?.data;
		return summary && summary.total > 0 ? [{ ...s, summary }] : [];
	});

	const latest = useQueries({
		queries: withActions.map(({ attempt }) => ({
			...pageQuery(attempt.task_id, { limit: MAX_ACTION_PAGE }),
			staleTime: Number.POSITIVE_INFINITY,
		})),
	});
	const extras = withActions.flatMap((s, i) =>
		latest[i]?.data?.before == null
			? []
			: extraPages(s.summary).map((p) => ({ owner: s.attempt.task_id, ...p })),
	);
	const extraResults = useQueries({
		queries: extras.map(({ owner, query }) => ({
			...pageQuery(owner, query),
			staleTime: Number.POSITIVE_INFINITY,
		})),
	});

	// 尝试结束时再读一次摘要（之后不再定时重读）：结束时的那一份正在做的为空。
	const runningIds = started
		.filter((s) => s.attempt.status === "running")
		.map((s) => s.attempt.task_id)
		.join(" ");
	const wasRunning = useRef<string[]>([]);
	useEffect(() => {
		const now = runningIds === "" ? [] : runningIds.split(" ");
		for (const id of wasRunning.current) {
			if (now.includes(id)) continue;
			void queryClient.invalidateQueries({
				queryKey: apiQuery(actionsApi.summary, { params: { id } }).queryKey,
				exact: true,
			});
		}
		wasRunning.current = now;
	}, [runningIds, queryClient]);

	// 摘要里和一页相关的计数变了（或者尝试结束了）才重读那一页。
	const versions = new Map<string, { key: QueryKey; version: string }>();
	withActions.forEach(({ attempt, summary }) => {
		const { queryKey } = pageQuery(attempt.task_id, { limit: MAX_ACTION_PAGE });
		const version = `${attempt.status}|${summary.total}|${summary.recent[0]?.id ?? ""}|${summary.running.length}`;
		versions.set(JSON.stringify(queryKey), { key: queryKey, version });
	});
	for (const { owner, query, version } of extras) {
		const status = started.find((s) => s.attempt.task_id === owner)?.attempt.status;
		const { queryKey } = pageQuery(owner, query);
		versions.set(JSON.stringify(queryKey), { key: queryKey, version: `${status}|${version}` });
	}
	const signature = [...versions.entries()].map(([k, v]) => `${k}=${v.version}`).join("\n");
	const seen = useRef(new Map<string, string>());
	// biome-ignore lint/correctness/useExhaustiveDependencies: signature 包含了 versions 的全部内容
	useEffect(() => {
		for (const [hash, { key, version }] of versions) {
			const before = seen.current.get(hash);
			seen.current.set(hash, version);
			if (before !== undefined && before !== version) {
				void queryClient.refetchQueries({ queryKey: key, exact: true });
			}
		}
	}, [signature, queryClient]);

	const cache = useRef(new Map<string, { deps: unknown[]; prepared: PreparedTracks }>());
	const byNode = new Map<string, { sources: TrackSource[]; deps: unknown[] }>();
	withActions.forEach(({ node, attempt, summary }, i) => {
		const page: ActionPage | undefined = latest[i]?.data;
		const pages = [
			page,
			...extras.flatMap((e, j) => (e.owner === attempt.task_id ? [extraResults[j]?.data] : [])),
		].filter((p): p is ActionPage => p !== undefined && !p.expired);
		const source: TrackSource = {
			taskId: attempt.task_id,
			summary,
			details: pages.flatMap((p) => p.actions),
			loadedFrom:
				page?.before == null
					? null
					: Date.parse(page.actions.at(-1)?.started_at ?? attempt.started_at),
			controlPlanePeriods: pages.flatMap((p) =>
				p.count_only.filter((c) => c.reason === "control_plane"),
			),
			startedAt: Date.parse(attempt.started_at),
			endedAt: attempt.ended_at,
		};
		const entry = byNode.get(node) ?? { sources: [], deps: [] };
		byNode.set(node, entry);
		entry.sources.push(source);
		entry.deps.push(summary, attempt.ended_at, ...pages);
	});
	const out = new Map<string, PreparedTracks>();
	for (const [node, { sources, deps }] of byNode) {
		const cached = cache.current.get(node);
		const same =
			cached !== undefined &&
			cached.deps.length === deps.length &&
			cached.deps.every((d, i) => d === deps[i]);
		const prepared = same ? cached.prepared : prepareTracks(sources);
		if (!same) cache.current.set(node, { deps, prepared });
		out.set(node, prepared);
	}
	return out;
}
