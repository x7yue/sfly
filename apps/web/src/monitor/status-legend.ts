import type { StatusKind } from "#/components/status";
import { nodeStatusView } from "#/components/status";
import { NODE_STATUS } from "#/lib/node-status";

/**
 * 概览「链路」区的状态图例：线路上每个节点只有一个小圆点（颜色加形状），图例写明每个形状是什么状态。
 * 只列这一次运行里出现过的状态，顺序和时间线的图例一致（完成、执行中、失败、等待、排队、取消、停止），再接上线路上才有的
 * 已跳过、待执行。「准备中」和「执行中」在线路上是同一个圆点（都是在跑），图例里合成一项，写「执行中、准备中」（只有一种时只写那一种）；
 * 节点自己的提示和读屏名称里各写各的。
 */
const ORDER: StatusKind[] = [
	"ok",
	"running",
	"failed",
	"warn",
	"queued",
	"cancelled",
	"stopped",
	"skipped",
	"pending",
];

/** 同一个圆点的几个状态：这里的先后就是图例里的先后。 */
const SAME_DOT: Partial<Record<StatusKind, string[]>> = {
	running: [NODE_STATUS.running.label, NODE_STATUS.dispatched.label],
};

export interface LegendEntry {
	kind: StatusKind;
	label: string;
}

/** 这些节点状态（`NodeStatus`）对应的图例：每个圆点一项，按固定顺序。 */
export function statusLegend(statuses: Iterable<string>): LegendEntry[] {
	const labels = new Map<StatusKind, Set<string>>();
	for (const status of statuses) {
		const view = nodeStatusView(status);
		labels.set(view.kind, (labels.get(view.kind) ?? new Set<string>()).add(view.label));
	}
	return ORDER.flatMap((kind) => {
		const present = labels.get(kind);
		if (!present) return [];
		const known = SAME_DOT[kind] ?? [];
		const names = [
			...known.filter((label) => present.has(label)),
			...[...present].filter((label) => !known.includes(label)),
		];
		return [{ kind, label: names.join("、") }];
	});
}
