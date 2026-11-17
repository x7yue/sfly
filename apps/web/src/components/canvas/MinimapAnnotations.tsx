import { type AnnotationBox, stickyNoteSize } from "@sfly/orchestration";
import type { Annotation } from "@sfly/schema";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlacedStickyNote } from "./StickyNotes";

/**
 * 小地图上的注释框和便签：按框的范围画一块注释框颜色的底，便签画成它颜色的一块，都排在节点下面（视口外的遮罩还盖在最上面）。
 * 小地图的 svg 用的就是画布坐标，所以直接按画布上框的范围画。React Flow 的 MiniMap 不接受子元素，
 * 这里在它的 svg 最前面插一个 <g>，把色块渲染进去。
 */
export function MinimapAnnotations({
	root,
	shown,
	boxes,
	stickyNotes,
}: {
	/** 画布容器（在里面找小地图的 svg）。 */
	root: RefObject<HTMLElement | null>;
	/** 小地图是否显示。 */
	shown: boolean;
	boxes: readonly AnnotationBox<Annotation>[];
	stickyNotes: readonly PlacedStickyNote[];
}) {
	const [layer, setLayer] = useState<SVGGElement | null>(null);
	const current = useRef<SVGGElement | null>(null);
	// 小地图的 svg 在节点量好尺寸之后才出现，隐藏再显示时也会换一个：每次渲染后看一眼，图层不在 svg 里就补上。
	useLayoutEffect(() => {
		const svg = shown
			? root.current?.querySelector<SVGSVGElement>(".react-flow__minimap svg")
			: null;
		if (current.current && current.current.parentNode === svg) return;
		current.current?.remove();
		current.current = null;
		if (svg) {
			const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
			g.dataset.minimapAnnotations = "";
			// 只是底色：不进 Tab 顺序（Chrome 会让小地图 svg 里的 <g> 成为一个停靠点），读屏跳过。
			g.setAttribute("tabindex", "-1");
			g.setAttribute("aria-hidden", "true");
			const title = svg.querySelector("title");
			svg.insertBefore(g, title ? title.nextSibling : svg.firstChild);
			current.current = g;
		}
		setLayer(current.current);
	});
	useEffect(() => () => current.current?.remove(), []);
	if (!layer) return null;
	return createPortal(
		[
			...boxes.map(({ annotation, box }) => (
				<rect
					key={annotation.id}
					data-annotation-color={annotation.color ?? "gray"}
					x={box.x}
					y={box.y}
					width={box.w}
					height={box.h}
					rx={20}
					style={{ fill: "var(--canvas-annotation-line)" }}
				/>
			)),
			...stickyNotes.map((note) => {
				const size = stickyNoteSize(note);
				return (
					<rect
						key={`sticky:${note.id}`}
						data-minimap-sticky={note.id}
						data-annotation-color={note.color ?? "yellow"}
						x={note.position.x}
						y={note.position.y}
						width={size.width}
						height={size.height}
						rx={12}
						style={{ fill: "var(--canvas-sticky-line)" }}
					/>
				);
			}),
		],
		layer,
	);
}
