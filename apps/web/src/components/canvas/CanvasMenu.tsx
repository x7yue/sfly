import type { Position } from "@sfly/orchestration";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useFlowCanvas } from "./context";
import type { DocEdge, DocNode } from "./flow";

/**
 * 画布右键菜单（FlowCanvas 的 `menu`）：画布负责在右键时打开菜单并让右键的对象拿到焦点，
 * 使用方按对象给出菜单内容（ui/context-menu 的 `ContextMenuItem` 等）。
 */

/** 右键的对象。`client` 是屏幕坐标（菜单出现在这里）。 */
export type CanvasMenuTarget =
	| {
			kind: "pane";
			client: Position;
			/** 右键处的画布坐标（在这里添加、粘贴节点）。 */
			position: Position;
	  }
	| {
			kind: "node";
			id: string;
			/** 打开菜单时的节点内容（节点被菜单里的操作删除后，退场动画期间菜单内容不变）。 */
			node: DocNode;
			/** 菜单出现的位置：鼠标右键处的屏幕坐标；键盘（Shift+F10 / 菜单键）打开时是节点卡片。 */
			anchor: Position | Element;
	  }
	| {
			kind: "edge";
			edge: DocEdge;
			/** 右键处（或连线中点「＋」上右键处）的屏幕坐标。 */
			client: Position;
	  };

/** 菜单贴着哪里出现。 */
export const menuAnchor = (target: CanvasMenuTarget) =>
	target.kind === "node" ? target.anchor : target.client;

/** 「适配视图」：任何画布菜单里都可以放，只读画布的空白处菜单只有它。 */
export function FitViewMenuItem() {
	const { fit } = useFlowCanvas();
	return <ContextMenuItem shortcut="canvas-fit" onClick={fit} />;
}
