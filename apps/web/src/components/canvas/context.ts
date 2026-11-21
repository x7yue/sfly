import type { ArrangeMode, EdgeEnds, Position } from "@sfly/orchestration";
import type { AnnotationColor } from "@sfly/schema";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { CurrentActivity } from "#/actions/current-activity";
import type { StatusView } from "#/components/status";
import type { AnnotationDrop } from "./annotation-drop";
import type { DocEdge, DocNode } from "./flow";
import { type CanvasSelection, NO_SELECTION } from "./selection";

/**
 * 画布组件的扩展点（FlowCanvas 的 props 经 context 传给节点卡片、连线和子流程区域）。
 * 编辑模式（#35）只用 info；之后的票据在这里叠加信息，不需要改画布本身：
 *
 * - 运行状态（#41）：decorateNode 返回 `run`（卡片描边、小地图颜色）和 `status`（站点灯换成状态标记），
 *   `figure`（第一行右侧的实时数字）、`detail`（第二行的失败原因或主指标，#43）与 `progress`（底边的进度线）；
 *   decorateEdge 返回连线在线路图里的样子（走过的变亮、没走到的暗灰、进入执行中 / 失败 / 等待中节点的着状态色，
 *   子流程结束后调度连线变灰，见 EdgeDecoration），enteringEdges 是其中刚变成执行中的连线（流动两遍）；
 *   regionMeta 替换子流程区域标题行右侧的「由 X 触发 · N 个节点」（例如实例状态与实例切换）。
 * - 正在做（#356）：decorateNode 返回 `activity`，执行中的卡片第二行写它（有主指标时另起一行，卡片往下长），
 *   可访问名称里也有它。
 * - 关注项（#353）：decorateNode 返回 `focus`，卡片上边线外是眼睛图标和数量，节点开始执行以后两行字下面列出前两项。
 * - 版本对比（#40）：decorateNode 返回 `mark`（新增 / 删除 / 修改）和 `status`（第一行右侧的差异标签）；
 *   配合 FlowCanvas 的 `editable={false}` 做只读画布。
 */

/** 运行中的节点状态（与原型 `.n[data-run=…]` 对应；节点状态对应哪一种见 lib/node-status）。 */
export type NodeRunState =
	| "pending"
	| "running"
	| "waiting"
	| "done"
	| "failed"
	| "skipped"
	| "cancelled"
	| "stopped";

export interface NodeDecoration {
	run?: NodeRunState;
	/**
	 * 状态（读屏名称里也带上）。有 `run` 时站点灯换成它的标记；没有 `run` 时（版本对比的差异）写在第一行右侧，
	 * 替换「N 警告」。
	 */
	status?: StatusView;
	/** 第一行右侧的实时数字：进度（282/600）、耗时。 */
	figure?: ReactNode;
	/** 第二行节点 ID 后面的内容（失败原因、主指标），替换配置摘要。 */
	detail?: ReactNode;
	/** 0–1：执行中有总数的进度，画成卡片底边的进度线。 */
	progress?: number;
	/**
	 * 站外一行：缩小视图时卡片里只放得下灯和标题，执行中、失败、等待中的站在胶囊下方挂一行，写进度、
	 * 已运行时长或失败原因（看全图时卡片在前面加上标题）。只给这三种要盯的状态。
	 */
	overview?: ReactNode;
	/**
	 * 执行中的节点此刻在做什么（动作，没有动作时是进度的说明）。没有 `detail` 时它写在第二行、代替配置摘要
	 * （执行中配置摘要没什么可看的，卡片也不变高）；有主指标时另起一行，卡片往下长一行。
	 */
	activity?: CurrentActivity;
	/** 属于这个节点的关注项（运行状态下，场景设了关注项时）；没设时，主指标有异常的节点只带说明异常原因的 `label`。 */
	focus?: CardFocus;
	/** 版本对比的差异标记。 */
	mark?: "added" | "removed" | "changed";
}

/** 节点卡片上属于这个节点的关注项（场景没设关注项时是主指标，只有 `label`）。 */
export interface CardFocus {
	/** 关注项的个数：卡片上边线外眼睛图标旁的数量；场景没设关注项时没有。 */
	count?: number;
	/** 接在卡片可访问名称后面的一段：个数，有异常时还有几项需要注意和原因（CardFocus.tsx 的 `cardFocusLabel`）。 */
	label: string;
	/**
	 * 两行字下面的前两项和「还有 N 个关注项」：节点开始执行以后才有，还没开始时没有。卡片按内容长高。
	 */
	rows?: ReactNode;
}

/**
 * 节点卡片所在的底色（卡片上的 data-ground / data-ground-subflow，见 tokens.css）：所在注释框的颜色或画布，
 * 在子流程区域里时再叠上区域的淡紫（框里的子流程两样都有）。已完成、跳过、停止的卡片「下沉」到这层底色：
 * 底色等于它，只留一圈灰描边。
 */
export interface NodeGround {
	color: AnnotationColor | "canvas";
	subflow: boolean;
}

/** 不在注释框、也不在子流程区域里的节点。 */
export const CANVAS_GROUND: NodeGround = { color: "canvas", subflow: false };

/**
 * 运行状态下连线的样子（线路图，docs/DESIGN-SYSTEM.md §2.3）。链连线：`travelled` 走过的（两端都已完成，变亮变粗）、
 * `ahead` 还没走到的（暗灰）、`live` 进入执行中节点的（青）、`failed` 进入失败节点的（红）、`waiting` 进入等待中节点的
 * （琥珀）。调度连线：`live` 子流程还在运行（青色虚线）、`ended` 子流程已经结束或没有触发（灰色虚线）。
 */
