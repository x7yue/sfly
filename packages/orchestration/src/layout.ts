import type { StructureDocument } from "./structure.js";
import { chainMembers } from "./structure.js";

/**
 * 整理布局（原型 #/editor 的布局）：画布的「整理布局」、新建场景和缺少布局的文档（例如通过 API 创建）
 * 都用这一套算法，控制面与画布共用。
 *
 * - 主链按连线顺序排列：不超过 MAX_SINGLE_ROW 个节点排成一行，更长的按两行折返
 *   （前一半在第一行，后一半从左侧开始排在第二行；连线在两行之间绕回）。
 * - 子流程放在主链下方，每个子流程一行，从触发它的异步任务节点右下方开始（调度连线先竖直落下、
 *   再水平进入子流程入口）；嵌套的子流程紧跟在上一层下面。按主链上的顺序深度优先排列。
 * - 没有被触发的子流程、不在任何链上的节点排在最下面，从左侧开始。
 *
 * 节点卡片尺寸与子流程区域留白也在这里定义（画布的 geometry.ts 从这里取），保证排出来的区域不重叠。
 */

/** 节点卡片尺寸。 */
export const NODE_SIZE = { width: 208, height: 112 } as const;

/** 子流程区域在成员节点外接框之外的留白；上方留出标题行。 */
export const REGION_PADDING = { left: 24, top: 44, right: 24, bottom: 20 } as const;

/** 同一行相邻节点的水平间距（卡片宽 + 44）。 */
export const LAYOUT_COLUMN = NODE_SIZE.width + 44;
/** 主链两行之间的行距（卡片高 + 102，留出折返连线的位置）。 */
const MAIN_ROW = NODE_SIZE.height + 102;
/** 主链底边到第一个子流程节点顶边的距离（区域标题行之上再留 100）。 */
export const SUBFLOW_TOP_GAP = REGION_PADDING.top + 100;
/** 子流程相邻两行的行距：区域之间留 40。 */
const SUBFLOW_ROW = NODE_SIZE.height + REGION_PADDING.bottom + 40 + REGION_PADDING.top;
/** 子流程入口节点相对触发它的异步任务节点的水平偏移。 */
export const SUBFLOW_INDENT = NODE_SIZE.width / 2 + 106;
/** 主链不超过这么多节点时排成一行。 */
const MAX_SINGLE_ROW = 5;

export interface Position {
	x: number;
	y: number;
}

/** 带布局的文档（只读取结构和位置）。 */
export interface LayoutDocument extends StructureDocument {
	nodes: readonly (StructureDocument["nodes"][number] & { position?: Position | undefined })[];
}

/** 整理布局：每个节点（按文档中的顺序）的位置。 */
export function tidyLayout(doc: StructureDocument): Map<string, Position> {
	const kindOf = new Map(doc.nodes.map((n) => [n.id, n.kind]));
	const chains = chainMembers(doc);
	const dispatchOf = new Map<string, string>();
	for (const e of doc.edges) {
		if (
			e.kind === "dispatch" &&
			kindOf.get(e.from) === "async" &&
			kindOf.get(e.to) === "subflow_entry" &&
			!dispatchOf.has(e.from)
		) {
			dispatchOf.set(e.from, e.to);
		}
	}

	const placed = new Map<string, Position>();
	const place = (id: string, p: Position) => {
		if (!placed.has(id)) placed.set(id, p);
	};

	// 主链
	const entry = doc.nodes.find((n) => n.kind === "entry");
	const main = entry ? (chains.get(entry.id) ?? []) : [];
	const perRow = main.length <= MAX_SINGLE_ROW ? main.length : Math.ceil(main.length / 2);
	main.forEach((id, i) => {
		place(id, { x: (i % perRow) * LAYOUT_COLUMN, y: Math.floor(i / perRow) * MAIN_ROW });
	});
	const mainRows = main.length === 0 ? 0 : Math.ceil(main.length / perRow);
	let rowY = mainRows === 0 ? 0 : (mainRows - 1) * MAIN_ROW + NODE_SIZE.height + SUBFLOW_TOP_GAP;

	// 子流程：沿链深度优先，遇到异步任务节点就把它触发的子流程排在下一行。
	const laidOut = new Set<string>();
	const layoutRow = (ids: string[], x0: number) => {
		const fresh = ids.filter((id) => !placed.has(id));
		fresh.forEach((id, i) => {
			place(id, { x: x0 + i * LAYOUT_COLUMN, y: rowY });
		});
		if (fresh.length > 0) rowY += SUBFLOW_ROW;
	};
	const subflowsOf = (ids: string[]) => {
		for (const id of ids) {
			const sub = dispatchOf.get(id);
			if (!sub || laidOut.has(sub) || placed.has(sub)) continue;
			laidOut.add(sub);
			const members = chains.get(sub) ?? [sub];
			layoutRow(members, (placed.get(id)?.x ?? 0) + SUBFLOW_INDENT);
			subflowsOf(members);
		}
	};
	subflowsOf(main);

	// 没有被触发的子流程（以及其他入口节点的链），然后是不在任何链上的节点。
	for (const [start, members] of chains) {
		if (placed.has(start)) continue;
		layoutRow(members, 0);
		subflowsOf(members);
	}
	layoutRow(
		doc.nodes.map((n) => n.id),
		0,
	);

	return new Map(doc.nodes.map((n) => [n.id, placed.get(n.id) as Position]));
}

/**
 * 缺少布局的文档：有节点没有位置时，整份文档按整理布局重新排列（不混用两种布局，免得重叠）；
 * 所有节点都有位置时原样返回。
 */
export function ensureLayout<D extends LayoutDocument>(doc: D): D {
	if (doc.nodes.every((n) => n.position)) return doc;
	const layout = tidyLayout(doc);
	return { ...doc, nodes: doc.nodes.map((n) => ({ ...n, position: layout.get(n.id) })) } as D;
}
