import { stickyHeadline, stickyNoteSize } from "@sfly/orchestration";
import {
	STICKY_NOTE_MAX_SIDE,
	STICKY_NOTE_MIN_SIZE,
	type StickyNote,
	stickyNoteColor,
} from "@sfly/schema";
import { useStoreApi, ViewportPortal } from "@xyflow/react";
import { cn } from "cn";
import { NotepadTextIcon } from "lucide-react";
import { type PointerEvent, useRef } from "react";
import { TERM } from "#/lib/copy";
import { StickyToolbar } from "./CanvasToolbar";
import type { StickyEdit } from "./context";
import { stickyBlocks } from "./sticky-text";
import { ZOOM_TEXT_STICKY, ZOOM_TEXT_STICKY_BODY, ZOOM_TEXT_STICKY_LOD } from "./zoom-text";

/** 指针移动超过这么多屏幕像素才算拖动：之下是点击。 */
const DRAG_THRESHOLD = 3;

/** 放好位置的便签（画布打开时已经补齐了没写位置的）。 */
export type PlacedStickyNote = StickyNote & { position: { x: number; y: number } };

/**
 * 画布上的便签（GLOSSARY「便签」，ADR 0026）：一整块注释框色板里的颜色（不写是黄色），左上角是便签图标和加粗的标题，
 * 下面是正文（`- ` 开头的行显示成列表，sticky-text.ts）。缩小视图时只留一行：标题，没有标题时是正文的第一行。
 * 画在子流程区域上面、节点下面。
 *
 * 给了 `edit` 时（可编辑的画布）：按住拖动移动，选中后拖右下角的手柄改大小，双击打开检查器改文字，
 * 选中时左上方浮出工具条（颜色、删除）。只读的画布只画出来。
 */
export function StickyNotes({
	notes,
	selected,
	edit,
	toolbar = true,
}: {
	notes: readonly PlacedStickyNote[];
	selected: string | null;
	edit?: StickyEdit | undefined;
	/** 选中时显示工具条（拖动的过程中不显示）。 */
	toolbar?: boolean;
}) {
	return (
		<ViewportPortal>
			{notes.map((note) => (
				<Sticky
					key={note.id}
					note={note}
					selected={selected === note.id}
					edit={edit}
					toolbar={toolbar}
				/>
			))}
		</ViewportPortal>
	);
}

interface Gesture {
	pointerId: number;
	x: number;
	y: number;
	zoom: number;
	moved: boolean;
	/** 按下时的位置或大小：之后按总位移从这里算。 */
	start: { a: number; b: number };
	kind: "move" | "resize";
}

