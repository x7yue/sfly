import type { EdgeEnds, Position } from "@sfly/orchestration";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { DocEdge, DocNode } from "./flow";

/**
 * 画布组件的扩展点（FlowCanvas 的 props 经 context 传给节点卡片、连线和子流程区域）。
 * 编辑模式（#35）只用 info；之后的票据在这里叠加信息，不需要改画布本身：
 *
 * - 运行状态（#41）：decorateNode 返回 `run`（卡片描边 / 透明度、小地图颜色）和 `status`（替换右上角的
 *   「N 警告」，没有警告时不显示）；decorateEdge 返回 `live`（进入执行中节点的连线，青色实线）或 `failed`；
 *   regionMeta 替换子流程区域标题行右侧的「由 X 触发 · N 个节点」（例如实例状态与实例切换）。
 * - 主指标槽（#43）：decorateNode 返回 `slot`，替换卡片底部的配置摘要。
 * - 版本对比（#40）：decorateNode 返回 `mark`（新增 / 删除 / 修改），卡片加差异标记；
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
	/** 替换卡片右上角的状态。 */
	status?: ReactNode;
	/** 替换卡片底部的摘要槽（主指标）。 */
	slot?: ReactNode;
	/** 版本对比的差异标记。 */
	mark?: "added" | "removed" | "changed";
}

export type EdgeDecoration = "live" | "failed";

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

export interface CanvasContextValue {
	info: CanvasInfo;
	selectedId: string | null;
	ports: ReadonlyMap<string, PortState>;
	decorateNode?: (id: string, node: DocNode) => NodeDecoration | undefined;
	decorateEdge?: (edge: {
		from: string;
		to: string;
		kind: "chain" | "dispatch";
	}) => EdgeDecoration | undefined;
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
	selectedId: null,
	ports: new Map(),
	fit: () => {},
});

export const useFlowCanvas = () => useContext(FlowCanvasContext);
