import { type OrchestrationDocument, orchestrationsApi, type RunView } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Banner } from "#/components/feedback/banner";
import { notify } from "#/components/feedback/notify";
import { ErrorState } from "#/components/feedback/states";
import { useShortcut } from "#/components/shortcuts";
import { apiQuery } from "#/lib/api";
import { DURATION_LABEL, MESSAGE, TERM } from "#/lib/copy";
import { dialogOpen, isEditable } from "#/lib/focus";
import { formatDuration, shortId } from "#/lib/format";
import { useNow } from "#/lib/use-now";
import { versionQuery } from "#/versions/queries";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BottomPanel } from "./BottomPanel";
import { ChartWorkspace } from "./ChartWorkspace";
import { chartsCompact } from "./chart-groups";
import { useLiveRun } from "./live-run";
import { MonitorTopBar } from "./MonitorTopBar";
import { openedScope } from "./monitor-scope";
import {
	createMonitorStore,
	MonitorProvider,
	type TimeAxis,
	useMonitor,
	useMonitorActions,
} from "./monitor-state";
import { initialView, type MonitorView, readRememberedView, rememberView } from "./monitor-view";
import { Overview, type OverviewTarget } from "./Overview";
import { type MonitorSearch, runMonitorLink } from "./run-link";
import { failureSummary, nextFailure, runDocumentTitle, runFailure } from "./run-model";
import { Timeline } from "./Timeline";
import { runExtent, visibleRange } from "./timeline-model";
import { attemptsSignature, useMetricCatalog } from "./use-run-metrics";
import { VIEW_PANEL_ID, viewTabId } from "./ViewTabs";

/**
 * 运行监控页（原型 #/monitor/:runId，全屏）：顶栏和两个视图——概览（默认，Overview.tsx：链路和关注项）与详情
 * （链路时间线、图表工作区（#42）、底部面板，原来的页面）。视图写在地址的 `view` 参数里，打开时按 monitor-view.ts 的
 * `initialView` 决定（失败和取消的运行先打开详情），用户在顶栏的标签页上切换时浏览器记住它。
 * 运行中通过运行事件流实时更新（live-run.ts：运行视图、进度、指标增量）。
 * 时间线、图表与底部面板共用一份共享状态（monitor-state.tsx）：时间轴，加上看的范围（monitor-scope.ts 的状态机）。
 * 浏览器标签页标题显示运行状态与场景名；在页面上看着运行成功或被取消时弹出一次结果通知，
 * 失败改用时间线上方的页内横幅（FailureBanner），收起后失败摘要回到顶栏。
 * 地址里的节点、页签与日志时刻（run-link.ts 的 MonitorSearch）在第一次拿到运行视图时应用，之后地址变了再应用一次：
 * 页面上自己的操作（点节点、切页签）不写回地址；视图不参与这个判断（切视图不该重置选中的节点）。规则在状态机里，
 * 这里只在运行视图到了时用地址创建共享状态，之后把地址报告给它。
 */
export function MonitorPage({ runId, address }: { runId: string; address: MonitorSearch }) {
	const runQuery = useLiveRun(runId);
	const run = runQuery.data;
	if (run) return <LoadedMonitor run={run} address={address} />;
	if (runQuery.error) {
		return (
			<div className="fixed inset-0 grid place-items-center bg-bg p-8">
				<ErrorState
					title={MESSAGE.loadFailed(TERM.run)}
					error={runQuery.error}
					onRetry={() => void runQuery.refetch()}
					className="w-[560px]"
				/>
			</div>
		);
	}
	return (
		<output
			aria-label={MESSAGE.loading}
			aria-busy="true"
			className="fixed inset-0 flex flex-col gap-3 bg-bg p-3"
		>
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-40 w-full" />
			<Skeleton className="w-full flex-1" />
		</output>
	);
}

