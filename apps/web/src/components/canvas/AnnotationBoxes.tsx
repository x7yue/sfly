import {
	ANNOTATION_NOTE,
	ANNOTATION_PADDING,
	type AnnotationBox,
	type LayoutDocument,
} from "@sfly/orchestration";
import { type Annotation, annotationColor } from "@sfly/schema";
import { type NodeChange, ViewportPortal } from "@xyflow/react";
import { cn } from "cn";
import { type CSSProperties, type ReactNode, useEffect, useId, useMemo, useRef } from "react";
import { NoteGlyph } from "#/components/note-icon";
import { AnnotationTitleEditor } from "./AnnotationTitleEditor";
import { type BandDrag, useBandDrag } from "./annotation-drag";
import { AnnotationToolbar } from "./CanvasToolbar";
import type { AnnotationEdit } from "./context";
import type { SfNode } from "./flow";
import { ZOOM_TEXT_12, ZOOM_TEXT_BAND } from "./zoom-text";

/** 标题离框顶的距离：标题写在框外上方，按底边放，缩小视图时文字变大往上长，不压住框。 */
const TITLE_GAP = 6;

/**
 * 注释框（GLOSSARY「注释框」）：比画布亮的底板加一圈淡描边，画在子流程区域和节点下面，后添加的画在上层；
 * 框里三层明暗：备注卡片最亮、底板居中、节点卡片最暗（ADR 0025）。颜色按注释框的 `color`（不写是灰色），
 * 各部分的颜色由 `data-annotation-color` 算出（tokens.css）。标题是框外左上方的同色胶囊（和框里写着标题的
 * 紫色子流程区域分开）；有备注时框里最上方是一张备注卡片，直接显示备注的前两行（缩小视图时一行），全文在检查器里看。
 * 范围由成员算出（@sfly/orchestration 的 annotationBoxes，由画布算好传进来），一个有效成员都没有的不画。
 * 给了 `onSelect` 时（可编辑的画布）点标题或备注卡片选中注释框，给了 `onMove` 时拖动它们整组移动成员（子流程成员的全部节点）。
 * 鼠标在标题或备注卡片上时通过 `onHover` 报告，只读的画布也一样：框身不挡鼠标。
 * 给了 `edit` 时双击标题原地改标题，选中的注释框标题后面出现工具条（CanvasToolbar 的 AnnotationToolbar）；
 * `dropTarget` 是拖动节点时松手会加入的注释框：底板亮一档，外面一圈虚线。
 */
export function AnnotationBoxes({
	layout,
	boxes,
	selected,
	onSelect,
	onHover,
	onMove,
	edit,
	toolbar = true,
	dropTarget = null,
}: {
	/** 拖动标题时按它找成员现在的位置。 */
	layout: LayoutDocument;
	boxes: readonly AnnotationBox<Annotation>[];
	/** 选中的注释框 ID。 */
	selected: string | null;
	onSelect?: (id: string) => void;
	/** 鼠标移到某个注释框的标题或备注卡片上（ID），或离开它（null）。 */
	onHover?: (id: string | null) => void;
	/** 拖动标题移动成员：和 React Flow 拖动节点一样用位置变化报告，拖动中 `dragging` 为 true，松手时为 false。 */
	onMove?: (changes: NodeChange<SfNode>[]) => void;
	edit?: AnnotationEdit | undefined;
	/** 选中时显示工具条（拖动节点的过程中不显示）。 */
	toolbar?: boolean;
	dropTarget?: string | null;
}) {
	const positions = useMemo(
		() => new Map(layout.nodes.flatMap((n) => (n.position ? [[n.id, n.position] as const] : []))),
		[layout],
	);
	return (
		<ViewportPortal>
			{boxes.map(({ annotation, box, members }) => {
				const { id } = annotation;
				return (
					<section
						key={id}
						data-annotation={id}
						data-annotation-color={annotationColor(annotation)}
						data-selected={selected === id || undefined}
						data-drop-target={dropTarget === id || undefined}
						aria-label={`注释框 ${annotation.title}`}
						className={cn(
							"pointer-events-none absolute -z-20 rounded-2xl border border-canvas-annotation-line bg-canvas-annotation-panel data-selected:border-canvas-node-selected data-selected:shadow-[0_0_0_0.5px_var(--canvas-node-selected),0_0_0_5px_var(--canvas-node-selected-ring)]",
							"data-drop-target:bg-canvas-annotation-panel-drop data-drop-target:outline-[1.5px] data-drop-target:outline-offset-4 data-drop-target:outline-canvas-node-selected data-drop-target:outline-dashed",
						)}
						style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
					>
						<Heading
							annotation={annotation}
							width={box.w}
							bottom={box.h + TITLE_GAP}
							selected={selected === id}
							onSelect={onSelect && (() => onSelect(id))}
							onHover={onHover}
							drag={onMove && { members, positions, onMove }}
							rename={
								edit && {
									active: edit.renaming === id,
									start: () => edit.startRename(id),
									commit: (text) => edit.commitRename(id, text),
									cancel: edit.cancelRename,
								}
							}
							toolbar={
								edit && toolbar && selected === id && edit.renaming !== id ? (
									<AnnotationToolbar
										annotation={annotation}
										nodeMembers={annotation.nodes.filter((n) => positions.has(n))}
										edit={edit}
									/>
								) : null
							}
						/>
					</section>
				);
			})}
		</ViewportPortal>
	);
}

