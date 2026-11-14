import { nodeCardText } from "@sfly/orchestration";
import { type NodeProps, Position } from "@xyflow/react";
import { cn } from "cn";
import { type CSSProperties, useId } from "react";
import { BaseHandle } from "@/components/ui/base-handle";
import { BaseNode, BaseNodeHeader, BaseNodeHeaderTitle } from "@/components/ui/base-node";
import { useFlowCanvas } from "./context";
import type { SfNode } from "./flow";
import { NODE_HEIGHT, NODE_RADIUS, NODE_WIDTH, PORT_SIZE, PORTS } from "./geometry";
import { KIND_META, nodeSlot, nodeTags } from "./node-display";
import { WarningBadge } from "./WarningBadge";
import { KIND_CHIP, LOD_HIDDEN, ZOOM_TEXT_11, ZOOM_TEXT_12, ZOOM_TEXT_TITLE } from "./zoom-text";

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
 * 节点卡片（原型 `.n`，以 React Flow UI 的 BaseNode / BaseHandle 为起点）：种类图标、ID、种类名（标题没说明种类时）、状态，
 * 标题，底部摘要槽；右上角标签（always、另选的 Agent、重试）。端口常显：左侧链入口，右侧链出口，
 * 异步任务节点底部的调度出口；子流程入口节点左侧接收调度连线。
 * 叠加的运行状态、主指标、差异标记来自 FlowCanvas 的 decorateNode（见 context.ts）。
 */
export function NodeCard({ id, data, selected }: NodeProps<SfNode>) {
	const { info, ports, decorateNode } = useFlowCanvas();
	const { node } = data;
	const meta = KIND_META[node.kind];
	const { title, caption } = nodeCardText(node, info);
	const warnings = info.warnings.get(id) ?? [];
	const decoration = decorateNode?.(id, node);
	const port = ports.get(id) ?? { in: false, out: false, dispatch: false };
	const tags = nodeTags(node);
	const slot = nodeSlot(node);
	const KindIcon = meta.icon;
	const isStart = node.kind === "entry" || node.kind === "subflow_entry";
	const cardId = useId();
	const statusId = useId();

	return (
		<BaseNode
			role="button"
			tabIndex={-1}
			// 名称：「节点 ID，种类，标题」（aria-label，由自己的 id 引用）接上右上角的状态（运行状态、警告、差异标记）。
			id={cardId}
			aria-label={[`节点 ${id}`, caption, title !== id && title].filter(Boolean).join("，")}
			aria-labelledby={`${cardId} ${statusId}`}
			aria-pressed={selected}
			data-node-id={id}
			data-run={decoration?.run}
			data-mark={decoration?.mark}
			style={{ width: NODE_WIDTH, height: NODE_HEIGHT, borderRadius: NODE_RADIUS }}
			className={cn(
				"flex flex-col px-3 py-2.5",
				"focus-visible:outline-offset-3",
				"data-[run=running]:border-canvas-run-running data-[run=failed]:border-canvas-run-failed",
				// 退后的状态（待执行、已跳过、已取消、已停止、已删除）不用不透明度，标题换成次要文字色：
				// 文字对比度不降（DESIGN-SYSTEM §2.2），状态由描边与状态徽标区分。
				"data-[run=cancelled]:border-dashed data-[run=cancelled]:border-canvas-run-cancelled data-[run=cancelled]:text-fg-2",
				"data-[run=done]:border-canvas-run-done-border data-[run=done]:bg-canvas-run-done-bg",
				"data-[run=pending]:text-fg-2",
				"data-[run=skipped]:border-canvas-run-done-border data-[run=skipped]:bg-canvas-run-done-bg data-[run=skipped]:text-fg-2",
				"data-[run=stopped]:border-canvas-run-stopped data-[run=stopped]:text-fg-2",
				"data-[mark=added]:border-ok data-[mark=changed]:border-warn",
				"data-[mark=removed]:border-dashed data-[mark=removed]:border-danger data-[mark=removed]:text-fg-2 data-[mark=removed]:[&_[data-slot=base-node-title]]:line-through",
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
							)}
						>
							{tag}
						</span>
					))}
				</div>
			)}
			{/* 头部与标题重复了名称，读屏不再读一遍；右上角的状态隐藏了照样进名称（被 aria-labelledby 直接引用）。 */}
			<BaseNodeHeader aria-hidden className={cn("text-fg-3", ZOOM_TEXT_12)}>
				<span aria-hidden title={meta.label} className={KIND_CHIP}>
					<KindIcon />
				</span>
				<span className="truncate font-mono text-fg-2">{id}</span>
				{caption && <span className={cn("flex-none", LOD_HIDDEN)}>{caption}</span>}
				<span id={statusId} className="ml-auto flex-none">
					{decoration?.status ??
						(warnings.length > 0 && <WarningBadge warnings={warnings} className={ZOOM_TEXT_12} />)}
				</span>
			</BaseNodeHeader>
			{/* 行高 1.6：中文回退字体（Noto Sans CJK 等）的字形高约 1.45em、下划线更低，标题是 truncate（溢出隐藏），
			    行高再小时缩小视图后字形底部会被裁掉。 */}
			<BaseNodeHeaderTitle
				aria-hidden
				className={cn("mt-1.5 mb-1.25 leading-[1.6]", ZOOM_TEXT_TITLE)}
			>
				{title}
			</BaseNodeHeaderTitle>
			<div
				data-empty={(!decoration?.slot && slot.empty) || undefined}
				className={cn(
					"flex h-6 items-center gap-2 truncate rounded-md bg-sunk px-2 font-mono text-fg-2",
					// 还没有配置的摘要（没有参数、没有映射）用辅助文字、非等宽，不像一个配置值。
					"data-empty:font-sans data-empty:text-fg-3",
					ZOOM_TEXT_12,
					LOD_HIDDEN,
				)}
			>
				{decoration?.slot ?? <span className="truncate">{slot.text}</span>}
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
			{/* 出口可以作为连线的终点：改接连线的起点时拖到这里（#185）。普通拖线从出口出发、只能连到入口。 */}
			<BaseHandle
				type="source"
				position={Position.Right}
				id="chain"
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
					state={port.dispatch ? "connected" : "idle"}
					style={portStyle(PORTS.dispatch, true)}
				/>
			)}
		</BaseNode>
	);
}

/** 每种节点都用节点卡片画；Record 的类型让新增的节点种类漏注册时类型检查报错。 */
export const nodeTypes: Record<SfNode["data"]["node"]["kind"], typeof NodeCard> = {
	entry: NodeCard,
	subflow_entry: NodeCard,
	async: NodeCard,
	timer: NodeCard,
	sleep: NodeCard,
	stop_subflow: NodeCard,
	feishu_notify: NodeCard,
	package: NodeCard,
};
