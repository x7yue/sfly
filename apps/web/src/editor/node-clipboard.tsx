import {
	type CopiedNode,
	copiedNodeText,
	type DocumentEdit,
	duplicateNode,
	type Position,
	placeCopy,
	readCopiedNode,
} from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { useEffect, useRef } from "react";
import { writeClipboard } from "#/components/feedback/clipboard";
import { notify } from "#/components/feedback/notify";
import { useShortcut } from "#/components/shortcuts";
import { isEditable, OPEN_DIALOG } from "#/lib/focus";
import { shortcutText } from "#/lib/shortcuts";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { type Box, freeCardSpot, freeSpot } from "./free-spot";

/**
 * 画布上单个节点的复制、粘贴、创建副本（#186）与系统剪贴板之间的接线。剪贴板里的内容与
 * 文档操作是 @sfly/orchestration 的 node-clipboard（纯逻辑）；这里只管浏览器。编辑器用 useNodeClipboard。
 *
 * - Ctrl+C / Ctrl+V 不拦按键，用浏览器的 copy / paste 事件：焦点在输入框里、页面上选中了文字、
 *   剪贴板里不是节点时都照常是文本操作。事件里读写剪贴板不需要浏览器授权。
 * - 菜单里的「复制」「粘贴」不是按键触发的，只能用 Clipboard API（需要浏览器允许读写剪贴板，
 *   http 访问时没有）。「粘贴」点了才读剪贴板，不在打开菜单时读。
 */

/** 有弹窗或菜单打开时不处理复制、粘贴。 */
const OPEN_OVERLAY = `${OPEN_DIALOG}, [role="menu"][data-open]`;

/** 现在这次复制、粘贴该不该交给画布：焦点不在输入框里，也没有弹窗、菜单打开着。 */
const forCanvas = (event: ClipboardEvent) =>
	!event.defaultPrevented &&
	!isEditable(document.activeElement) &&
	document.querySelector(OPEN_OVERLAY) === null;

/** 鼠标所在的屏幕坐标在不在画布上（小地图和悬浮在画布上的控件、检查器不算）。 */
function onCanvas(point: Position): boolean {
	const el = document.elementFromPoint(point.x, point.y);
	return el?.closest(".react-flow") != null && el.closest(".react-flow__panel") == null;
}

/**
 * 在页面上接上 Ctrl+C / Ctrl+V：`copy()` 返回要写进剪贴板的文字（没有可复制的节点时返回 null，
 * 交给浏览器照常复制）；剪贴板里是节点时调用 `paste`，`client` 是鼠标所在的屏幕坐标，
 * 鼠标不在画布上时不给。`enabled` 为 false 时（运行状态模式）都不处理。
 */
function useClipboardShortcuts(handlers: {
	enabled: boolean;
	copy(): string | null;
	paste(copied: CopiedNode, client?: Position): void;
}) {
	const latest = useRef(handlers);
	latest.current = handlers;
	useEffect(() => {
		let pointer: Position | null = null;
		const onMove = (event: PointerEvent) => {
			pointer = { x: event.clientX, y: event.clientY };
		};
		const onLeave = () => {
			pointer = null;
		};
		const onCopy = (event: ClipboardEvent) => {
			if (!latest.current.enabled || !forCanvas(event)) return;
			// 页面上选中了文字：照常复制文字。
			if (document.getSelection()?.isCollapsed === false) return;
			const text = latest.current.copy();
			if (text === null || !event.clipboardData) return;
			event.clipboardData.setData("text/plain", text);
			event.preventDefault();
		};
		const onPaste = (event: ClipboardEvent) => {
			if (!latest.current.enabled || !forCanvas(event)) return;
			const copied = readCopiedNode(event.clipboardData?.getData("text/plain") ?? "");
			if (!copied) return;
			event.preventDefault();
			latest.current.paste(copied, pointer && onCanvas(pointer) ? pointer : undefined);
		};
		document.addEventListener("pointermove", onMove);
		document.documentElement.addEventListener("pointerleave", onLeave);
		document.addEventListener("copy", onCopy);
		document.addEventListener("paste", onPaste);
		return () => {
			document.removeEventListener("pointermove", onMove);
			document.documentElement.removeEventListener("pointerleave", onLeave);
			document.removeEventListener("copy", onCopy);
			document.removeEventListener("paste", onPaste);
		};
	}, []);
}

/** 编辑器里的复制、粘贴、创建副本（节点菜单、空白处菜单用；快捷键由 useNodeClipboard 自己接上）。 */
export interface NodeClipboard {
	/** 创建副本：从原节点的位置往右下错开，直到不压住已有节点。 */
	duplicate(id: string): void;
	/** 节点菜单的「复制」：用 Clipboard API 写入（不是按键触发的复制，没有 copy 事件可用）。 */
	copy(id: string): void;
	/** 粘贴：卡片中心落在 `at`（画布坐标，右键处或鼠标处），没给时落在视口中心；压住已有节点时错开。 */
	paste(copied: CopiedNode, at?: Position): void;
}

/**
 * 编辑器的复制、粘贴、创建副本：Ctrl+C 复制、Ctrl+V 粘贴、Ctrl+D 创建副本作用于选中的节点，
 * 返回菜单里用的同样三个操作。新节点有新的 ID、不带连线；成功时交给 `onPlace` 写回画布（各是一步撤销），
 * 不能复制、粘贴时提示原因。`enabled` 为 false 时（运行状态模式）快捷键都不处理。
 */
