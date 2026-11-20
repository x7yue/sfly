import type { AnnotationMemberIds } from "./annotation-members.js";
import type { StructureDocument } from "./structure.js";
import { chainMembers, subflowTree } from "./structure.js";

/**
 * 整理布局：画布的「整理布局」、新建场景和缺少布局的文档（例如通过 API 创建）都用这一套算法，控制面与画布共用。
 *
 * - 主链按连线顺序从左往右排，折成几行，每行从左侧开始；每行不超过 MAX_ROW 个节点，行数最少、各行尽量一样多。
 * - 注释框不拆开：同一个注释框的主链成员（连同夹在成员之间的节点）排在同一行，换行只发生在注释框之间；
 *   超过 MAX_ROW 个节点的注释框单独占几行，后面的节点另起一行。相邻两个节点不在同一组注释框里时多留
 *   ANNOTATION_GAP，相邻两行有一行在注释框里时多留 ANNOTATION_ROW_GAP（下一行的注释框有备注时再多留备注卡片的位置），
 *   框和框外的标题不会叠在一起，也不挤着换行连线。
 * - 子流程排在触发它的那一行下面、下一行上面：从触发它的异步任务节点右下方开始（调度连线先竖直落下、再水平进入
 *   子流程入口），每个子流程一行，嵌套的子流程紧跟在上一层下面。同一行触发的几个子流程，越靠右的触发节点排得越靠上，
 *   调度连线就不会从别的卡片下面经过。注释框包含子流程时，这一行到这个注释框为止，框不会框住同一行后面的节点。
 * - 没有被触发的子流程、不在任何链上的节点排在最下面，从左侧开始。
 *
 * 节点卡片尺寸与子流程区域留白也在这里定义（画布的 geometry.ts 从这里取），保证排出来的区域不重叠。
 */

/** 节点卡片尺寸：矮胶囊，左边一盏站点灯，两行字（docs/DESIGN-SYSTEM.md §2.3）。 */
export const NODE_SIZE = { width: 256, height: 60 } as const;

/** 子流程区域在成员节点外接框之外的留白；上方留出标题行。 */
export const REGION_PADDING = { left: 24, top: 44, right: 24, bottom: 20 } as const;

/** 注释框在成员外接框之外的留白：标题写在框外上方（ANNOTATION_TITLE_SPACE），框里四周只留一圈空。 */
export const ANNOTATION_PADDING = { left: 24, top: 20, right: 24, bottom: 20 } as const;
/** 注释框标题在框外上方占的高度：15px 的标题一行，加上离框的空隙。 */
export const ANNOTATION_TITLE_SPACE = 30;
/** 有备注时注释框里最上方的备注卡片：高（两行 12px 正文、上下留白和描边）、和下面成员的空隙。 */
export const ANNOTATION_NOTE = { height: 56, gap: 12 } as const;

/** 同一行相邻节点的水平间距（卡片宽 + 44）。 */
export const LAYOUT_COLUMN = NODE_SIZE.width + 44;
/**
 * 相邻两个节点不在同一组注释框里时多留的水平间距：两个框各留白 24，卡片之间只有 44，
 * 多留 40 后两个框之间空出 36。
 */
export const ANNOTATION_GAP = 40;
/** 主链相邻两行的行距（卡片高 + 102，留出换行连线的位置）。 */
const MAIN_ROW = NODE_SIZE.height + 102;
/**
 * 相邻两行主链有一行在注释框里时多留的行距：上一行框的底边留白 20，下一行框的标题（框外 30）和框里的留白 20，
 * 中间还空出 72。换行连线贴着上一行走（CHAIN_WRAP_DROP），缩小视图时框外的标题变大往上长，也碰不到它。
 * 下一行的注释框有备注时再多留一张备注卡片的位置。
 */
export const ANNOTATION_ROW_GAP = 40;
/**
 * 换行连线在上一行下方多远处折回（从上一行的端口算起）：卡片底边往下 34，在上一行注释框的底边留白之外、
 * 下一行框外的标题之上。中间夹着子流程时也在这里折回，贴着上一行走，不穿过子流程（画布的 FlowEdge 用它）。
 */
export const CHAIN_WRAP_DROP = NODE_SIZE.height / 2 + 34;
/** 一行底边到它触发的第一个子流程节点顶边的距离（区域标题行之上再留 100）。 */
export const SUBFLOW_TOP_GAP = REGION_PADDING.top + 100;
/** 子流程相邻两行的行距：区域之间留 40。子流程下面的下一行主链也按这个行距排。 */
const SUBFLOW_ROW = NODE_SIZE.height + REGION_PADDING.bottom + 40 + REGION_PADDING.top;
/** 子流程入口节点相对触发它的异步任务节点的水平偏移。 */
export const SUBFLOW_INDENT = NODE_SIZE.width / 2 + 106;
/** 主链一行最多这么多节点。 */
const MAX_ROW = 5;

export interface Position {
	x: number;
	y: number;
}

