import { orchestrationsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ErrorState } from "#/components/feedback/states";
import { apiQuery } from "#/lib/api";
import { useNow } from "#/lib/use-now";
import { versionQuery } from "#/versions/queries";
import { Skeleton } from "@/components/ui/skeleton";
import { BottomPanel } from "./BottomPanel";
import { ChartWorkspace } from "./ChartWorkspace";
import { useLiveRun } from "./live-run";
import { MonitorTopBar } from "./MonitorTopBar";
import { createMonitorStore, MonitorProvider, type TimeAxis } from "./monitor-state";
import { focusNode } from "./run-model";
import { Timeline } from "./Timeline";
import { runExtent, visibleRange } from "./timeline";

/**
 * 运行监控页（原型 #/monitor/:runId，全屏）：顶栏、链路时间线、图表工作区（#42）、底部面板。
 * 运行中通过运行事件流实时更新（live-run.ts：运行视图、进度、指标增量）。
 * 时间线、图表与底部面板共用一份时间轴状态（monitor-state.tsx）。
 */
export function MonitorPage({ runId, initialNode }: { runId: string; initialNode?: string }) {
	const runQuery = useLiveRun(runId);
	const run = runQuery.data;
	const running = !run || run.status === "running";

	const orchestrationId = run?.orchestration_id;
	const versionNumber = run?.orchestration_version;
	const orchestration = useQuery({
		...apiQuery(orchestrationsApi.get, { params: { id: orchestrationId ?? "" } }),
		enabled: !!orchestrationId,
	});
	// 运行绑定的版本文档：节点的包与类型、always 标记、敏感参数。
	const version = useQuery({
		...versionQuery(orchestrationId ?? "", versionNumber ?? 0),
		enabled: !!orchestrationId && !!versionNumber,
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
				<MonitorTopBar run={run} name={orchestration.data?.name} />
				<main className="flex min-h-0 flex-1 flex-col">
					<Timeline run={run} doc={doc} />
					<ChartWorkspace run={run} />
					<BottomPanel run={run} doc={doc} />
				</main>
			</div>
		</MonitorProvider>
	);
}