export function useNodeClipboard({
	enabled,
	doc,
	nodes,
	regions,
	selectedId,
	viewportCenter,
	toFlowPosition,
	onPlace,
}: {
	enabled: boolean;
	doc: OrchestrationDocument;
	/** 画布上的节点：新节点避开它们；选中的节点还在不在。 */
	nodes: readonly { id: string; position: Position }[];
	regions: readonly Box[];
	selectedId: string | null;
	/** 视口中心（画布坐标）：粘贴时没有位置就放在这里。 */
	viewportCenter(): Position;
	/** 屏幕坐标换成画布坐标。 */
	toFlowPosition(client: Position): Position;
	onPlace(edit: { doc: OrchestrationDocument; id: string }): void;
}): NodeClipboard {
	const place = (edit: DocumentEdit<OrchestrationDocument, { id: string }>) => {
		if (edit.ok) onPlace(edit);
		else notify.warning(edit.reason);
	};
	const positions = () => nodes.map((n) => n.position);
	/** 复制节点要写进剪贴板的文字；不能复制时提示原因、返回 null。 */
	const textOf = (id: string): string | null => {
		const copied = copiedNodeText(doc, id);
		if (!copied.ok) {
			notify.warning(copied.reason);
			return null;
		}
		return copied.text;
	};
	const copiedNotice = (id: string) =>
		notify.success(`已复制节点 ${id}`, {
			description: `可以在任意场景的画布上粘贴（${shortcutText("canvas-paste")}）`,
		});
	const clipboard: NodeClipboard = {
		duplicate(id) {
			const origin = nodes.find((n) => n.id === id)?.position ?? { x: 0, y: 0 };
			const wanted = { x: Math.round(origin.x), y: Math.round(origin.y) };
			place(duplicateNode(doc, id, freeSpot(wanted, positions(), regions)));
		},
		copy(id) {
			const text = textOf(id);
			if (text === null) return;
			writeClipboard(text, () => copiedNotice(id), `可以按 ${shortcutText("canvas-copy")} 复制`);
		},
		paste(copied, at) {
			place(placeCopy(doc, copied, freeCardSpot(at ?? viewportCenter(), positions(), regions)));
		},
	};

	/** 选中的、还在画布上的节点（Ctrl+C、Ctrl+D 作用的节点）。 */
	const selectedOnCanvas = () =>
		selectedId && nodes.some((n) => n.id === selectedId) ? selectedId : null;
	useClipboardShortcuts({
		enabled,
		copy: () => {
			const id = selectedOnCanvas();
			const text = id ? textOf(id) : null;
			if (id && text !== null) copiedNotice(id);
			return text;
		},
		paste: (copied, client) => clipboard.paste(copied, client && toFlowPosition(client)),
	});
	useShortcut(
		"canvas-duplicate",
		() => {
			const id = selectedOnCanvas();
			if (id) clipboard.duplicate(id);
		},
		enabled,
	);
	return clipboard;
}

/** 「粘贴」用不了 Clipboard API 时的说明：按键粘贴走浏览器的 paste 事件，不需要授权。 */
const PASTE_WITH_KEYS = `请按 ${shortcutText("canvas-paste")} 粘贴`;

/** 浏览器有没有读剪贴板的 Clipboard API（http 访问等非安全上下文里没有）。 */
const canReadClipboard = () => typeof navigator.clipboard?.readText === "function";

/** 点了「粘贴」：这时才读剪贴板，里面是节点就粘贴，否则提示原因。 */
async function pasteFromClipboard(onPaste: (copied: CopiedNode) => void) {
	let text: string;
	try {
		text = await navigator.clipboard.readText();
	} catch {
		notify.warning("浏览器不允许读取剪贴板", { description: PASTE_WITH_KEYS });
		return;
	}
	const copied = readCopiedNode(text);
	if (copied) onPaste(copied);
	else notify.warning("剪贴板里没有可粘贴的节点");
}

/**
 * 空白处菜单的「粘贴」。打开菜单时不读剪贴板（浏览器可能每次读都要用户授权）：点了它才读，
 * 剪贴板里不是节点、或浏览器不允许读取时提示原因。浏览器没有 Clipboard API（http 访问）时禁用，
 * 写明可以按快捷键粘贴。
 */
export function PasteMenuItem({ onPaste }: { onPaste(copied: CopiedNode): void }) {
	return (
		<ContextMenuItem
			shortcut="canvas-paste"
			disabledReason={canReadClipboard() ? null : `浏览器不允许读取剪贴板，${PASTE_WITH_KEYS}`}
			onClick={() => void pasteFromClipboard(onPaste)}
		>
			粘贴
		</ContextMenuItem>
	);
}

/** 节点菜单的「创建副本」「复制」（NodeMenu 的 clipboardItems；入口节点和子流程入口节点不给）。 */
export function NodeCopyItems({ onDuplicate, onCopy }: { onDuplicate(): void; onCopy(): void }) {
	return (
		<>
			<ContextMenuItem shortcut="canvas-duplicate" onClick={onDuplicate}>
				创建副本
			</ContextMenuItem>
			<ContextMenuItem shortcut="canvas-copy" onClick={onCopy}>
				复制
			</ContextMenuItem>
		</>
	);
}
