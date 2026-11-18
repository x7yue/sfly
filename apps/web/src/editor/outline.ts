import {
	annotationBoxes,
	type LayoutDocument,
	readingOrder,
	stickyHeadline,
} from "@sfly/orchestration";
import type { Annotation, StickyNote } from "@sfly/schema";

/**
 * 画布的大纲（单测见 outline.test.ts）：不在任何注释框里的节点排在最前，接着每个注释框一组，列出它框住的节点
 * （成员节点，和成员子流程及其下级子流程链上的节点）。一个节点在几个注释框里就在几组里出现。
 * 组按注释框在文档里的顺序，组里的节点和最前那组都按画布上的阅读顺序（先上后下，同一行从左到右）。
 * 一个有效成员都没有的注释框不列（画布上也不画）。便签另成最后一组，按文档里的顺序。
 */
export interface OutlineNode {
	id: string;
	kind: string;
	/** 卡片上的标题。 */
	title: string;
}

export interface OutlineGroup {
	annotation: Annotation;
	nodes: OutlineNode[];
}

export interface CanvasOutline {
	/** 不在任何注释框里的节点。 */
	loose: OutlineNode[];
	groups: OutlineGroup[];
	/** 便签：标题，没有标题时是正文的第一行。 */
	stickies: { id: string; label: string }[];
}

/**
 * `query` 不为空时只留匹配的：节点按标题或节点 ID 匹配（不分大小写），注释框的标题匹配时整组都留下；
 * 一个匹配的节点都没有的组不留；便签按标题和正文匹配。
 */
export function canvasOutline(
	doc: LayoutDocument & {
		annotations: readonly Annotation[];
		sticky_notes?: readonly StickyNote[] | undefined;
	},
	titleOf: (id: string) => string,
	query = "",
): CanvasOutline {
	const q = query.trim().toLowerCase();
	const hit = (text: string) => text.toLowerCase().includes(q);
	const ordered = readingOrder(
		doc.nodes.flatMap((n) =>
			n.position ? [{ id: n.id, kind: n.kind, position: n.position }] : [],
		),
	).map((n): OutlineNode => ({ id: n.id, kind: n.kind, title: titleOf(n.id) }));
	const matches = (n: OutlineNode) => !q || hit(n.title) || hit(n.id);
	const boxes = annotationBoxes(doc);
	const framed = new Set(boxes.flatMap((b) => b.members));
	const groups = boxes.flatMap(({ annotation, members }) => {
		const inside = new Set(members);
		const all = ordered.filter((n) => inside.has(n.id));
		const nodes = !q || hit(annotation.title) ? all : all.filter(matches);
		return nodes.length > 0 ? [{ annotation, nodes }] : [];
	});
	const stickies = (doc.sticky_notes ?? []).flatMap((s) =>
		!q || hit(s.title ?? "") || hit(s.text) ? [{ id: s.id, label: stickyHeadline(s) }] : [],
	);
	return { loose: ordered.filter((n) => !framed.has(n.id) && matches(n)), groups, stickies };
}
