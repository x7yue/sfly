import { type AnnotationBox, type LayoutDocument, REGION_PADDING } from "@sfly/orchestration";
import type { Annotation } from "@sfly/schema";
import { type NodeChange, ViewportPortal } from "@xyflow/react";
import { cn } from "cn";
import { useEffect, useId, useMemo, useRef } from "react";
import { NoteIcon } from "#/components/note-icon";
import { type BandDrag, useBandDrag } from "./annotation-drag";
import type { SfNode } from "./flow";
import { ZOOM_TEXT_TITLE } from "./zoom-text";

/** 标题带底边离框顶的距离：标题带放在框上方的留白里，缩小视图时文字变大往上长，不压住成员。 */
const BAND_BOTTOM = REGION_PADDING.top - 8;

/**
 * 注释框（GLOSSARY「注释框」）：中性实线框加标题带，画在子流程区域和节点下面，后添加的画在上层。
 * 范围由成员算出（@sfly/orchestration 的 annotationBoxes，由画布算好传进来），一个有效成员都没有的不画。
 * 标题带只有标题和（有备注时）备注图标；给了 `onSelect` 时（可编辑的画布）点标题带选中注释框，
 * 给了 `onMove` 时拖动标题带整组移动成员（子流程成员的全部节点）。鼠标在标题带上时通过 `onHover` 报告，
 * 只读的画布也一样：框不挡鼠标，悬停只认标题带。
 */
export function AnnotationBoxes({
	layout,
	boxes,
	selected,
	onSelect,
	onHover,
	onMove,
}: {
	/** 拖动标题带时按它找成员现在的位置。 */
	layout: LayoutDocument;
	boxes: readonly AnnotationBox<Annotation>[];
	/** 选中的注释框 ID。 */
	selected: string | null;
	onSelect?: (id: string) => void;
	/** 鼠标移到某个注释框的标题带上（ID），或离开它（null）。 */
	onHover?: (id: string | null) => void;
	/** 拖动标题带移动成员：和 React Flow 拖动节点一样用位置变化报告，拖动中 `dragging` 为 true，松手时为 false。 */
	onMove?: (changes: NodeChange<SfNode>[]) => void;
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
						data-selected={selected === id || undefined}
						aria-label={`注释框 ${annotation.title}`}
						className="pointer-events-none absolute -z-20 rounded-xl border border-canvas-annotation-line bg-canvas-annotation-soft data-selected:border-canvas-node-selected data-selected:shadow-[0_0_0_4px_var(--canvas-node-selected-ring)]"
						style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
					>
						<Band
							annotation={annotation}
							bottom={box.h - BAND_BOTTOM}
							selected={selected === id}
							onSelect={onSelect && (() => onSelect(id))}
							onHover={onHover}
							drag={onMove && { members, positions, onMove }}
						/>
					</section>
				);
			})}
		</ViewportPortal>
	);
}

function Band({
	annotation,
	bottom,
	selected,
	onSelect,
	onHover,
	drag,
}: {
	annotation: Annotation;
	bottom: number;
	selected: boolean;
	onSelect: (() => void) | undefined;
	onHover: ((id: string | null) => void) | undefined;
	drag: BandDrag | undefined;
}) {
	const noteId = useId();
	const note = annotation.note?.trim();
	const dragHandlers = useBandDrag(drag);
	const hovered = useRef(false);
	const latestHover = useRef(onHover);
	latestHover.current = onHover;
	// 鼠标停在标题带上时它被删掉（撤销了新建、删除了注释框）不会收到 pointerleave：交还悬停，
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
	const className = cn(
		"pointer-events-auto absolute left-2.5 flex max-w-[calc(100%-1.25rem)] items-center gap-1.5 rounded-md bg-canvas-annotation-band px-2 py-0.5 whitespace-nowrap text-fg-1",
		ZOOM_TEXT_TITLE,
	);
	const content = (
		<>
			<span className="min-w-0 truncate font-semibold">{annotation.title}</span>
			{note && (
				<NoteIcon note={note} host="[data-annotation-band]" textId={noteId} className="flex-none" />
			)}
		</>
	);
	if (!onSelect) {
		return (
			<div
				data-annotation-band=""
				aria-describedby={note ? noteId : undefined}
				className={className}
				style={{ bottom }}
				{...hover}
			>
				{content}
			</div>
		);
	}
	return (
		// 不进 Tab 顺序：画布只有画布区域一个停靠点（和子流程区域的标题一样）。
		// 能拖动时加 nopan：按在标题带上拖动移动成员，不平移画布（抓手工具下不能拖动，照常平移）。
		<button
			type="button"
			tabIndex={-1}
			data-annotation-band=""
			aria-label={`选中注释框 ${annotation.title}`}
			aria-pressed={selected}
			aria-describedby={note ? noteId : undefined}
			className={cn(
				className,
				drag ? "nopan cursor-grab active:cursor-grabbing" : "cursor-pointer",
			)}
			style={{ bottom }}
			onClick={onSelect}
			{...hover}
			{...dragHandlers}
		>
			{content}
		</button>
	);
}
