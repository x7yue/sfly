import type { DocEdge } from "#/components/canvas/flow";
import { ContextMenuItem } from "@/components/ui/context-menu";

/**
 * 连线的右键菜单（编辑模式；运行状态模式下连线没有菜单）：链上的连线有「在此插入节点」「断开连线」，
 * 调度连线中间不能插节点，只有「断开连线」。点选连线后按 Delete 同样是断开（快捷键文字来自注册表）。
 */
export function EdgeMenu({
	edge,
	onInsert,
	onDisconnect,
}: {
	edge: DocEdge;
	onInsert(): void;
	onDisconnect(): void;
}) {
	return (
		<>
			{edge.kind === "chain" && <ContextMenuItem onClick={onInsert}>在此插入节点</ContextMenuItem>}
			<ContextMenuItem shortcut="canvas-delete" onClick={onDisconnect}>
				断开连线
			</ContextMenuItem>
		</>
	);
}
