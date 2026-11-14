import { annotationBoxes, type LayoutDocument, REGION_PADDING } from "@sfly/orchestration";
import type { Annotation } from "@sfly/schema";
import { ViewportPortal } from "@xyflow/react";
import { cn } from "cn";
import { useId, useMemo } from "react";
import { NoteIcon } from "#/components/note-icon";
import { ZOOM_TEXT_TITLE } from "./zoom-text";

/** 标题带底边离框顶的距离：标题带放在框上方的留白里，缩小视图时文字变大往上长，不压住成员。 */
const BAND_BOTTOM = REGION_PADDING.top - 8;

/**
 * 注释框（GLOSSARY「注释框」）：中性实线框加标题带，画在子流程区域和节点下面，后添加的画在上层。
 * 范围由成员算出（@sfly/orchestration 的 annotationBoxes），一个有效成员都没有的不画。
 * 标题带只有标题和（有备注时）备注图标；给了 `onSelect` 时（可编辑的画布）点标题带选中注释框。
 */
export function AnnotationBoxes({
	layout,
	annotations,
	selected,
	onSelect,
}: {
	layout: LayoutDocument;
	annotations: readonly Annotation[];
	/** 选中的注释框 ID。 */
	selected: string | null;
	onSelect?: (id: string) => void;
}) {
	const boxes = useMemo(() => annotationBoxes({ ...layout, annotations }), [layout, annotations]);
	return (
		<ViewportPortal>
			{boxes.map(({ annotation, box }) => {
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
}: {
	annotation: Annotation;
	bottom: number;
	selected: boolean;
	onSelect: (() => void) | undefined;
}) {
	const noteId = useId();
	const note = annotation.note?.trim();
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
			>
				{content}
			</div>
		);
	}
	return (
		// 不进 Tab 顺序：画布只有画布区域一个停靠点（和子流程区域的标题一样）。
		<button
			type="button"
			tabIndex={-1}
			data-annotation-band=""
			aria-label={`选中注释框 ${annotation.title}`}
			aria-pressed={selected}
			aria-describedby={note ? noteId : undefined}
			className={cn(className, "cursor-pointer")}
			style={{ bottom }}
			onClick={onSelect}
		>
			{content}
		</button>
	);
}