/** 带布局的文档（只读取结构和位置）。 */
export interface LayoutDocument extends StructureDocument {
	nodes: readonly (StructureDocument["nodes"][number] & {
		position?: Position | undefined;
		/** 卡片实际的高度：画布量出来的（运行状态下卡片按内容长高）。没有时按 NODE_SIZE 的高度算。 */
		height?: number | undefined;
	})[];
}

/** 整理布局读取的文档：结构，和注释框的成员与备注（可以没有）。 */
export interface TidyDocument extends StructureDocument {
	readonly annotations?:
		| readonly (AnnotationMemberIds & { readonly note?: string | undefined })[]
		| undefined;
}

/** 主链上不能拆开的一段：一个节点，或者一组注释框的成员（连同夹在中间的节点）。 */
interface Run {
	ids: string[];
	/** 段里有节点触发的子流程（或它的下级子流程）属于框住这一段的注释框：这一行到这一段为止。 */
	endsRow: boolean;
}

/** 把主链的段排成行：每行不超过 `limit` 个节点；超过 `limit` 的段单独占几行（行数最少、各行尽量一样多）。 */
function packRows(runs: readonly Run[], limit: number): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	const flush = () => {
		if (row.length > 0) rows.push(row);
		row = [];
	};
	for (const run of runs) {
		if (run.ids.length > limit) {
			flush();
			const count = Math.ceil(run.ids.length / limit);
			const per = Math.ceil(run.ids.length / count);
			for (let i = 0; i < run.ids.length; i += per) rows.push(run.ids.slice(i, i + per));
			continue;
		}
		if (row.length + run.ids.length > limit) flush();
		row.push(...run.ids);
		if (run.endsRow) flush();
	}
	flush();
	return rows;
}

/** 整理布局：每个节点（按文档中的顺序）的位置。 */
export function tidyLayout(doc: TidyDocument): Map<string, Position> {
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

	// 每个节点在哪几个注释框里：节点成员，和成员子流程及其下级子流程链上的节点。
	const annotations = doc.annotations ?? [];
	const treeOf = (entry: string) => subflowTree(doc, entry, chains);
	const framedBy = new Map<string, number[]>();
	annotations.forEach((a, i) => {
		const subflows = a.subflows.flatMap(treeOf);
		const ids = [...a.nodes, ...subflows.flatMap((s) => chains.get(s) ?? [])];
		for (const id of new Set(ids)) framedBy.set(id, [...(framedBy.get(id) ?? []), i]);
	});
	const groupOf = (id: string) => (framedBy.get(id) ?? []).join(",");

	const placed = new Map<string, Position>();
	/** 从 x0 起排一行（只排还没有位置的节点），返回排了哪些。 */
	const placeRow = (ids: readonly string[], x0: number, y: number): string[] => {
		const fresh = ids.filter((id) => !placed.has(id));
		let x = x0;
		fresh.forEach((id, i) => {
			const prev = fresh[i - 1];
			if (prev !== undefined)
				x += LAYOUT_COLUMN + (groupOf(prev) === groupOf(id) ? 0 : ANNOTATION_GAP);
			placed.set(id, { x, y });
		});
		return fresh;
	};

	// 一行触发的子流程排在 `y` 起往下的各行，越靠右的触发节点排得越靠上；返回下一行的 y。
	const laidOut = new Set<string>();
	const placeSubflows = (row: readonly string[], y: number): number => {
		let next = y;
		for (const id of [...row].reverse()) {
			const sub = dispatchOf.get(id);
			if (!sub || laidOut.has(sub) || placed.has(sub)) continue;
			laidOut.add(sub);
			const members = placeRow(
				chains.get(sub) ?? [sub],
				(placed.get(id)?.x ?? 0) + SUBFLOW_INDENT,
				next,
			);
			if (members.length > 0) next = placeSubflows(members, next + SUBFLOW_ROW);
		}
		return next;
	};

	// 主链：先分成不能拆开的段，再排成行。
	const entry = doc.nodes.find((n) => n.kind === "entry");
	const main = entry ? (chains.get(entry.id) ?? []) : [];
	const spans = annotations.flatMap((a) => {
		const at = a.nodes.map((id) => main.indexOf(id)).filter((i) => i >= 0);
		return at.length > 0 ? [[Math.min(...at), Math.max(...at)] as const] : [];
	});
	const runs: Run[] = [];
	main.forEach((id, i) => {
		const prev = main[i - 1];
		const together =
			prev !== undefined &&
			((groupOf(prev) !== "" && groupOf(prev) === groupOf(id)) ||
				spans.some(([first, last]) => first < i && i <= last));
		const last = runs.at(-1);
		if (together && last) last.ids.push(id);
		else runs.push({ ids: [id], endsRow: false });
	});
	for (const run of runs) {
		const framing = new Set(run.ids.flatMap((id) => framedBy.get(id) ?? []));
		run.endsRow = run.ids.some((id) => {
			const sub = dispatchOf.get(id);
			return (
				sub !== undefined &&
				treeOf(sub).some((entry) => framedBy.get(entry)?.some((i) => framing.has(i)))
			);
		});
	}
	// 行数按每行 MAX_ROW 个算出；再找出行数不变时最窄的行宽，让各行尽量一样多（不能窄过最长的那段注释框）。
	const rowsAt = (limit: number) => packRows(runs, limit);
	const fewest = rowsAt(MAX_ROW).length;
	const longest = Math.min(
		MAX_ROW,
		Math.max(1, ...runs.filter((r) => r.ids.length > 1).map((r) => r.ids.length)),
	);
	let limit = longest;
	while (limit < MAX_ROW && rowsAt(limit).length > fewest) limit += 1;

	const rows = rowsAt(limit);
	const framed = (row: readonly string[] | undefined) => !!row?.some((id) => framedBy.has(id));
	// 这一行是哪些有备注的注释框的第一行：框顶在这一行上面，要多留备注卡片的位置。
	const rowOf = new Map(rows.flatMap((row, i) => row.map((id) => [id, i] as const)));
	const notedFrom = new Set(
		annotations.flatMap((a) => {
			if (!a.note?.trim()) return [];
			const at = a.nodes.flatMap((id) => rowOf.get(id) ?? []);
			return at.length > 0 ? [Math.min(...at)] : [];
		}),
	);
	let y = 0;
	// 主链和它触发的子流程之后，剩下的链从哪一行开始。
	let restY = 0;
	rows.forEach((row, i) => {
		placeRow(row, 0, y);
		const below = y + NODE_SIZE.height + SUBFLOW_TOP_GAP;
		const next = placeSubflows(row, below);
		restY = next === below ? below : next;
		const gap =
			(framed(row) || framed(rows[i + 1]) ? ANNOTATION_ROW_GAP : 0) +
			(notedFrom.has(i + 1) ? ANNOTATION_NOTE.height + ANNOTATION_NOTE.gap : 0);
		// 子流程下面的下一行也一样多留：子流程区域下面隔着注释框的留白，再上去是下一行框外的标题和框里的备注卡片。
		y = (next === below ? y + MAIN_ROW : next) + gap;
	});

	// 没有被触发的子流程（以及其他入口节点的链），然后是不在任何链上的节点。
	for (const [start, members] of chains) {
		if (placed.has(start)) continue;
		const fresh = placeRow(members, 0, restY);
		if (fresh.length > 0) restY = placeSubflows(fresh, restY + SUBFLOW_ROW);
	}
	placeRow(
		doc.nodes.map((n) => n.id),
		0,
		restY,
	);

	return new Map(doc.nodes.map((n) => [n.id, placed.get(n.id) as Position]));
}

