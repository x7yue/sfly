import type { AttemptView, NodeRunView, RunView } from "@sfly/schema";
import { type NodeRef, sameNode } from "./node-ref";
import type { MonitorSearch, PanelTab } from "./run-link";
import { findNode, initialSelection } from "./run-model";

/**
 * 运行监控详情里「看的范围」的状态机（不依赖 React）：选中哪个节点、看它的哪一次尝试、底部面板停在哪个页签、
 * 日志要定位到哪一刻、面板展开还是收起。时间线、图表工作区和底部面板只读 {@link resolveScope} 的结果，
 * 要改范围就向 {@link reduceScope} 报告「发生了什么」（{@link ScopeEvent}），不需要知道因此要改哪几个字段、按什么顺序。
 *
 * 状态只记用户（或地址）表达过的意图；「现在看的是哪一次尝试」要对着运行视图才算得出来
 * （运行中重试出了新的一次，没指定过尝试时看的就是新的那一次），所以 {@link resolveScope} 每次拿当前的运行视图来算。
 * 范围里的几项规则：
 *
 * - 换了节点，回到默认的那一次尝试（最近一次）；选中已经选中的节点不算换。
 * - 点合并日志里的来源节点名：选中这个节点，看的是那一行所在的尝试。
 * - 定位日志：定位的时刻落在节点的哪一次尝试里就看哪一次（早于所有尝试时是最近一次）；之后手动切到别的尝试，
 *   那一刻不在它的日志里，不再定位，切回来再定位；同一个时刻再请求一次也重新定位（读者可能已经滚到别处）。
 *   定位的请求只对请求时的节点有效，选中别的节点时不定位。
 * - 打开页面时只默认选中地址里的节点或第一个失败的节点（执行中的节点不默认选中）；地址里的页签、日志时刻照做。
 *   页面打开之后地址变了再应用一次，地址没变不重复应用；页面里自己的操作（点节点、切页签）不写回地址，所以同一个地址
 *   报告再多次也不会撤销它们。视图（概览、详情）不算地址里决定打开哪里的部分：切视图不重置选中的节点。
 * - 底部面板展开与否（{@link panelOpen}）：用户没展开 / 收起过、也没切过页签时，日志页签没有内容（选中的节点还没开始，
 *   或日志读完是空的）就收起，内容到了再展开；用户选过之后听用户的。日志有没有内容是读日志的人才知道的事实，
 *   不记在状态里，调用方读到以后直接传给 {@link panelOpen}。
 */

/** 要在日志里定位的时刻（控制面时间，毫秒）；`request` 变了就重新定位。 */
export interface LogMoment {
	at: number;
	request: number;
}

export interface ScopeState {
	/** 选中的节点。 */
	selected: NodeRef | null;
	/** 用户指定的那一次尝试（任务 ID）；null 是默认：定位的时刻所在的、或最近的一次。换节点、定位日志后回到 null。 */
	attempt: string | null;
	tab: PanelTab;
	/** 用户展开 / 收起面板：true / false；null 表示还没选过，按内容自动决定。 */
	open: boolean | null;
	/** 最近一次定位日志的请求；`request` 每请求一次加一。它不随选中的节点清掉，只对 `node` 有效。 */
	locate: (LogMoment & { node: NodeRef }) | null;
	/** 最近一次应用的地址的键（{@link addressKey}）；还没应用过为 null。 */
	applied: string | null;
}

export const EMPTY_SCOPE: ScopeState = {
	selected: null,
	attempt: null,
	tab: "logs",
	open: null,
	locate: null,
	applied: null,
};

/** 范围里发生的事。 */
export type ScopeEvent =
	/** 地址来了：打开页面，或页面开着时地址变了。和上一次应用的地址（节点、页签、时刻）一样时不重复应用。 */
	| { type: "address"; run: RunView; address: MonitorSearch }
	/** 概览里点一项直达详情：按它的地址应用，和上一次应用的地址一样也照做（切回概览再点一次要重新定位）。 */
	| { type: "overview"; run: RunView; address: MonitorSearch }
	/** 点节点（时间线的节点行和区段）；`null` 是清除选中。 */
	| { type: "select"; node: NodeRef | null }
	/** 点合并日志里一行的来源节点名：选中这个节点，看那一行所在的尝试。 */
	| { type: "origin"; node: NodeRef; taskId: string }
	/** 手动切到节点的某一次尝试。 */
	| { type: "attempt"; taskId: string }
	/** 选中节点，打开日志页签，定位到那一刻（控制面时间，毫秒）。 */
	| { type: "locate"; node: NodeRef; at: number }
	/** 看失败的节点：选中它，打开「尝试」页签。 */
	| { type: "failure"; node: NodeRef }
	/** 切到底部面板的某个页签（用户选了页签，面板随之展开）。 */
	| { type: "tab"; tab: PanelTab }
	/** 用户展开 / 收起面板（拖动高度也算展开）；`null` 回到按内容自动决定。 */
	| { type: "panel"; open: boolean | null };

const select = (state: ScopeState, node: NodeRef | null): ScopeState =>
	sameNode(node, state.selected) ? state : { ...state, selected: node, attempt: null };

const showTab = (state: ScopeState, tab: PanelTab): ScopeState =>
	state.tab === tab && state.open === true ? state : { ...state, tab, open: true };

