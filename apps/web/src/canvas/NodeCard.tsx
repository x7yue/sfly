import type { StructureWarning } from "@sfly/orchestration";
import { Handle, type NodeProps, Position, type ReactFlowState, useStore } from "@xyflow/react";
import { createContext, useContext } from "react";
import type { DocNode, SfNode } from "./flow";

/** 节点卡片需要的画布级信息。 */
export interface CanvasInfo {
	defaultAgent: string | undefined;
	/** 包节点类型的标题（来自节点包元信息）。 */
	titleOf(pkg: string, node: string): string | undefined;
	/** 包名 → 锁定的版本。 */
	packages: Record<string, string>;
	warnings: Map<string, StructureWarning[]>;
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

const KIND_COLOR: Record<DocNode["kind"], string> = {
	entry: "var(--sf-kind-entry)",
	subflow_entry: "var(--sf-kind-subflow-entry)",
	async: "var(--sf-kind-async)",
	timer: "var(--sf-kind-timer)",
	sleep: "var(--sf-kind-sleep)",
	package: "var(--sf-kind-package)",
};

export type ZoomLevel = "detail" | "compact" | "overview";

/** 语义缩放的分级（与 tokens.css 中的说明一致）。 */
const zoomLevel = (s: ReactFlowState): ZoomLevel => {
	const zoom = s.transform[2];
	return zoom >= 0.75 ? "detail" : zoom >= 0.4 ? "compact" : "overview";
};

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

/** 所有种类的节点共用的卡片：种类色条、标题、元信息；端口按种类决定。 */
export function NodeCard({ id, data, selected }: NodeProps<SfNode>) {
	const info = useContext(CanvasContext);
	const zoom = useStore(zoomLevel);
	const { node } = data;
	const warnings = info.warnings.get(id) ?? [];

	const hasChainIn = node.kind !== "entry" && node.kind !== "subflow_entry";
	return (
		<div
			className="sf-node"
			data-selected={selected}
			data-zoom={zoom}
			style={{ "--sf-kind-color": KIND_COLOR[node.kind] } as React.CSSProperties}
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
				<Handle
					type="target"
					position={Position.Top}
					id="dispatch"
					className="sf-port sf-port--dispatch"
					isConnectableStart={false}
				/>
			)}
			<div className="sf-node__bar" />
			<div className="sf-node__body">
				<div className="sf-node__kind">{KIND_LABEL[node.kind]}</div>
				<div className="sf-node__title">{nodeTitle(node, info)}</div>
				<NodeMeta node={node} info={info} id={id} />
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
			{warnings.length > 0 && <div className="sf-node__warning">!</div>}
		</div>
	);
}

function NodeMeta({ node, info, id }: { node: DocNode; info: CanvasInfo; id: string }) {
	switch (node.kind) {
		case "entry":
		case "subflow_entry":
			return (
				<div className="sf-node__meta">
					<span>{id}</span>
					<span>
						{node.params.length === 0
							? "无参数"
							: node.params.map((p) => (p.secret ? `${p.name}*` : p.name)).join(", ")}
					</span>
				</div>
			);
		case "package": {
			const agent = node.agent ?? info.defaultAgent;
			return (
				<div className="sf-node__meta">
					<span>{id}</span>
					<span>
						{node.package}@{info.packages[node.package] ?? "?"}
					</span>
					<span>
						Agent：{agent ?? "未选择"}
						{node.agent ? "" : agent ? "（默认）" : ""}
					</span>
				</div>
			);
		}
		case "timer":
			return <div className="sf-node__meta">at {node.at}</div>;
		case "sleep":
			return <div className="sf-node__meta">{node.duration}</div>;
		default:
			return <div className="sf-node__meta">{id}</div>;
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