/** 拿到运行视图之后的页面：共享状态在这里创建，第一次渲染就带着地址里的选中节点和页签。 */
function LoadedMonitor({ run, address }: { run: RunView; address: MonitorSearch }) {
	const runId = run.id;
	const running = run.status === "running";
	const navigate = useNavigate();

	// 打开时的视图只在第一次拿到运行视图时决定一次（之后运行失败了也不把正在看概览的人拉走），并写进地址（替换当前
	// 这一条历史）：发给同事的链接、刷新都停在同一个视图。
	const [opening] = useState(() => initialView({ address, run, remembered: readRememberedView() }));
	const view = address.view ?? opening;
	useEffect(() => {
		if (address.view === undefined) {
			void navigate({ ...runMonitorLink(runId, { ...address, view }), replace: true });
		}
	}, [address, view, runId, navigate]);
	const changeView = (next: MonitorView) => {
		rememberView(next);
		void navigate(runMonitorLink(runId, { ...address, view: next }));
	};
	// 第一次拿到运行视图时应用地址（选中节点的规则见 initialSelection）：创建共享状态时就带着，底部面板第一次渲染
	// 就看到选中的节点，不会先挂上没选中节点时的合并日志、白发一次请求之后又卸载；之后地址变了再应用一次。
	const [store] = useState(() => createMonitorStore({ scope: openedScope(run, address) }));
	useEffect(() => {
		store.report({ type: "address", run, address });
	}, [store, run, address]);
	/**
	 * 点概览里的一项：进入详情，定位到它所在的节点，给了页签就切过去，给了时刻就在日志里定位到那一刻（「需要注意」的
	 * 直达按钮）。节点有链实例时在这里直接报告 `overview`，不等地址变化：地址可能和上一次直达时完全一样
	 * （切回概览再点一次），那样地址没变，不会再应用一次。
	 */
	const openNode = (target: OverviewTarget) => {
		const next: MonitorSearch = { view: "detail", node: target.nodeId };
		if (target.tab) next.tab = target.tab;
		if (target.at) next.at = target.at;
		if (target.chainInstanceId !== null) store.report({ type: "overview", run, address: next });
		// 点的那一格随概览卸载：焦点先移到「详情」标签，不落在 body 上。
		document.getElementById(viewTabId("detail"))?.focus();
		void navigate(runMonitorLink(runId, next));
	};
	/** 顶栏的失败摘要在概览里点了以后切到详情（那里有它要打开的「尝试」页签）；不算用户选了视图，不记。 */
	const showDetail = () => void navigate(runMonitorLink(runId, { ...address, view: "detail" }));

	const orchestration = useQuery(
		apiQuery(orchestrationsApi.get, { params: { id: run.orchestration_id } }),
	);
	// 运行绑定的版本文档：节点的包与类型、always 标记、敏感参数。
	const version = useQuery({
		...versionQuery(run.orchestration_id, run.orchestration_version),
		enabled: !!run.orchestration_version,
	});

	const name = orchestration.data?.name;
	useRunDocumentTitle(run, name);
	useTerminalNotice(run, name);
	// 收起了失败横幅的运行（换一个运行时横幅重新出现）。
	const [bannerClosed, setBannerClosed] = useState<string | null>(null);
	const failureBanner = run.status === "failed" && bannerClosed !== run.id;

	const now = useNow(running);
	const zoom = useSyncExternalStore(store.subscribe, () => store.get().zoom);
	const axis = useMemo<TimeAxis>(() => {
		const extent = runExtent(run, now);
		const live = run.status === "running";
		return { extent, range: visibleRange(extent, zoom), live, following: live && !zoom, now };
	}, [run, now, zoom]);

	const doc = version.data?.document;
	return (
		<MonitorProvider store={store} axis={axis}>
			{/* 规格最小宽度 1280；更窄时顶栏收成图标按钮，到 1024 仍不裁切操作。 */}
			<div className="fixed inset-0 flex min-w-[1024px] flex-col bg-bg">
				<MonitorTopBar
					run={run}
					name={name}
					failureInBanner={failureBanner && view === "detail"}
					view={view}
					onViewChange={changeView}
					onShowDetail={showDetail}
				/>
				<main className="flex min-h-0 flex-1 flex-col">
					<div
						role="tabpanel"
						id={VIEW_PANEL_ID}
						aria-labelledby={viewTabId(view)}
						className="flex min-h-0 flex-1 flex-col"
					>
						{view === "overview" ? (
							<Overview run={run} onOpenNode={openNode} located={address.node} />
						) : (
							<DetailView
								run={run}
								doc={doc}
								failureBanner={failureBanner}
								onCloseBanner={() => setBannerClosed(run.id)}
							/>
						)}
					</div>
				</main>
			</div>
		</MonitorProvider>
	);
}

