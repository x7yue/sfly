import type { LastRunNodeStatus, OrchestrationStructure } from "@sfly/schema";
import type { StatusKind } from "#/components/status";
import { NODE_STATUS } from "#/lib/node-status";

/**
 * 场景卡片的缩略图布局（原型 thumbSVG）：按文档结构而不是画布坐标绘制——主链按连线顺序蛇形排列，
 * 每个子流程在主链下方占一行、画在子流程区域里，调度连线从异步任务节点连到子流程入口。
 * 节点按最近一次运行的状态着色。纯函数，坐标单位是 SVG viewBox 的单位（宽 THUMB_WIDTH）。
 */

export const THUMB_WIDTH = 300;

export interface ThumbNode {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	/** 最近一次运行里这个节点的状态种类（颜色与形状见 components/status 的 STATUS）。 */
	state: StatusKind;
}

export interface ThumbLine {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface ThumbRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Thumbnail {
	width: number;
	height: number;
	nodes: ThumbNode[];
	/** 链上的顺序连线。 */
	links: ThumbLine[];
	/** 子流程区域。 */
	regions: ThumbRect[];
	/** 调度连线（SVG path 的 d）。 */
	dispatches: string[];
}

const NODE_H = 18;
const ROW_GAP = 14;
const SUB_SCALE = 0.8;
const SUB_GAP = 6;
const REGION_PAD = 8;
const TOP = 4;

/** 从起点沿链上的连线走到底（遇到环就停下）。 */
function chainFrom(start: string, next: Map<string, string>): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (let id: string | undefined = start; id !== undefined && !seen.has(id); id = next.get(id)) {
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

export function layoutThumbnail(
	structure: OrchestrationStructure,
	nodeStates: Record<string, LastRunNodeStatus> | null,
): Thumbnail {
	const kinds = new Map(structure.nodes.map((n) => [n.id, n.kind]));
	const next = new Map<string, string>();
	const dispatchOf = new Map<string, string>();
	for (const e of structure.edges) {
		if (!kinds.has(e.from) || !kinds.has(e.to)) continue;
		if (e.kind === "chain") {
			if (!next.has(e.from)) next.set(e.from, e.to);
		} else dispatchOf.set(e.to, e.from);
	}
	const state = (id: string): StatusKind => NODE_STATUS[nodeStates?.[id] ?? "pending"].kind;

	const entry = structure.nodes.find((n) => n.kind === "entry");
	const main = entry ? chainFrom(entry.id, next) : [];
	const subflows = structure.nodes
		.filter((n) => n.kind === "subflow_entry")
		.map((n) => chainFrom(n.id, next));

	const nodes: ThumbNode[] = [];
	const links: ThumbLine[] = [];
	const at = new Map<string, ThumbNode>();
	const place = (node: ThumbNode) => {
		nodes.push(node);
		at.set(node.id, node);
	};

	// 主链：蛇形排列，奇数行从右往左；换行处上下对齐，用竖线相连。
	const n = main.length;
	const perRow = n > 10 ? 9 : 5;
	const gap = n > 10 ? 8 : 16;
	const nodeW = Math.min(44, (THUMB_WIDTH - (perRow - 1) * gap) / perRow);
	const cols = Math.max(1, Math.min(n, perRow));
	const left = (THUMB_WIDTH - (cols * nodeW + (cols - 1) * gap)) / 2;
	main.forEach((id, i) => {
		const row = Math.floor(i / perRow);
		const col = row % 2 === 0 ? i % perRow : cols - 1 - (i % perRow);
		place({
			id,
			x: left + col * (nodeW + gap),
			y: TOP + row * (NODE_H + ROW_GAP),
			w: nodeW,
			h: NODE_H,
			state: state(id),
		});
	});
	const rows = Math.ceil(n / perRow);
	let y = TOP + rows * (NODE_H + ROW_GAP) - ROW_GAP;

	// 子流程：每个一行，缩小后居中，外面是子流程区域。
	const regions: ThumbRect[] = [];
	const subH = NODE_H * SUB_SCALE;
	for (const chain of subflows) {
		const len = chain.length;
		const w = Math.min(
			nodeW * SUB_SCALE,
			(THUMB_WIDTH - 2 * REGION_PAD - (len - 1) * SUB_GAP) / len,
		);
		const total = len * w + (len - 1) * SUB_GAP;
		const x0 = (THUMB_WIDTH - total) / 2;
		const top = y + 12;
		regions.push({ x: x0 - REGION_PAD, y: top, w: total + 2 * REGION_PAD, h: subH + 10 });
		chain.forEach((id, i) => {
			place({ id, x: x0 + i * (w + SUB_GAP), y: top + 5, w, h: subH, state: state(id) });
		});
		y = top + subH + 10;
	}

	for (const chain of [main, ...subflows]) {
		for (let i = 0; i + 1 < chain.length; i++) {
			const a = at.get(chain[i] as string) as ThumbNode;
			const b = at.get(chain[i + 1] as string) as ThumbNode;
			if (a.y === b.y) {
				const [l, r] = a.x < b.x ? [a, b] : [b, a];
				links.push({ x1: l.x + l.w, y1: a.y + a.h / 2, x2: r.x, y2: b.y + b.h / 2 });
			} else {
				const cx = a.x + a.w / 2;
				links.push({ x1: cx, y1: a.y + a.h, x2: cx, y2: b.y });
			}
		}
	}

	const dispatches: string[] = [];
	for (const chain of subflows) {
		const target = at.get(chain[0] as string);
		const source = at.get(dispatchOf.get(chain[0] as string) ?? "");
		if (!target || !source) continue;
		const x1 = source.x + source.w / 2;
		const y1 = source.y + source.h;
		const x2 = target.x + target.w / 2;
		const y2 = target.y;
		const mid = (y1 + y2) / 2;
		dispatches.push(`M${x1} ${y1} C${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`);
	}

	return { width: THUMB_WIDTH, height: Math.max(y + TOP, 40), nodes, links, regions, dispatches };
}