/** 框外的标题胶囊和框里的备注卡片：一起报告悬停，点它们选中注释框，拖它们整组移动成员。 */
function Heading({
	annotation,
	width,
	bottom,
	selected,
	onSelect,
	onHover,
	drag,
	rename,
	toolbar,
}: {
	annotation: Annotation;
	width: number;
	bottom: number;
	selected: boolean;
	onSelect: (() => void) | undefined;
	onHover: ((id: string | null) => void) | undefined;
	drag: BandDrag | undefined;
	/** 原地改标题（只在可编辑的画布上有）。 */
	rename:
		| { active: boolean; start(): void; commit(text: string): void; cancel(): void }
		| undefined;
	/** 标题后面的工具条。 */
	toolbar: ReactNode;
}) {
	const noteId = useId();
	const note = annotation.note?.trim();
	const dragHandlers = useBandDrag(drag);
	const hovered = useRef(false);
	const latestHover = useRef(onHover);
	latestHover.current = onHover;
	// 鼠标停在标题上时它被删掉（撤销了新建、删除了注释框）不会收到 pointerleave：交还悬停，
	// 否则之后同一个注释框回来时会凭空高亮。
	useEffect(
		() => () => {
			if (hovered.current) latestHover.current?.(null);
		},
		[],
	);
	const hover = onHover && {
		onPointerEnter() {
			hovered.current = true;
			onHover(annotation.id);
		},
		onPointerLeave() {
			hovered.current = false;
			onHover(null);
		},
	};
	// 能拖动时加 nopan：按在标题或备注卡片上拖动移动成员，不平移画布（抓手工具下不能拖动，照常平移）。
	const handle = cn(
		"pointer-events-auto",
		onSelect && (drag ? "nopan cursor-grab active:cursor-grabbing" : "cursor-pointer"),
	);
	const interactive = onSelect ? { onClick: onSelect, ...dragHandlers } : {};
	const maxWidth = Math.max(width, 240);
	const titleStyle: CSSProperties = { maxWidth };
	// 胶囊的留白用 em：缩小视图时字变大，胶囊跟着按比例变大。
	const chipClass = cn(
		"block rounded-full bg-canvas-annotation-chip px-[0.72em] pt-[0.16em] pb-[0.2em] leading-[1.45] font-semibold whitespace-nowrap text-canvas-annotation-chip-fg",
		ZOOM_TEXT_BAND,
	);
	const titleClass = cn(
		chipClass,
		"truncate hover:bg-canvas-annotation-chip-hover data-selected:bg-canvas-annotation-chip-hover data-selected:shadow-[0_0_0_1.5px_var(--canvas-node-selected)]",
		handle,
	);
	return (
		<>
			{/* 标题和工具条排在一行，按底边放在框上方：缩小视图时标题变大往上长，工具条接在标题后面。 */}
			<div className="pointer-events-none absolute left-0 flex items-end gap-2" style={{ bottom }}>
				{rename?.active ? (
					<AnnotationTitleEditor
						initial={annotation.title}
						className={chipClass}
						maxWidth={maxWidth}
						onCommit={rename.commit}
						onCancel={rename.cancel}
					/>
				) : onSelect ? (
					// 不进 Tab 顺序：画布只有画布区域一个停靠点（和子流程区域的标题一样）。
					<button
						type="button"
						tabIndex={-1}
						data-annotation-band=""
						data-selected={selected || undefined}
						aria-label={`选中注释框 ${annotation.title}`}
						aria-pressed={selected}
						aria-describedby={note ? noteId : undefined}
						className={titleClass}
						style={titleStyle}
						{...hover}
						{...interactive}
						onDoubleClick={rename?.start}
					>
						{annotation.title}
					</button>
				) : (
					<div
						data-annotation-band=""
						aria-describedby={note ? noteId : undefined}
						className={titleClass}
						style={titleStyle}
						{...hover}
					>
						{annotation.title}
					</div>
				)}
				{toolbar}
			</div>
			{note && (
				// 备注卡片：框里最上方，宽和框里的内容对齐，比底板亮、带备注图标，和比底板暗的节点卡片分开。
				// 点它和点标题一样（读屏用的全文由标题的 aria-describedby 引用）。
				<div
					data-annotation-note=""
					aria-hidden
					className={cn(
						"absolute overflow-hidden rounded-xl border border-canvas-annotation-note-line bg-canvas-annotation-note px-3 py-2 text-canvas-annotation-note-fg",
						"in-data-[lod=true]:py-0.5",
						handle,
					)}
					style={{
						left: ANNOTATION_PADDING.left,
						right: ANNOTATION_PADDING.right,
						top: ANNOTATION_PADDING.top,
						height: ANNOTATION_NOTE.height,
					}}
					{...hover}
					{...interactive}
				>
					<p
						className={cn(
							// 缩小视图时只排一行（字号不变、备注卡片变矮），行高收紧，缩到 30% 也放得下。
							"line-clamp-2 leading-[1.5] whitespace-pre-line wrap-anywhere in-data-[lod=true]:line-clamp-1 in-data-[lod=true]:leading-[1.3]",
							ZOOM_TEXT_12,
						)}
					>
						<NoteGlyph className="mr-[0.45em] inline-block size-[1.1em] align-[-0.2em] text-canvas-annotation-swatch" />
						{note}
					</p>
				</div>
			)}
			{note && (
				<span id={noteId} hidden>
					{note}
				</span>
			)}
		</>
	);
}