export type EdgeDecoration = "live" | "failed" | "waiting" | "travelled" | "ahead" | "ended";

/** 节点卡片需要的画布级信息；`titleOf` 和 `subflowLabelOf` 同时是节点显示规则（nodeCardText）要查的信息。 */
export interface CanvasInfo {
	defaultAgent: string | undefined;
	/** 包节点类型的标题（来自节点包元信息）。 */
	titleOf(pkg: string, node: string): string | undefined;
	/** 包名 → 锁定的版本。 */
	packages: Readonly<Record<string, string>>;
	/** 子流程入口节点 ID → 子流程的显示名称（@sfly/orchestration 的 subflowLabels）；不是子流程入口时为 undefined。 */
	subflowLabelOf(id: string): string | undefined;
	/** 节点 ID → 静态检查警告（编辑模式）。 */
	warnings: ReadonlyMap<string, readonly { message: string }[]>;
}

/** 每个节点的端口是否连了线：已连接的端口实心，链尾的出口虚线（可以从这里追加）。 */
export interface PortState {
	in: boolean;
	out: boolean;
	dispatch: boolean;
}

/** 卡片标题的原地编辑（改显示名称）：状态在使用方，FlowCanvas 只在可编辑时把它交给节点卡片。 */
export interface NodeRename {
	/** 正在原地编辑的节点；没有时为 null。 */
	active: string | null;
	/** 进入原地编辑；不能起显示名称的节点（子流程入口）什么也不做。 */
	start(id: string): void;
	/** 确认（Enter、失焦）：`text` 是输入框里的原文，空白表示清除显示名称。 */
	commit(id: string, text: string): void;
	/** 取消（Esc）：不改场景。 */
	cancel(): void;
}

/**
 * 可编辑画布上注释框和多选的操作（FlowCanvas 的 `annotationEdit`）：原地改注释框标题、浮动工具条、
 * 把节点拖进拖出注释框。状态和对场景的修改都在使用方，每个操作是一步撤销（拖进拖出和那次拖动合成一步）。
 */
export interface AnnotationEdit {
	/** 正在原地改标题的注释框；没有时为 null。 */
	renaming: string | null;
	/** 进入原地编辑（双击标题、F2）。 */
	startRename(id: string): void;
	/** 确认（Enter、失焦）：`text` 是输入框里的原文，去掉首尾空白后为空或和原来相同时不改。 */
	commitRename(id: string, text: string): void;
	/** 取消（Esc）：不改场景。 */
	cancelRename(): void;
	setColor(id: string, color: AnnotationColor): void;
	/** 删除注释框，成员节点不动。 */
	remove(id: string): void;
	/** 用这组节点新建注释框（成员的记法和节点菜单的「添加注释框」一样）。 */
	create(ids: readonly string[]): void;
	/** 把这组节点排成宫格、一行或一列。 */
	arrange(ids: readonly string[], mode: ArrangeMode): void;
	/** 拖动节点松手时加入、移出注释框。 */
	drop(drop: AnnotationDrop): void;
}

/**
 * 可编辑画布上便签的操作（FlowCanvas 的 `stickyEdit`，ADR 0026）。状态和对场景的修改都在使用方：
 * 一次拖动、一次改大小各是一步撤销（`dragging` 为 true 的第一次记下修改前的状态，松手时为 false）。
 */
export interface StickyEdit {
	select(id: string): void;
	move(id: string, position: Position, dragging: boolean): void;
	resize(id: string, size: { width: number; height: number }, dragging: boolean): void;
	/** 双击：打开检查器改文字。 */
	open(id: string): void;
	setColor(id: string, color: AnnotationColor): void;
	remove(id: string): void;
}

export interface CanvasContextValue {
	info: CanvasInfo;
	selection: CanvasSelection;
	ports: ReadonlyMap<string, PortState>;
	/** 节点 ID → 卡片所在的底色；不在注释框和子流程区域里的不在表里（画布）。 */
	grounds: ReadonlyMap<string, NodeGround>;
	decorateNode?: (id: string, node: DocNode) => NodeDecoration | undefined;
	decorateEdge?: (edge: {
		from: string;
		to: string;
		kind: "chain" | "dispatch";
	}) => EdgeDecoration | undefined;
	/** 刚变成执行中的连线（`edgeId`）：虚线流动两遍后停下；其余执行中的连线是静止的实线。 */
	enteringEdges?: ReadonlySet<string>;
	regionMeta?: (subflowEntryId: string) => ReactNode;
	/** 适配视图（避开悬浮控件）；右键菜单的「适配视图」用它（CanvasMenu.tsx）。 */
	fit(): void;
	/**
	 * 连线中点的「＋」（EdgeInsert.tsx）：只在可编辑时给出，点它在这条链上的连线中间插入节点；
	 * `client` 是添加节点菜单出现的屏幕坐标。
	 */
	insertOnEdge?: (edge: EdgeEnds, client: Position) => void;
	/** 打开连线菜单（在「＋」上右键时用，连线本身的右键由 FlowCanvas 处理）。 */
	openEdgeMenu?: (edge: DocEdge, client: Position) => void;
	/** 原地改显示名称：只在可编辑时给出（只读画布的卡片标题不响应双击）。 */
	rename?: NodeRename;
}

export const EMPTY_INFO: CanvasInfo = {
	defaultAgent: undefined,
	titleOf: () => undefined,
	packages: {},
	subflowLabelOf: () => undefined,
	warnings: new Map(),
};

export const FlowCanvasContext = createContext<CanvasContextValue>({
	info: EMPTY_INFO,
	selection: NO_SELECTION,
	ports: new Map(),
	grounds: new Map(),
	fit: () => {},
});

export const useFlowCanvas = () => useContext(FlowCanvasContext);
