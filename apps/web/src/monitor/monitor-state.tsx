import type { RunView } from "@sfly/schema";
import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import {
	EMPTY_SCOPE,
	reduceScope,
	resolveScope,
	type Scope,
	type ScopeEvent,
	type ScopeState,
} from "./monitor-scope";
import type { TimeRange } from "./timeline-model";

/**
 * 运行监控页的共享状态。链路时间线、底部面板与中间的图表工作区（#42）都从这里读写，
 * 所以三者的悬停竖线、缩放范围、日志标记和选中节点始终一致。分两部分：
 *
 * - 时间轴：悬停的时刻、缩放范围、日志标记，都是毫秒时间戳，直接读写。
 * - 看的范围（选中哪个节点、看哪一次尝试、底部面板的页签与展开、日志定位到哪一刻）：规则在 monitor-scope.ts 的状态机里，
 *   这里只持有它的状态；调用方报告发生了什么（`actions.report(event)`），读现在的范围用 `useScope(run)`。
 *
 * 图表工作区（#42）的接入方式：
 *
 *   const { range, extent, live, following } = useTimeAxis();   // 当前显示的时间范围（毫秒时间戳）
 *   const hoverAt = useMonitor((s) => s.hoverAt);                 // 悬停时刻：在图表上画竖线、读数
 *   const marker = useMonitor((s) => s.marker);                   // 日志标记：在图表上画标记线
 *   const selected = useMonitor((s) => s.scope.selected);         // 选中的节点：高亮对应的图表分组
 *   const actions = useMonitorActions();
 *   actions.hover(t)            // 鼠标在图表上移动时（离开时传 null），时间线上同步显示竖线
 *   actions.zoom({ start, end }) // 在图表上拖选缩放；actions.followLive() 回到实时
 *   actions.setFilter(keys)     // 图表工作区的节点筛选（nodeKey / PLATFORM_KEY 的集合，null 为全部）；
 *                               // 没有选中节点时，底部面板的范围跟随筛选
 *   actions.report({ type: "select", node })  // 选中节点（null 清除），底部面板随之切换；其余事件见 monitor-scope.ts 的 ScopeEvent
 *
 * hoverAt 更新很频繁，状态放在一个外部 store 里，组件按 selector 订阅，
 * 只有用到的字段变化时才重新渲染；range / extent 每秒随「现在」变化，放在 context 里。
 */

export interface MonitorState {
	/** 鼠标悬停的时刻；不在时间轴上时为 null。 */
	hoverAt: number | null;
	/** 拖选的缩放范围；null 表示显示整个运行（运行中即实时跟随最新）。 */
	zoom: TimeRange | null;
	/** 点日志行在时间轴上标出的时刻。 */
	marker: number | null;
	/** 图表工作区的节点筛选：{@link nodeKey} 与 {@link PLATFORM_KEY} 的集合；null 表示全部。 */
	filter: ReadonlySet<string> | null;
	/** 看的范围的状态（只由 {@link reduceScope} 改）。 */
	scope: ScopeState;
}

export interface MonitorActions {
	hover: (at: number | null) => void;
	zoom: (range: TimeRange) => void;
	/** 清除缩放：显示整个运行，运行中时回到实时跟随。 */
	followLive: () => void;
	mark: (at: number | null) => void;
	setFilter: (filter: ReadonlySet<string> | null) => void;
	/** 报告范围里发生的事。 */
	report: (event: ScopeEvent) => void;
}

type Listener = () => void;

export interface MonitorStore extends MonitorActions {
	get: () => MonitorState;
	subscribe: (listener: Listener) => () => void;
}

export function createMonitorStore(initial: Partial<MonitorState> = {}): MonitorStore {
	let state: MonitorState = {
		hoverAt: null,
		zoom: null,
		marker: null,
		filter: null,
		scope: EMPTY_SCOPE,
		...initial,
	};
	const listeners = new Set<Listener>();
	const set = (patch: Partial<MonitorState>) => {
		state = { ...state, ...patch };
		for (const l of listeners) l();
	};
	return {
		get: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		hover: (hoverAt) => state.hoverAt !== hoverAt && set({ hoverAt }),
		zoom: (zoom) => set({ zoom }),
		followLive: () => set({ zoom: null }),
		mark: (marker) => set({ marker }),
		setFilter: (filter) => set({ filter }),
		report: (event) => {
			const scope = reduceScope(state.scope, event);
			if (scope !== state.scope) set({ scope });
		},
	};
}

/** 当前显示的时间轴（每秒随「现在」更新）。 */
export interface TimeAxis {
	/** 整个运行占的时间（运行中到现在）。 */
	extent: TimeRange;
	/** 当前显示的范围：缩放范围，或整个运行。 */
	range: TimeRange;
	/** 运行还在进行。 */
	live: boolean;
	/** 运行中且没有缩放：右端随现在推进。 */
	following: boolean;
	/** 现在（毫秒时间戳，每秒更新）。 */
	now: number;
}

const StoreContext = createContext<MonitorStore | null>(null);
const AxisContext = createContext<TimeAxis | null>(null);

export function MonitorProvider({
	store,
	axis,
	children,
}: {
	store: MonitorStore;
	axis: TimeAxis;
	children: React.ReactNode;
}) {
	return (
		<StoreContext.Provider value={store}>
			<AxisContext.Provider value={axis}>{children}</AxisContext.Provider>
		</StoreContext.Provider>
	);
}

function useStore(): MonitorStore {
	const store = useContext(StoreContext);
	if (!store) throw new Error("useMonitor 必须在 MonitorProvider 里使用");
	return store;
}

/** 订阅共享状态的一部分；selector 的结果变化时（Object.is）才重新渲染。 */
export function useMonitor<T>(selector: (state: MonitorState) => T): T {
	const store = useStore();
	const selectorRef = useRef(selector);
	selectorRef.current = selector;
	return useSyncExternalStore(store.subscribe, () => selectorRef.current(store.get()));
}

export function useMonitorActions(): MonitorActions {
	const store = useStore();
	return useMemo(
		() => ({
			hover: store.hover,
			zoom: store.zoom,
			followLive: store.followLive,
			mark: store.mark,
			setFilter: store.setFilter,
			report: store.report,
		}),
		[store],
	);
}

/** 现在的范围：看的是哪个节点的哪一次尝试、页签、日志定位、面板展开与否（规则见 monitor-scope.ts）。 */
export function useScope(run: RunView): Scope {
	const state = useMonitor((s) => s.scope);
	return useMemo(() => resolveScope(state, run), [state, run]);
}

export function useTimeAxis(): TimeAxis {
	const axis = useContext(AxisContext);
	if (!axis) throw new Error("useTimeAxis 必须在 MonitorProvider 里使用");
	return axis;
}

/** 筛选集合里代表平台自带图表的键。 */
export const PLATFORM_KEY = "platform";
