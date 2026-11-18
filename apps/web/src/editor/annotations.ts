import { uniqueNodeId } from "@sfly/orchestration";
import {
	ANNOTATION_DEFAULT_COLOR,
	type Annotation,
	type AnnotationColor,
	STICKY_NOTE_DEFAULT_COLOR,
	type StickyNote,
} from "@sfly/schema";
import type { AnnotationDrop } from "#/components/canvas/annotation-drop";
import { TERM } from "#/lib/copy";

/**
 * 画布上改注释框的操作（纯函数，输入当前的注释框列表，输出新的列表）。删除节点时的同步在
 * @sfly/orchestration 的 removeNodes 里，和删除合成一步。
 */

const ID_STEM = "annotation";

/** 新注释框：ID 是不和已有的重复的 `annotation_N`，标题默认「注释框 N」。 */
export function newAnnotation(
	existing: readonly Annotation[],
	members: Pick<Annotation, "nodes" | "subflows">,
): Annotation {
	const id = uniqueNodeId(
		ID_STEM,
		existing.map((a) => a.id),
	);
	return { id, title: `${TERM.annotation} ${id.slice(ID_STEM.length + 1)}`, ...members };
}

/** 节点（或作为子流程成员的子流程入口）是这个注释框的成员。 */
export const hasMember = (annotation: Annotation, id: string): boolean =>
	annotation.nodes.includes(id) || annotation.subflows.includes(id);

export const memberCount = (annotation: Annotation): number =>
	annotation.nodes.length + annotation.subflows.length;

/** 把节点加进注释框的节点成员。 */
export const withNode = (annotation: Annotation, id: string): Annotation => ({
	...annotation,
	nodes: [...annotation.nodes, id],
});

/** 从注释框里去掉这个成员（节点成员和子流程成员里的都去掉）。 */
export const withoutMember = (annotation: Annotation, id: string): Annotation => ({
	...annotation,
	nodes: annotation.nodes.filter((n) => n !== id),
	subflows: annotation.subflows.filter((s) => s !== id),
});

/**
 * 把成员从 ID 是 `id` 的注释框里移出（节点成员和子流程成员里的都去掉）。移出的是最后一个成员时注释框一起删除，
 * 和删节点时成员删光的注释框一样；画布上是一步撤销。
 */
export const leaveAnnotation = (
	annotations: readonly Annotation[],
	id: string,
	memberId: string,
): Annotation[] =>
	annotations.flatMap((a) => {
		if (a.id !== id) return [a];
		const next = withoutMember(a, memberId);
		return memberCount(next) === 0 ? [] : [next];
	});

/** 换颜色：灰色不写（不写就是灰色），所以选灰色时去掉 `color`。 */
export function withColor(annotation: Annotation, color: AnnotationColor): Annotation {
	const { color: _, ...rest } = annotation;
	return color === ANNOTATION_DEFAULT_COLOR ? rest : { ...rest, color };
}

/** 便签换颜色：黄色不写（不写就是黄色，ADR 0026），所以选黄色时去掉 `color`。 */
export function withStickyColor(note: StickyNote, color: AnnotationColor): StickyNote {
	const { color: _, ...rest } = note;
	return color === STICKY_NOTE_DEFAULT_COLOR ? rest : { ...rest, color };
}

/** 把列表里 ID 是 `id` 的注释框换成 `update` 的结果。 */
export const updateAnnotation = (
	annotations: readonly Annotation[],
	id: string,
	update: (annotation: Annotation) => Annotation,
): Annotation[] => annotations.map((a) => (a.id === id ? update(a) : a));

/**
 * 拖动节点松手后的注释框（components/canvas/annotation-drop.ts）：先从按住 Alt 拖出的框里移出拖动的节点
 * （移出后没有成员的框一起删除），再把 `joining`（要加入的节点按 annotationMembersOfSelection 记成的成员）
 * 并进要加入的框，已经是成员的不重复记。没有变化时返回原来的数组。
 */
export function applyAnnotationDrop(
	annotations: readonly Annotation[],
	drop: Pick<AnnotationDrop, "dragged" | "join" | "leave">,
	joining: Pick<Annotation, "nodes" | "subflows">,
): readonly Annotation[] {
	if (drop.join === null && drop.leave.length === 0) return annotations;
	const leaving = new Set(drop.leave.map((l) => l.id));
	const dragged = new Set(drop.dragged);
	return annotations.flatMap((a) => {
		let next = a;
		if (leaving.has(a.id)) {
			next = {
				...a,
				nodes: a.nodes.filter((id) => !dragged.has(id)),
				subflows: a.subflows.filter((id) => !dragged.has(id)),
			};
			if (memberCount(next) === 0) return [];
		}
		if (a.id === drop.join?.id) {
			next = {
				...next,
				nodes: [...next.nodes, ...joining.nodes.filter((id) => !next.nodes.includes(id))],
				subflows: [
					...next.subflows,
					...joining.subflows.filter((id) => !next.subflows.includes(id)),
				],
			};
		}
		return [next];
	});
}
