import { queryKey, type RunView, runsApi } from "@sfly/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ErrorState } from "#/components/feedback/states";
import { apiQuery, getOrchestration } from "#/lib/api";
import { useEventSource } from "#/lib/sse";
import { useNow } from "#/lib/use-now";
import { getVersion } from "#/versions/api";
import { Skeleton } from "@/components/ui/skeleton";
import { BottomPanel } from "./BottomPanel";
import { MonitorTopBar } from "./MonitorTopBar";
import { createMonitorStore, MonitorProvider, type TimeAxis } from "./monitor-state";
import { applyProgress, focusNode, type ProgressEvent } from "./run-model";
import { Timeline } from "./Timeline";
import { runExtent, visibleRange } from "./timeline";

/**
 * 运行监控页（原型 #/monitor/:runId，全屏）：顶栏、链路时间线、图表工作区（#42）、底部面板。
 * 运行中通过 SSE 实时更新（事件 run / progress；metrics 事件由 #42 的图表工作区订阅处理）。
 * 时间线、图表与底部面板共用一份时间轴状态（monitor-state.tsx）。
 */
export function MonitorPage({ runId, initialNode }: { runId: string; initialNode?: string }) {
	const queryClient = useQueryClient();
	const runKey = queryKey(runsApi.get, { params: { id: runId } });
	const runQuery = useQuery(apiQuery(runsApi.get, { params: { id: runId } }));
	const run = runQuery.data;
	const running = !run || run.status === "running";
	// 运行结束后不再需要实时流（最后一条推送就是最终状态）。
	useEventSource(running ? `/runs/${encodeURIComponent(runId)}/events` : null, {
		run: (data) => queryClient.setQueryData(runKey, data as RunView),
		progress: (data) =>
			queryClient.setQueryData(runKey, (old: RunView | undefined) =>
				applyProgress(old, data as ProgressEvent),
			),
	});

	const orchestrationId = run?.orchestration_id;
	const versionNumber = run?.orchestration_version;
	const orchestration = useQuery({
		queryKey: ["orchestration", orchestrationId],
		queryFn: () => getOrchestration(orchestrationId as string),
		enabled: !!orchestrationId,
	});
	// 运行绑定的版本文档：节点的包与类型、always 标记、敏感参数。
	const version = useQuery({
		queryKey: ["orchestration", orchestrationId, "version", versionNumber],
		queryFn: () => getVersion(orchestrationId as string, versionNumber as number),
		enabled: !!orchestrationId && !!versionNumber,
		staleTime: Number.POSITIVE_INFINITY,
	});

	const [store] = useState(() => createMonitorStore());
	// 第一次拿到运行视图时选中节点：链接里给的节点，否则失败的、其次执行中的节点。
	const selectedOnce = useRef(false);
	useEffect(() => {
		if (!run || selectedOnce.current) return;
		selectedOnce.current = true;
		store.select(focusNode(run, initialNode));
	}, [run, initialNode, store]);

	const now = useNow(running);
	const zoom = useSyncExternalStore(store.subscribe, () => store.get().zoom);
	const axis = useMemo<TimeAxis | null>(() => {
		if (!run) return null;
		const extent = runExtent(run, now);
		const live = run.status === "running";
		return { extent, range: visibleRange(extent, zoom), live, following: live && !zoom, now };
	}, [run, now, zoom]);

	if (runQuery.error && !run) {
		return (
			<div className="fixed inset-0 grid place-items-center bg-bg p-8">
				<ErrorState
					title="无法加载运行"
					error={runQuery.error}
					onRetry={() => void runQuery.refetch()}
					className="w-[560px]"
				/>
			</div>
		);
	}
	if (!run || !axis) {
		return (
			<output
				aria-label="加载中"
				aria-busy="true"
				className="fixed inset-0 flex flex-col gap-3 bg-bg p-3"
			>
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-40 w-full" />
				<Skeleton className="w-full flex-1" />
			</output>
		);
	}
	const doc = version.data?.document;
	return (
		<MonitorProvider store={store} axis={axis}>
			<div className="fixed inset-0 flex min-w-[1280px] flex-col bg-bg">
				<MonitorTopBar run={run} name={orchestration.data?.name} doc={doc} />
				<main className="flex min-h-0 flex-1 flex-col">
					<Timeline run={run} doc={doc} />
					<ChartWorkspace />
					<BottomPanel run={run} doc={doc} />
				</main>
			</div>
		</MonitorProvider>
	);
}

/**
 * 图表工作区（#42）：占据时间线与底部面板之间的剩余高度。#42 在这里渲染按节点分组的指标图表与平台自带图表，
 * 通过 monitor-state.tsx 的 useTimeAxis / useMonitor / useMonitorActions 与时间线共享悬停时刻、缩放范围、
 * 实时跟随、日志标记与选中节点；指标增量从运行 SSE 的 metrics 事件订阅（useEventSource 同一路径会另开连接，
 * 届时把 MonitorPage 里的订阅合并成一处）。
 */
function ChartWorkspace() {
	return (
		<section
			aria-label="图表工作区"
			className="grid min-h-60 flex-1 place-items-center overflow-auto px-3 py-2.5"
		>
			<div className="flex flex-col items-center gap-2 text-center text-sm text-fg-3">
				<BarChart3Icon className="size-5" aria-hidden />
				节点上报的指标图表会显示在这里。
			</div>
		</section>
	);
}
