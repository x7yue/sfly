import { type NodeProps, Position } from "@xyflow/react";
import { cn } from "cn";
import type { CSSProperties } from "react";
import { StatusPill } from "#/components/status";
import { BaseHandle } from "@/components/ui/base-handle";
import { BaseNode, BaseNodeHeader, BaseNodeHeaderTitle } from "@/components/ui/base-node";
import { useFlowCanvas } from "./context";
import type { SfNode } from "./flow";
import { NODE_HEIGHT, NODE_RADIUS, NODE_WIDTH, PORT_SIZE, PORTS } from "./geometry";
import { KIND_META, nodeSlot, nodeTags, nodeTitle } from "./node-display";
import { LOD_HIDDEN, ZOOM_TEXT_11, ZOOM_TEXT_12, ZOOM_TEXT_TITLE } from "./zoom-text";

const portStyle = (at: { x: number; y: number }, rotate = false): CSSProperties => ({
	left: at.x,
	top: at.y,
	right: "auto",
	bottom: "auto",
	width: PORT_SIZE,
	height: PORT_SIZE,
	transform: `translate(-50%, -50%)${rotate ? " rotate(45deg)" : ""}`,
});

/**
 * 节点卡片（原型 `.n`，以 React Flow UI 的 BaseNode / BaseHandle 为起点）：种类代号、ID、种类名、状态，
 * 标题，底部摘要槽；右上角标签（always、另选的 Agent、重试）。端口常显：左侧链入口，右侧链出口，
 * 异步任务节点底部的调度出口；子流程入口节点左侧接收调度连线。
 * 叠加的运行状态、主指标、差异标记来自 FlowCanvas 的 decorateNode（见 context.ts）。
 */
export function NodeCard({ id, data, selected }: NodeProps<SfNode>) {
	const { info, ports, decorateNode } = useFlowCanvas();
	const { node } = data;
	const meta = KIND_META[node.kind];
	const title = nodeTitle(node, info);
	const warnings = info.warnings.get(id) ?? [];
	const decoration = decorateNode?.(id, node);
	const port = ports.get(id) ?? { in: false, out: false, dispatch: false };
	const tags = nodeTags(node);
	const isStart = node.kind === "entry" || node.kind === "subflow_entry";

	return (
		<BaseNode
			role="button"
			tabIndex={-1}
			aria-label={`${id} · ${title} · ${meta.label}`}
			aria-pressed={selected}
			data-node-id={id}
			data-run={decoration?.run}
			data-mark={decoration?.mark}
			style={{ width: NODE_WIDTH, height: NODE_HEIGHT, borderRadius: NODE_RADIUS }}
			className={cn(
				"flex flex-col px-3 py-2.5",
				"data-[run=running]:border-canvas-run-running data-[run=failed]:border-canvas-run-failed",
				"data-[run=cancelled]:border-dashed data-[run=cancelled]:border-canvas-run-cancelled data-[run=cancelled]:opacity-60",
				"data-[run=done]:opacity-(--canvas-run-done-opacity) data-[run=pending]:opacity-55 data-[run=skipped]:opacity-55",
				"data-[mark=added]:border-ok data-[mark=changed]:border-warn data-[mark=removed]:border-dashed data-[mark=removed]:border-danger data-[mark=removed]:opacity-60",
				"in-[.selected]:opacity-100",
			)}
		>
			{tags.length > 0 && (
				<div className={cn("absolute -top-2.5 right-2.5 flex gap-1", LOD_HIDDEN)}>
					{tags.map((tag) => (
						<span
							key={tag}
							className={cn(
								"h-4.75 rounded-sm border border-border bg-raised-2 px-1.5 font-mono leading-4.25 text-fg-2",
								ZOOM_TEXT_11,
								tag === "always" && "border-warn-line text-warn-fg",
							)}
						>
							{tag}
						</span>
					))}
				</div>
			)}
			<BaseNodeHeader className={cn("text-fg-3", ZOOM_TEXT_11)}>
				<span
					aria-hidden
					className={cn(
						"grid size-4.5 flex-none place-items-center rounded-sm bg-raised-2 font-mono leading-none font-semibold text-fg-2",
						ZOOM_TEXT_11,
						LOD_HIDDEN,
					)}
				>
					{meta.code}
				</span>
				<span className="truncate font-mono text-fg-2">{id}</span>
				<span className={cn("flex-none", LOD_HIDDEN)}>
					{node.kind === "package" ? "" : meta.label}
				</span>
				<span className="ml-auto flex-none">
					{decoration?.status ??
						(warnings.length > 0 ? (
							<StatusPill kind="warn" className={ZOOM_TEXT_11}>
								{warnings.length} 警告
							</StatusPill>
						) : (
							<StatusPill kind="pending" className={ZOOM_TEXT_11}>
								就绪
							</StatusPill>
						))}
				</span>
			</BaseNodeHeader>
			<BaseNodeHeaderTitle className={cn("mt-2 mb-1.75 leading-[1.3]", ZOOM_TEXT_TITLE)}>
				{title}
			</BaseNodeHeaderTitle>
			<div
				className={cn(
					"flex h-6 items-center gap-2 truncate rounded-md bg-sunk px-2 font-mono text-fg-2",
					ZOOM_TEXT_12,
					LOD_HIDDEN,
				)}
			>
				{decoration?.slot ?? <span className="truncate">{nodeSlot(node)}</span>}
			</div>

			{!isStart && (
				<BaseHandle
					type="target"
					position={Position.Left}
					id="chain"
					isConnectableStart={false}
					state={port.in ? "connected" : "idle"}
					style={portStyle(PORTS.in)}
				/>
			)}
			{node.kind === "subflow_entry" && (
				// 子流程入口节点没有链上的入线，左侧端口只接收调度连线。
				<BaseHandle
					type="target"
					position={Position.Left}
					id="dispatch"
					variant="dispatch"
					isConnectableStart={false}
					state={port.in ? "connected" : "idle"}
					style={portStyle(PORTS.in, true)}
				/>
			)}
			<BaseHandle
				type="source"
				position={Position.Right}
				id="chain"
				isConnectableEnd={false}
				state={port.out ? "connected" : "open"}
				title={port.out ? undefined : "链尾：可以从这里拖线追加节点"}
				style={portStyle(PORTS.out)}
			/>
			{node.kind === "async" && (
				<BaseHandle
					type="source"
					position={Position.Bottom}
					id="dispatch"
					variant="dispatch"
					isConnectableEnd={false}
					state={port.dispatch ? "connected" : "idle"}
					style={portStyle(PORTS.dispatch, true)}
				/>
			)}
		</BaseNode>
	);
}

export const nodeTypes = {
	entry: NodeCard,
	subflow_entry: NodeCard,
	async: NodeCard,
	timer: NodeCard,
	sleep: NodeCard,
	package: NodeCard,
};
