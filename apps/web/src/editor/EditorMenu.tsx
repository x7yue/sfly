import { copyProblem, disconnectEdge, disconnectNode, nodeConnections } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { type CanvasMenuTarget, FitViewMenuItem } from "#/components/canvas/CanvasMenu";
import type { DocNode } from "#/components/canvas/flow";
import type { AddRequest } from "./AddNodeMenu";
import { EdgeMenu } from "./EdgeMenu";
import { NodeMenu, type NodeMenuEdit } from "./NodeMenu";
import { type NodeClipboard, NodeCopyItems } from "./node-clipboard";
import { PaneMenu } from "./PaneMenu";

/** 编辑模式下修改场景的操作（运行状态模式下不给）。 */
export interface EditorMenuActions {
	/** 当前的场景文档（节点有几条入线、出线；断开连线作用的文档）。 */
	doc: OrchestrationDocument;
	canUndo: boolean;
	canRedo: boolean;
	openAddMenu(request: AddRequest): void;
	/** 把文档操作的结果写回画布（一步撤销）。 */
	applyEdit(next: Pick<OrchestrationDocument, "nodes" | "edges">): void;
	deleteNode(id: string): void;
	clipboard: NodeClipboard;
	tidy(): void;
	undo(): void;
	redo(): void;
}

/**
 * 编排画布的右键菜单内容（FlowCanvas 的 `menu`），按右键的对象分：连线（EdgeMenu）、节点（NodeMenu）、
 * 空白处（PaneMenu）。运行状态模式（不给 `edit`）下节点菜单只有只读项，空白处只有「适配视图」，连线没有菜单。
 */
export function EditorMenu({
	target,
	outputsOf,
	edit,
}: {
	target: CanvasMenuTarget;
	/** 节点类型声明的输出键（节点菜单「复制输出引用」）；不知道节点类型时为 undefined。 */
	outputsOf(node: DocNode): readonly string[] | undefined;
	edit: EditorMenuActions | undefined;
}) {
	if (target.kind === "node") {
		return (
			<NodeMenu
				node={target.node}
				outputs={outputsOf(target.node)}
				edit={edit && nodeMenuEdit(edit, target.id, target.node)}
			/>
		);
	}
	if (!edit) return target.kind === "pane" ? <FitViewMenuItem /> : null;
	if (target.kind === "edge") {
		return (
			<EdgeMenu
				edge={target.edge}
				onInsert={() =>
					edit.openAddMenu({
						kind: "after",
						after: target.edge.from,
						before: target.edge.to,
						client: target.client,
					})
				}
				onDisconnect={() => edit.applyEdit(disconnectEdge(edit.doc, target.edge))}
			/>
		);
	}
	return (
		<PaneMenu
			canUndo={edit.canUndo}
			canRedo={edit.canRedo}
			onAdd={() =>
				edit.openAddMenu({ kind: "free", client: target.client, position: target.position })
			}
			onPaste={(copied) => edit.clipboard.paste(copied, target.position)}
			onTidy={edit.tidy}
			onUndo={edit.undo}
			onRedo={edit.redo}
		/>
	);
}

/** 节点菜单里修改场景的项；入口节点和子流程入口节点没有「创建副本」「复制」。 */
function nodeMenuEdit(edit: EditorMenuActions, id: string, node: DocNode): NodeMenuEdit {
	const connections = nodeConnections(edit.doc, id);
	return {
		connections: { in: connections.in.length, out: connections.out.length },
		onAddAfter: () => edit.openAddMenu({ kind: "after", after: id }),
		clipboardItems: copyProblem(node) ? undefined : (
			<NodeCopyItems
				onDuplicate={() => edit.clipboard.duplicate(id)}
				onCopy={() => edit.clipboard.copy(id)}
			/>
		),
		onDisconnect: (side) => edit.applyEdit(disconnectNode(edit.doc, id, side)),
		onDelete: () => edit.deleteNode(id),
	};
}
