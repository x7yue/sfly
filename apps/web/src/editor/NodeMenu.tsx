import { referenceText } from "@sfly/orchestration";
import type { ReactNode } from "react";
import type { DocNode } from "#/components/canvas/flow";
import { writeClipboard } from "#/components/feedback/clipboard";
import { notify } from "#/components/feedback/notify";
import {
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

const copy = (text: string, done: string) =>
	writeClipboard(text, () => notify.success(done, { description: text }));

/** 修改场景的操作；运行状态模式下不给（菜单只剩只读项）。 */
export interface NodeMenuEdit {
	/** 入线、出线各有几条（@sfly/orchestration 的 nodeConnections）。 */
	connections: { in: number; out: number };
	onAddAfter(): void;
	/** 原地改显示名称（卡片标题变成输入框）。 */
	onRename(): void;
	/** 不能改显示名称的原因（子流程入口节点）；可以改时为 null。 */
	renameProblem: string | null;
	onDisconnect(side: "in" | "out"): void;
	onDelete(): void;
	/**
	 * 「在后面添加节点」之后、分隔线之前的项：节点的「创建副本」「复制」（#186）放在这里，
	 * 入口节点和子流程入口节点不给。
	 */
	clipboardItems?: ReactNode;
}

/**
 * 节点的右键菜单（鼠标右键，或焦点在节点上按 Shift+F10 / 菜单键）。顺序：在后面添加节点、
 * （创建副本、复制）、重命名、复制节点 ID、复制输出引用、断开入线、断开出线、删除。
 * 入口节点没有「删除」；做不了的项禁用并写明原因。快捷键文字来自注册表。
 */
export function NodeMenu({
	node,
	outputs,
	edit,
}: {
	node: DocNode;
	/** 节点类型声明的输出键；不知道节点类型时为 undefined。 */
	outputs: readonly string[] | undefined;
	edit?: NodeMenuEdit;
}) {
	const keys = outputs ?? [];
	return (
		<>
			{edit && (
				<>
					<ContextMenuItem shortcut="canvas-add-tab" onClick={edit.onAddAfter}>
						在后面添加节点
					</ContextMenuItem>
					{edit.clipboardItems}
					<ContextMenuItem
						shortcut="canvas-rename"
						disabledReason={edit.renameProblem}
						onClick={edit.onRename}
					>
						重命名
					</ContextMenuItem>
					<ContextMenuSeparator />
				</>
			)}
			<ContextMenuItem onClick={() => copy(node.id, "已复制节点 ID")}>复制节点 ID</ContextMenuItem>
			<ContextMenuSub>
				<ContextMenuSubTrigger disabledReason={keys.length > 0 ? null : "这个节点没有声明输出"}>
					复制输出引用
				</ContextMenuSubTrigger>
				<ContextMenuSubContent aria-label="复制输出引用">
					{keys.map((key) => (
						<ContextMenuItem
							key={key}
							className="font-mono"
							onClick={() =>
								copy(referenceText(`nodes.${node.id}.outputs.${key}`), "已复制输出引用")
							}
						>
							{key}
						</ContextMenuItem>
					))}
				</ContextMenuSubContent>
			</ContextMenuSub>
			{edit && (
				<>
					<ContextMenuSeparator />
					<ContextMenuItem
						disabledReason={edit.connections.in > 0 ? null : "这个节点没有入线"}
						onClick={() => edit.onDisconnect("in")}
					>
						断开入线
					</ContextMenuItem>
					<ContextMenuItem
						disabledReason={edit.connections.out > 0 ? null : "这个节点没有出线"}
						onClick={() => edit.onDisconnect("out")}
					>
						断开出线
					</ContextMenuItem>
					{node.kind !== "entry" && (
						<>
							<ContextMenuSeparator />
							<ContextMenuItem shortcut="canvas-delete" variant="danger" onClick={edit.onDelete}>
								删除节点
							</ContextMenuItem>
						</>
					)}
				</>
			)}
		</>
	);
}
