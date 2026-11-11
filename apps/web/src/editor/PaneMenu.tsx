import { FitViewMenuItem } from "#/components/canvas/CanvasMenu";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";

/** 编辑模式下画布空白处的右键菜单。快捷键文字来自注册表（ContextMenuItem 的 shortcut）。 */
export function PaneMenu({
	canUndo,
	canRedo,
	onAdd,
	onTidy,
	onUndo,
	onRedo,
}: {
	canUndo: boolean;
	canRedo: boolean;
	onAdd(): void;
	onTidy(): void;
	onUndo(): void;
	onRedo(): void;
}) {
	return (
		<>
			<ContextMenuItem shortcut="canvas-add" onClick={onAdd}>
				添加节点
			</ContextMenuItem>
			{/* 粘贴节点在 #186 实现，这里先占位。 */}
			<ContextMenuItem disabledReason="没有可粘贴的节点">粘贴</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem shortcut="canvas-tidy" onClick={onTidy} />
			<FitViewMenuItem />
			<ContextMenuSeparator />
			<ContextMenuItem
				shortcut="canvas-undo"
				disabledReason={canUndo ? null : "没有可撤销的修改"}
				onClick={onUndo}
			/>
			<ContextMenuItem
				shortcut="canvas-redo"
				disabledReason={canRedo ? null : "没有可重做的修改"}
				onClick={onRedo}
			/>
		</>
	);
}
