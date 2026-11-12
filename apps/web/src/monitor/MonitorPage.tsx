import { orchestrationsApi, type RunView } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { notify } from "#/components/feedback/notify";
import { ErrorState } from "#/components/feedback/states";
import { apiQuery } from "#/lib/api";
import { formatDuration, shortId } from "#/lib/format";
import { useNow } from "#/lib/use-now";
import { versionQuery } from "#/versions/queries";
import { Skeleton } from "@/components/ui/skeleton";
import { BottomPanel } from "./BottomPanel";
import { ChartWorkspace } from "./ChartWorkspace";
import { useLiveRun } from "./live-run";
import { MonitorTopBar } from "./MonitorTopBar";
import { createMonitorStore, MonitorProvider, type TimeAxis } from "./monitor-state";
import { failureSummary, focusNode, runDocumentTitle, runFailure } from "./run-model";
import { Timeline } from "./Timeline";
import { runExtent, visibleRange } from "./timeline-model";

/**
 * 运行监控页（原型 #/monitor/:runId，全屏）：顶栏、链路时间线、图表工作区（#42）、底部面板。
 * 运行中通过运行事件流实时更新（live-run.ts：运行视图、进度、指标增量）。
 * 时间线、图表与底部面板共用一份时间轴状态（monitor-state.tsx）。
 * 浏览器标签页标题显示运行状态与场景名；在页面上看着运行结束时弹出一次结果通知。
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
	// 在渲染里选而不是在 effect 里：底部面板第一次渲染就看到选中的节点，不会先挂上没选中节点时的合并日志、
	// 白发一次请求之后又卸载（这时依赖这个状态的子组件还没有挂上）。
	const selectedOnce = useRef(false);
	if (run && !selectedOnce.current) {
		selectedOnce.current = true;
		store.select(focusNode(run, initialNode));
	}

	const name = orchestration.data?.name;
	useRunDocumentTitle(run, name);
	useTerminalNotice(run, name);

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
			{/* 规格最小宽度 1280；更窄时顶栏收成图标按钮，到 1024 仍不裁切操作。 */}
			<div className="fixed inset-0 flex min-w-[1024px] flex-col bg-bg">
				<MonitorTopBar run={run} name={name} />
				<main className="flex min-h-0 flex-1 flex-col">
					<Timeline run={run} doc={doc} />
					<ChartWorkspace run={run} />
					<BottomPanel run={run} doc={doc} />
				</main>
			</div>
		</MonitorProvider>
	);
}

/** 浏览器标签页标题：「● 运行中 · 日终数据处理 · sfly」；离开页面时恢复原来的标题。 */
function useRunDocumentTitle(run: RunView | undefined, name: string | undefined) {
	useEffect(() => {
		const previous = document.title;
		return () => {
			document.title = previous;
		};
	}, []);
	const title = run ? runDocumentTitle(run, name ?? shortId(run.id)) : null;
	useEffect(() => {
		if (title) document.title = title;
	}, [title]);
}

/**
 * 运行结束的通知：只在页面上看着运行从「运行中」变成结束时弹出一次；打开一个已经结束的运行不弹。
 * 成功、失败、取消分别用 notify.success / error / info（失败的通知需要手动关闭）。
 */
function useTerminalNotice(run: RunView | undefined, name: string | undefined) {
	const seen = useRef<RunView["status"] | null>(null);
	useEffect(() => {
		if (!run) return;
		const before = seen.current;
		seen.current = run.status;
		if (before !== "running" || run.status === "running") return;
		const scenario = name ?? "场景";
		const took = run.ended_at
			? `耗时 ${formatDuration(Date.parse(run.ended_at) - Date.parse(run.started_at))}`
			: undefined;
		if (run.status === "success") {
			notify.success(`${scenario} 运行成功`, { description: took });
		} else if (run.status === "failed") {
			const failure = runFailure(run);
			notify.error(`${scenario} 运行失败`, {
				description: failure ? failureSummary(failure) : took,
			});
		} else {
			notify.info(`${scenario} 运行已取消`, { description: took });
		}
	}, [run, name]);
}
