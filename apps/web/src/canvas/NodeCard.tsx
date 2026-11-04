import type { OrchestrationWarning } from "@sfly/orchestration";
import { Handle, type NodeProps, Position, type ReactFlowState, useStore } from "@xyflow/react";
import { createContext, useContext } from "react";
import type { DocNode, SfNode } from "./flow";
import { Icon, type IconName } from "./icons";

/** 节点卡片需要的画布级信息。 */
export interface CanvasInfo {
	defaultAgent: string | undefined;
	/** 包节点类型的标题（来自节点包元信息）。 */
	titleOf(pkg: string, node: string): string | undefined;
	/** 包名 → 锁定的版本。 */
	packages: Record<string, string>;
	warnings: Map<string, OrchestrationWarning[]>;
}

export const CanvasContext = createContext<CanvasInfo>({
	defaultAgent: undefined,
	titleOf: () => undefined,
	packages: {},
	warnings: new Map(),
});

export const KIND_LABEL: Record<DocNode["kind"], string> = {
	entry: "入口",
	subflow_entry: "子流程入口",
	async: "异步任务",
	timer: "定时",
	sleep: "Sleep",
	package: "包节点",
};

export const KIND_COLOR: Record<DocNode["kind"], string> = {
	entry: "var(--sf-kind-entry)",
	subflow_entry: "var(--sf-kind-subflow-entry)",
	async: "var(--sf-kind-async)",
	timer: "var(--sf-kind-timer)",
	sleep: "var(--sf-kind-sleep)",
	package: "var(--sf-kind-package)",
};

export const KIND_ICON: Record<DocNode["kind"], IconName> = {
	entry: "play",
	subflow_entry: "route",
	async: "zap",
	timer: "clock",
	sleep: "timer",
	package: "cpu",
};

/** 语义缩放阈值（与画布原型的 LOD_THRESHOLD 一致）。 */
export const LOD_THRESHOLD = 0.95;
const zoomOf = (s: ReactFlowState) => s.transform[2];

export function nodeTitle(node: DocNode, info: CanvasInfo): string {
	switch (node.kind) {
		case "entry":
			return "入口";
		case "package":
			return info.titleOf(node.package, node.node) ?? `${node.package}/${node.node}`;
		default:
			return KIND_LABEL[node.kind];
	}
}

/** 种类标签：种类色 15% 底 + 图标。 */
export function KindChip({ kind }: { kind: DocNode["kind"] }) {
	return (
		<span
			className="sf-chip"
			style={{ "--sf-kind-color": KIND_COLOR[kind] } as React.CSSProperties}
			aria-hidden="true"
		>
			<Icon name={KIND_ICON[kind]} />
		</span>
	);
}

/** 所有种类的节点共用的卡片；端口按种类决定。 */
export function NodeCard({ id, data, selected }: NodeProps<SfNode>) {
	const info = useContext(CanvasContext);
	const zoom = useStore(zoomOf);
	const { node } = data;
	const warnings = info.warnings.get(id) ?? [];
	const title = nodeTitle(node, info);
	const metrics = nodeMetrics(node, info);

	const hasChainIn = node.kind !== "entry" && node.kind !== "subflow_entry";
	return (
		<div
			className="sf-node"
			data-selected={selected}
			data-lod={zoom < LOD_THRESHOLD}
			style={{ "--sf-zs": zoom } as React.CSSProperties}
			title={warnings.map((w) => w.message).join("\n") || undefined}
		>
			{hasChainIn && (
				<Handle
					type="target"
					position={Position.Left}
					id="chain"
					className="sf-port"
					isConnectableStart={false}
				/>
			)}
			{node.kind === "subflow_entry" && (
				// 子流程入口节点没有链上的入线，左侧输入端口只接收调度连线。
				<Handle
					type="target"
					position={Position.Left}
					id="dispatch"
					className="sf-port"
					isConnectableStart={false}
				/>
			)}
			<div className="sf-node__head">
				<KindChip kind={node.kind} />
				<span className="sf-node__id">{id}</span>
				<span className="sf-node__type">{KIND_LABEL[node.kind]}</span>
				{warnings.length > 0 ? (
					<span className="sf-status sf-status--warn">
						<i />
						{warnings.length} 警告
					</span>
				) : (
					<span className="sf-status">
						<i />
						就绪
					</span>
				)}
			</div>
			<div className="sf-node__title">{title}</div>
			<div className="sf-node__sub">{nodeSubtitle(node)}</div>
			<div className="sf-node__metrics">
				{metrics.map(([label, value]) => (
					<div key={label}>
						<span>{label}</span>
						<b title={value}>{value}</b>
					</div>
				))}
			</div>
			<Handle
				type="source"
				position={Position.Right}
				id="chain"
				className="sf-port"
				isConnectableEnd={false}
			/>
			{node.kind === "async" && (
				<Handle
					type="source"
					position={Position.Bottom}
					id="dispatch"
					className="sf-port sf-port--dispatch"
					isConnectableEnd={false}
				/>
			)}
		</div>
	);
}

function nodeSubtitle(node: DocNode): string {
	const always = "always" in node && node.always ? " · always" : "";
	switch (node.kind) {
		case "entry":
			return "主链起点";
		case "subflow_entry":
			return "子流程起点";
		case "async":
			return "触发子流程，主链继续";
		case "timer":
			return `${node.tz}${always}`;
		case "sleep":
			return `等待一段时长${always}`;
		case "package":
			return `${node.package}/${node.node}${always}`;
	}
}

/** 指标槽：语义缩放时只保留第一行的值。 */
function nodeMetrics(node: DocNode, info: CanvasInfo): [string, string][] {
	switch (node.kind) {
		case "entry":
		case "subflow_entry":
			return [
				[
					"参数",
					node.params.length === 0
						? "无"
						: node.params.map((p) => (p.secret ? `${p.name}*` : p.name)).join(", "),
				],
			];
		case "async":
			return [["参数映射", `${Object.keys(node.params).length} 个`]];
		case "timer":
			return [["at", node.at]];
		case "sleep":
			return [["时长", node.duration]];
		case "package": {
			const agent = node.agent ?? info.defaultAgent;
			return [
				["Agent", agent ? `${agent}${node.agent ? "" : "（默认）"}` : "未选择"],
				["版本", info.packages[node.package] ?? "未锁定"],
			];
		}
	}
}

export const nodeTypes = {
	entry: NodeCard,
	subflow_entry: NodeCard,
	async: NodeCard,
	timer: NodeCard,
	sleep: NodeCard,
	package: NodeCard,
};