const locate = (state: ScopeState, node: NodeRef, at: number): ScopeState => ({
	...state,
	selected: node,
	attempt: null,
	tab: "logs",
	open: true,
	locate: { node, at, request: (state.locate?.request ?? 0) + 1 },
});

/** 地址里决定打开哪里的部分（节点、页签、时刻）；视图不算。 */
const addressKey = (address: MonitorSearch) =>
	`${address.node ?? ""}\n${address.tab ?? ""}\n${address.at ?? ""}`;

/**
 * 把地址里的位置变成范围：选中节点（没给节点时是失败的节点）、切到页签；带了 `at` 又给了运行里有的节点时，
 * 打开这个节点的日志并定位到那一刻，没给页签时就是日志页签。
 */
function applyAddress(state: ScopeState, run: RunView, address: MonitorSearch): ScopeState {
	const selected = initialSelection(run, address.node);
	const at = address.at === undefined ? Number.NaN : Date.parse(address.at);
	const located =
		selected && selected.nodeId === address.node && Number.isFinite(at)
			? locate(state, selected, at)
			: select(state, selected);
	return {
		...(address.tab ? showTab(located, address.tab) : located),
		applied: addressKey(address),
	};
}

/** 打开页面时的范围：页面第一次拿到运行视图，按地址决定选中的节点和页签。 */
export const openedScope = (run: RunView, address: MonitorSearch): ScopeState =>
	applyAddress(EMPTY_SCOPE, run, address);

/** 范围的下一个状态；什么都没变时返回原来的对象。 */
export function reduceScope(state: ScopeState, event: ScopeEvent): ScopeState {
	switch (event.type) {
		case "address":
			return state.applied === addressKey(event.address)
				? state
				: applyAddress(state, event.run, event.address);
		case "overview":
			return applyAddress(state, event.run, event.address);
		case "select":
			return select(state, event.node);
		case "origin":
			return { ...state, selected: event.node, attempt: event.taskId };
		case "attempt":
			return state.attempt === event.taskId ? state : { ...state, attempt: event.taskId };
		case "locate":
			return locate(state, event.node, event.at);
		case "failure":
			return showTab(select(state, event.node), "attempts");
		case "tab":
			return showTab(state, event.tab);
		case "panel":
			return state.open === event.open ? state : { ...state, open: event.open };
	}
}

/** 现在的范围：状态加上运行视图算出来的，调用方只读它。 */
export interface Scope {
	selected: NodeRef | null;
	/** 选中的节点在运行视图里的样子；没有选中、或运行里没有这个节点时为 undefined。 */
	node: NodeRunView | undefined;
	/** 看的那一次尝试；没有选中节点、或节点还没有尝试时为 undefined。 */
	attempt: AttemptView | undefined;
	tab: PanelTab;
	/** 要在这次尝试的日志里定位的时刻；不定位时为 null（包括用户切到了别的尝试）。 */
	locate: LogMoment | null;
	/** 用户展开 / 收起过面板：true / false；null 是还没选过，按内容自动决定（{@link panelOpen}）。 */
	panel: boolean | null;
	/** 选中的节点还没有开始：没有日志可看。 */
	noAttempt: boolean;
}

/**
 * 面板展开与否：用户选过听用户的；没选过时，日志页签没有内容就收起，别的页签总是展开。
 * `logsEmpty` 是日志页签读完了、没有任何日志（没读、还在读、筛选了级别时不算）。
 */
export const panelOpen = (scope: Scope, logsEmpty: boolean): boolean =>
	scope.panel ?? !(scope.tab === "logs" && (scope.noAttempt || logsEmpty));

/** 日志页签要读日志：在日志页签、用户没有收起面板。自动收起时也要读，日志到了才能自动展开。 */
export const readsLogs = (scope: Scope): boolean => scope.tab === "logs" && scope.panel !== false;

/**
 * 那一刻（控制面时间，毫秒）落在节点的哪一次尝试里：开始时间不晚于那一刻的最后一次。同一个节点的尝试一次只有一个在执行，
 * 所以这次尝试要么正在执行，要么是下一次开始之前的最后一次；早于第一次尝试、或没有开始过的尝试时为 undefined。
 */
const attemptAt = (node: NodeRunView, at: number): AttemptView | undefined =>
	node.attempts.filter((a) => a.started_at !== null && Date.parse(a.started_at) <= at).at(-1);

export function resolveScope(state: ScopeState, run: RunView): Scope {
	const node = findNode(run, state.selected);
	// 定位的请求只对请求时的节点有效。
	const moment = state.locate && sameNode(state.locate.node, state.selected) ? state.locate : null;
	/** 定位的时刻落在的那一次尝试（它早于所有尝试时是最近一次）。 */
	const located = node && moment ? (attemptAt(node, moment.at) ?? node.attempts.at(-1)) : undefined;
	const attempt =
		node?.attempts.find((a) => a.task_id === state.attempt) ?? located ?? node?.attempts.at(-1);
	return {
		selected: state.selected,
		node,
		attempt,
		tab: state.tab,
		locate:
			moment && attempt !== undefined && attempt === located
				? { at: moment.at, request: moment.request }
				: null,
		panel: state.open,
		noAttempt: node !== undefined && attempt === undefined,
	};
}
