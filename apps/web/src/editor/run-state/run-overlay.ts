import type { ChainRunView, NodeRunView, RunView } from "@sfly/schema";
import type { EdgeDecoration, NodeRunState } from "#/components/canvas/context";
import type { SfEdge } from "#/components/canvas/flow";
import { NODE_STATUS } from "#/lib/node-status";
import { orderedChains } from "#/monitor/run-model";

/**
 * 画布「运行状态」模式（#41）的纯逻辑：把运行视图整理成按节点 ID 查询的叠加信息，
 * 供 FlowCanvas 的 decorateNode / decorateEdge / regionMeta 与运行状态检查器使用。
 */

export interface NodeRunSummary {
	/** 节点所在的链实例（子流程有多个实例时取第一个，与监控页 `?node=` 定位的实例一致）。 */
	chain: ChainRunView;
	node: NodeRunView;
	state: NodeRunState;
	/** 这个节点在运行里出现在几个链实例上（子流程实例数）。 */
	instances: number;
}

export interface RunOverlay {
	node(id: string): NodeRunSummary | undefined;
	edge(edge: { from: string; to: string; kind: "chain" | "dispatch" }): EdgeDecoration | undefined;
	/** 某个链起点（子流程入口）的所有实例，按层级与开始时间排列；没有触发过时为空。 */
	instances(chainId: string): ChainRunView[];
	/** 执行中的节点（准备中也算），按节点 ID 排序：执行前沿，跟随执行框住它们。 */
	running: readonly string[];
}

export function runOverlay(run: RunView): RunOverlay {
	const chains = orderedChains(run);
	const nodes = new Map<string, NodeRunSummary>();
	for (const chain of chains) {
		for (const node of chain.nodes) {
			const seen = nodes.get(node.node_id);
			if (seen) seen.instances += 1;
			else
				nodes.set(node.node_id, {
					chain,
					node,
					state: NODE_STATUS[node.status].canvas,
					instances: 1,
				});
		}
	}
	return {
		node: (id) => nodes.get(id),
		edge: ({ from, to, kind }) => {
			if (kind === "dispatch") {
				// 调度连线：子流程还有实例在运行时是青色虚线，结束了（或没有触发）就变灰，青色只留给正在发生的调度。
				return chains.some((c) => c.chain_id === to && c.status === "running") ? "live" : "ended";
			}
			// 线路图：走过的路段变亮，还没走到的暗下去，进入执行中 / 失败 / 等待中节点的那一段着状态色。
			if (nodes.get(from)?.state !== "done") return "ahead";
			const target = nodes.get(to)?.state;
			if (target === "running") return "live";
			if (target === "failed") return "failed";
			if (target === "waiting") return "waiting";
			if (target === "done" || target === "stopped") return "travelled";
			return "ahead";
		},
		instances: (chainId) => chains.filter((c) => c.chain_id === chainId),
		running: [...nodes]
			.filter(([, summary]) => summary.state === "running")
			.map(([id]) => id)
			.sort(),
	};
}

/** 连线的流动状态（画布上的连线 ID，见 `edgeId`）。 */
export interface EdgeFlow {
	/** 进入执行中节点的连线：静止的青色实线。 */
	readonly live: ReadonlySet<string>;
	/** `live` 里刚变成执行中的连线：虚线流动两遍后停下（样式在 CSS 里，这里一直留到它不再是执行中）。 */
	readonly entering: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

/** 画布上进入执行中节点的连线。 */
export function liveEdgeIds(overlay: RunOverlay, edges: readonly SfEdge[]): ReadonlySet<string> {
	return new Set(
		edges
			.filter(
				(e) =>
					overlay.edge({ from: e.source, to: e.target, kind: e.data?.kind ?? "chain" }) === "live",
			)
			.map((e) => e.id),
	);
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
	a.size === b.size && [...a].every((id) => b.has(id));

/**
 * 看到新的运行视图之后的连线流动状态：只有看着它变成执行中的连线才流动，所以动画只出现在执行推进的那一刻。
 * `before` 是上一次看到的状态；没有（刚打开页面、刚切回运行状态）时进入执行中的连线只记下来、不流动。
 * 流动的连线留在 `entering` 里，直到它不再是执行中：中途拿掉样式会掐断还没播完的动画。
 * 什么都没变时返回 `before` 本身。
 */
export function nextEdgeFlow(before: EdgeFlow | null, live: ReadonlySet<string>): EdgeFlow {
	if (!before) return { live, entering: NONE };
	const entering = new Set([...before.entering].filter((id) => live.has(id)));
	for (const id of live) if (!before.live.has(id)) entering.add(id);
	return sameSet(before.live, live) && sameSet(before.entering, entering)
		? before
		: { live, entering };
}

/** 节点耗时（毫秒）：第一次尝试开始到最后一次尝试结束，还没结束的算到 now；没有开始过时为 null。 */
export function nodeElapsed(node: NodeRunView, now: number): number | null {
	const started = node.attempts.flatMap((a) => (a.started_at ? [Date.parse(a.started_at)] : []));
	if (started.length === 0) return null;
	const last = node.attempts.at(-1);
	const end = last?.ended_at ? Date.parse(last.ended_at) : now;
	return Math.max(0, end - Math.min(...started));
}

/**
 * 卡片上的失败原因去掉开头的异常类名（`AssertionError: 漏拦 3 笔` → `漏拦 3 笔`）：卡片和站外一行只放得下
 * 十来个字，类名会占掉最有用的那一段；带类名的原文在悬停提示和检查器里。只有类名、或者类名不在开头时保留原文。
 */
export const withoutErrorClass = (reason: string) =>
	reason.replace(/^[A-Za-z_][\w.]*(?:Error|Exception)\s*[:：]\s*(?=\S)/, "");
