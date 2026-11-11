import { ContextMenuItem } from "@/components/ui/context-menu";
import { useFlowCanvas } from "./context";

/**
 * 画布右键菜单（FlowCanvas 的 `menu`）：画布负责在右键时打开菜单并让右键的对象拿到焦点，
 * 使用方按对象给出菜单内容（ui/context-menu 的 `ContextMenuItem` 等）。
 */

/** 右键的对象。`client` 是屏幕坐标（菜单出现在这里）。 */
export type CanvasMenuTarget = {
	kind: "pane";
	client: { x: number; y: number };
	/** 右键处的画布坐标（在这里添加、粘贴节点）。 */
	position: { x: number; y: number };
};

/** 「适配视图」：任何画布菜单里都可以放，只读画布的空白处菜单只有它。 */
export function FitViewMenuItem() {
	const { fit } = useFlowCanvas();
	return <ContextMenuItem shortcut="canvas-fit" onClick={fit} />;
}
