import type { CopiedNode } from "@sfly/orchestration";
import { FitViewMenuItem } from "#/components/canvas/CanvasMenu";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { PasteMenuItem } from "./node-clipboard";

/** 编辑模式下画布空白处的右键菜单。快捷键文字来自注册表（ContextMenuItem 的 shortcut）。 */
export function PaneMenu({
	canUndo,
	canRedo,
	onAdd,
	onPaste,
	onTidy,
	onUndo,
	onRedo,
}: {
	canUndo: boolean;
	canRedo: boolean;
	onAdd(): void;
	/** 粘贴剪贴板里的节点（落在右键的位置）。 */
	onPaste(copied: CopiedNode): void;
	onTidy(): void;
	onUndo(): void;
	onRedo(): void;
}) {
	return (
		<>
			<ContextMenuItem shortcut="canvas-add" onClick={onAdd}>
				添加节点
			</ContextMenuItem>
			<PasteMenuItem onPaste={onPaste} />
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