/** 落点与已有节点重叠时每次往右下错开的距离。 */
const NUDGE = 32;

/**
 * 没有来源的新节点放在哪：想要的位置（视口中心、右键处）空着就用它，
 * 压住已有节点时按固定步长往右下错开，直到不压住任何节点。位置都是卡片左上角的画布坐标。
 */
export function freePosition(wanted: Position, taken: readonly Position[]): Position {
	const overlaps = (p: Position) =>
		taken.some(
			(t) => Math.abs(t.x - p.x) < NODE_SIZE.width && Math.abs(t.y - p.y) < NODE_SIZE.height,
		);
	let at = wanted;
	while (overlaps(at)) at = { x: at.x + NUDGE, y: at.y + NUDGE };
	return at;
}

/**
 * 没有来源的新节点（视口中心、右键处）和粘贴的节点：卡片中心落在 `center`（画布坐标），
 * 压住已有节点时错开（freePosition）。返回卡片左上角。
 */
export const freeCardAt = (center: Position, taken: readonly Position[]): Position =>
	freePosition(
		{
			x: Math.round(center.x - NODE_SIZE.width / 2),
			y: Math.round(center.y - NODE_SIZE.height / 2),
		},
		taken,
	);

/**
 * 缺少布局的文档：有节点没有位置时，整份文档按整理布局重新排列（不混用两种布局，免得重叠）；
 * 所有节点都有位置时原样返回。
 */
export function ensureLayout<D extends LayoutDocument>(doc: D): D {
	if (doc.nodes.every((n) => n.position)) return doc;
	const layout = tidyLayout(doc);
	return { ...doc, nodes: doc.nodes.map((n) => ({ ...n, position: layout.get(n.id) })) } as D;
}

/**
 * 补坐标：没有位置的节点取整理布局给它算出的位置，已有位置的节点不动（控制面保存场景版本时用，
 * 命令行和 API 上传的节点可以不写坐标）。整理布局是按整份文档重排的结果，在已有坐标的链中间插入节点时
 * 它给的位置可能正好是某个已有节点的位置：压住已有节点（或本次已经放好的节点）时，
 * 用画布「添加节点」的同一套逻辑（freePosition）错开到附近的空位。所有节点都有位置时原样返回。
 */
export function fillMissingPositions<D extends LayoutDocument>(doc: D): D {
	if (doc.nodes.every((n) => n.position)) return doc;
	const layout = tidyLayout(doc);
	const taken: Position[] = doc.nodes.flatMap((n) => (n.position ? [n.position] : []));
	return {
		...doc,
		nodes: doc.nodes.map((n) => {
			if (n.position) return n;
			const position = freePosition(layout.get(n.id) as Position, taken);
			taken.push(position);
			return { ...n, position };
		}),
	} as D;
}