/**
 * 详情（原来的运行监控页）：链路时间线、图表工作区、底部面板。图表工作区要不要收成一行（chartsCompact）依赖指标目录，
 * 所以目录在这里取、传给图表工作区；这些查询和快捷键只在详情里存在，概览不用它们。
 */
function DetailView({
	run,
	doc,
	failureBanner,
	onCloseBanner,
}: {
	run: RunView;
	doc: OrchestrationDocument | undefined;
	failureBanner: boolean;
	onCloseBanner: () => void;
}) {
	const catalog = useMetricCatalog(run.id, attemptsSignature(run));
	const compact = chartsCompact(run, catalog.data);
	useEscapeClearsSelection();
	useNextFailureShortcut(run);
	return (
		<>
			{failureBanner && <FailureBanner run={run} onClose={onCloseBanner} />}
			<Timeline run={run} doc={doc} />
			{/* 时间线下面的高度由图表工作区和底部面板分：底部面板最高到这里减去图表的最小高度，不被挤出窗口。 */}
			<div className="flex min-h-0 flex-1 flex-col">
				<ChartWorkspace run={run} doc={doc} catalog={catalog} compact={compact} />
				<BottomPanel run={run} doc={doc} />
			</div>
		</>
	);
}

/** 运行状态变化由顶栏的 `<output>` 播报，所以横幅不再播报一遍。 */
function FailureBanner({ run, onClose }: { run: RunView; onClose: () => void }) {
	const actions = useMonitorActions();
	const failure = runFailure(run);
	return (
		<Banner
			tone="danger"
			title="运行失败"
			className="flex-none rounded-none border-x-0 border-t-0 py-2"
			onDismiss={onClose}
			actions={
				failure && (
					<Button
						size="sm"
						onClick={() => {
							actions.report({ type: "failure", node: failure.ref });
						}}
					>
						查看失败节点
					</Button>
				)
			}
		>
			{failure && <span data-testid="run-failure">{failureSummary(failure)}</span>}
		</Banner>
	);
}

function useNextFailureShortcut(run: RunView) {
	const selected = useMonitor((s) => s.scope.selected);
	const actions = useMonitorActions();
	const next = nextFailure(run, selected);
	useShortcut(
		"monitor-next-failure",
		() => {
			if (next) actions.report({ type: "failure", node: next });
		},
		next !== null,
	);
}

const OPEN_MENU = '[role="menu"][data-open]';

/** 焦点在输入框里、有弹窗或菜单打开时 Esc 是它们的，不处理。 */
function useEscapeClearsSelection() {
	const selected = useMonitor((s) => s.scope.selected);
	const actions = useMonitorActions();
	useEffect(() => {
		if (!selected) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
			if (isEditable(event.target) || dialogOpen() || document.querySelector(OPEN_MENU)) return;
			event.preventDefault();
			actions.report({ type: "select", node: null });
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [selected, actions]);
}

/** 浏览器标签页标题：「● 运行中 · 日终数据处理 · sfly」；离开页面时恢复原来的标题。 */
function useRunDocumentTitle(run: RunView, name: string | undefined) {
	useEffect(() => {
		const previous = document.title;
		return () => {
			document.title = previous;
		};
	}, []);
	const title = runDocumentTitle(run, name ?? shortId(run.id));
	useEffect(() => {
		document.title = title;
	}, [title]);
}

/**
 * 运行结束的通知：只在页面上看着运行从「运行中」变成结束时弹出一次；打开一个已经结束的运行不弹。
 * 成功、取消分别用 notify.success / info。失败不发通知：失败要留在原处，由页内横幅（FailureBanner）承担。
 */
function useTerminalNotice(run: RunView, name: string | undefined) {
	const seen = useRef<RunView["status"] | null>(null);
	useEffect(() => {
		const before = seen.current;
		seen.current = run.status;
		if (before !== "running" || run.status === "running") return;
		const scenario = name ?? "场景";
		const took = run.ended_at
			? `${DURATION_LABEL} ${formatDuration(Date.parse(run.ended_at) - Date.parse(run.started_at))}`
			: undefined;
		if (run.status === "success") {
			notify.success(`${scenario} 运行成功`, { description: took });
		} else if (run.status === "cancelled") {
			notify.info(`${scenario} 运行已取消`, { description: took });
		}
	}, [run, name]);
}
