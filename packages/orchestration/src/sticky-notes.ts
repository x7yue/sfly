import { STICKY_NOTE_SIZE } from "@sfly/schema";
import type { AnnotationMemberIds } from "./annotation-members.js";
import { annotationBoxes, subflowRegions } from "./annotations.js";
import {
	ANNOTATION_GAP,
	ANNOTATION_TITLE_SPACE,
	type LayoutDocument,
	type Position,
} from "./layout.js";

/** 便签那一行和下面的内容（主链、注释框的标题）之间的距离。 */
export const STICKY_ROW_GAP = 48;

/** 读便签位置用到的部分：ID、位置、大小。 */
export interface StickyNoteBox {
	readonly id: string;
	readonly position?: Position | undefined;
	readonly size?: { readonly width: number; readonly height: number } | undefined;
}

/** 带便签的文档（节点要有位置；注释框只读成员和备注）。 */
export interface StickyNoteDocument<S extends StickyNoteBox = StickyNoteBox>
	extends LayoutDocument {
	readonly annotations?:
		| readonly (AnnotationMemberIds & { readonly id: string; readonly note?: string | undefined })[]
		| undefined;
	readonly sticky_notes?: readonly S[] | undefined;
}

/** 便签的大小：没写就是默认大小。 */
export const stickyNoteSize = (note: StickyNoteBox) => note.size ?? STICKY_NOTE_SIZE;

/**
 * 整理布局时便签的位置（ADR 0026）：按 `sticky_notes` 的顺序从左到右排成一行，上边对齐，相邻两张之间留
 * ANNOTATION_GAP；整行放在内容（节点卡片、子流程区域、注释框和它框外的标题）的上方 STICKY_ROW_GAP 处，
 * 和内容的左沿对齐。节点用文档里现在的位置（整理布局时先排好节点再算这一行），没有节点时从原点上方开始。
 */
export function stickyNoteRow(doc: StickyNoteDocument): Map<string, Position> {
	const notes = doc.sticky_notes ?? [];
	if (notes.length === 0) return new Map();
	const rects = [
		...doc.nodes.flatMap((n) => (n.position ? [{ x: n.position.x, y: n.position.y }] : [])),
		...subflowRegions(doc).map((r) => ({ x: r.box.x, y: r.box.y })),
		...annotationBoxes({ ...doc, annotations: doc.annotations ?? [] }).map((b) => ({
			x: b.box.x,
			y: b.box.y - ANNOTATION_TITLE_SPACE,
		})),
	];
	const left = rects.length > 0 ? Math.min(...rects.map((r) => r.x)) : 0;
	const top = rects.length > 0 ? Math.min(...rects.map((r) => r.y)) : 0;
	const height = Math.max(...notes.map((n) => stickyNoteSize(n).height));
	const y = top - STICKY_ROW_GAP - height;
	let x = left;
	return new Map(
		notes.map((note) => {
			const at = { x, y };
			x += stickyNoteSize(note).width + ANNOTATION_GAP;
			return [note.id, at];
		}),
	);
}

/**
 * 补便签的位置：没写位置的便签（命令行和 API 上传的可以不写）放到整理布局给它的那一行里，写了的不动
 * （控制面保存场景版本时、画布打开时用）。所有便签都有位置时原样返回。
 */
export function withStickyNotePositions<S extends StickyNoteBox, D extends StickyNoteDocument<S>>(
	doc: D,
): D {
	const notes = doc.sticky_notes ?? [];
	if (notes.every((n) => n.position)) return doc;
	const row = stickyNoteRow(doc);
	return {
		...doc,
		sticky_notes: notes.map((n) => (n.position ? n : { ...n, position: row.get(n.id) })),
	};
}

/** 便签在画布坐标里的矩形（适配视图、小地图用）。 */
export const stickyNoteRect = (note: StickyNoteBox & { position: Position }) => {
	const size = stickyNoteSize(note);
	return { x: note.position.x, y: note.position.y, w: size.width, h: size.height };
};