function Sticky({
	note,
	selected,
	edit,
	toolbar,
}: {
	note: PlacedStickyNote;
	selected: boolean;
	edit: StickyEdit | undefined;
	toolbar: boolean;
}) {
	const store = useStoreApi();
	const gesture = useRef<Gesture | null>(null);
	const afterDrag = useRef(false);
	const size = stickyNoteSize(note);
	const blocks = stickyBlocks(note.text);
	const title = note.title?.trim();

	const begin = (event: PointerEvent<HTMLElement>, kind: Gesture["kind"]) => {
		afterDrag.current = false;
		if (!edit || event.button !== 0 || !event.isPrimary) return;
		event.stopPropagation();
		gesture.current = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			zoom: store.getState().transform[2],
			moved: false,
			start:
				kind === "move"
					? { a: note.position.x, b: note.position.y }
					: { a: size.width, b: size.height },
			kind,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const report = (g: Gesture, event: PointerEvent, dragging: boolean) => {
		const dx = (event.clientX - g.x) / g.zoom;
		const dy = (event.clientY - g.y) / g.zoom;
		if (g.kind === "move") {
			edit?.move(note.id, { x: g.start.a + dx, y: g.start.b + dy }, dragging);
		} else {
			edit?.resize(
				note.id,
				{
					// 夹在场景文档允许的范围里：缩小视图时拖一点就是很多画布单位，拖过上限就保存不了。
					width: Math.min(
						STICKY_NOTE_MAX_SIDE,
						Math.max(STICKY_NOTE_MIN_SIZE.width, g.start.a + dx),
					),
					height: Math.min(
						STICKY_NOTE_MAX_SIDE,
						Math.max(STICKY_NOTE_MIN_SIZE.height, g.start.b + dy),
					),
				},
				dragging,
			);
		}
	};
	const handlers = edit && {
		onPointerMove(event: PointerEvent) {
			const g = gesture.current;
			if (!g || g.pointerId !== event.pointerId) return;
			if (!g.moved && Math.hypot(event.clientX - g.x, event.clientY - g.y) < DRAG_THRESHOLD) return;
			g.moved = true;
			report(g, event, true);
		},
		onPointerUp(event: PointerEvent) {
			const g = gesture.current;
			if (!g || g.pointerId !== event.pointerId) return;
			gesture.current = null;
			if (!g.moved) return;
			afterDrag.current = true;
			report(g, event, false);
		},
		onPointerCancel() {
			gesture.current = null;
		},
	};

	return (
		<div
			data-sticky-note={note.id}
			data-annotation-color={stickyNoteColor(note)}
			data-selected={selected || undefined}
			className="absolute -z-[5]"
			style={{
				left: note.position.x,
				top: note.position.y,
				width: size.width,
				height: size.height,
			}}
		>
			{toolbar && selected && edit && (
				<div className="absolute bottom-[calc(100%+8px)] left-0">
					<StickyToolbar note={note} edit={edit} />
				</div>
			)}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: 点击、双击是鼠标的选中和打开；键盘从大纲选中便签，在检查器里改 */}
			<div
				role="note"
				aria-label={`${TERM.stickyNote} ${title ?? stickyHeadline(note)}`}
				className={cn(
					"pointer-events-auto absolute inset-0 flex flex-col overflow-hidden rounded-xl border border-canvas-sticky-line bg-canvas-sticky px-4 pt-3 pb-3.5 text-canvas-sticky-fg",
					"data-selected:border-canvas-node-selected data-selected:shadow-[0_0_0_4px_var(--canvas-node-selected-ring)]",
					"in-data-[lod=true]:pt-2",
					edit && "nopan cursor-grab active:cursor-grabbing",
				)}
				data-selected={selected || undefined}
				onPointerDown={(e) => begin(e, "move")}
				onClickCapture={(e) => {
					if (afterDrag.current) {
						afterDrag.current = false;
						e.stopPropagation();
					}
				}}
				onClick={() => edit?.select(note.id)}
				onDoubleClick={() => edit?.open(note.id)}
				{...handlers}
			>
				<p
					className={cn(
						"m-0 flex items-center gap-[0.45em] leading-[1.45] font-semibold",
						title ? ZOOM_TEXT_STICKY : "hidden in-data-[lod=true]:flex",
						ZOOM_TEXT_STICKY_LOD,
					)}
				>
					<NotepadTextIcon
						aria-hidden
						className="size-[1.05em] flex-none text-canvas-annotation-swatch"
					/>
					<span className="min-w-0 truncate">{title ?? stickyHeadline(note)}</span>
				</p>
				<div
					className={cn(
						// 便签的大小是固定的，放不下的正文在底边渐隐：看得出后面还有，拉大便签或在检查器里看全文。
						"mt-[0.5em] flex min-h-0 flex-1 flex-col gap-[0.55em] overflow-hidden leading-[1.6] wrap-anywhere text-canvas-sticky-fg-2 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.6em),transparent)] in-data-[lod=true]:hidden",
						!title && "mt-0",
						ZOOM_TEXT_STICKY_BODY,
					)}
				>
					{blocks.map((block, i) =>
						block.kind === "list" ? (
							// biome-ignore lint/suspicious/noArrayIndexKey: 正文按顺序切出来的段，没有别的标识
							<ul key={i} className="m-0 list-disc pl-[1.1em] marker:text-canvas-annotation-swatch">
								{block.items.map((item, j) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: 同上
									<li key={j}>{item}</li>
								))}
							</ul>
						) : (
							// biome-ignore lint/suspicious/noArrayIndexKey: 同上
							<p key={i} className="m-0 whitespace-pre-line">
								{block.text}
							</p>
						),
					)}
				</div>
			</div>
			{selected && edit && (
				// 拖动改大小的手柄（对读屏隐藏）：键盘不改便签大小。
				<div
					aria-hidden
					data-sticky-resize=""
					className="nopan pointer-events-auto absolute right-0 bottom-0 size-4 cursor-nwse-resize"
					onPointerDown={(e) => begin(e, "resize")}
					{...handlers}
				>
					<span className="absolute right-1 bottom-1 size-2 border-r-2 border-b-2 border-canvas-node-selected" />
				</div>
			)}
		</div>
	);
}
