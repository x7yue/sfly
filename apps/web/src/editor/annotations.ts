import { uniqueNodeId } from "@sfly/orchestration";
import type { Annotation } from "@sfly/schema";
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

/** 把列表里 ID 是 `id` 的注释框换成 `update` 的结果。 */
export const updateAnnotation = (
	annotations: readonly Annotation[],
	id: string,
	update: (annotation: Annotation) => Annotation,
): Annotation[] => annotations.map((a) => (a.id === id ? update(a) : a));
