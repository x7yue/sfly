import { type ChartView, NodeTypeMetadata, type PackageMetadata } from "@sfly/schema";
import { z } from "zod";

/** 节点包查询 API 返回的节点类型：图表含默认生成的图表。 */
export type NodeTypeView = Omit<NodeTypeMetadata, "charts"> & { charts?: ChartView[] };

/**
 * 给节点类型补上默认图表：没被任何声明的图表引用的指标各生成一张，
 * `gauge` 画折线，`counter` 画数值卡（带趋势）。没有声明指标和图表的节点类型原样返回。
 */
export function withDefaultCharts(node: NodeTypeMetadata): NodeTypeView {
	const metrics = node.metrics ?? [];
	const declared = node.charts ?? [];
	if (metrics.length === 0 && declared.length === 0) return node as NodeTypeView;
	const referenced = new Set(declared.flatMap((c) => c.metrics));
	const defaults: ChartView[] = metrics
		.filter((m) => !referenced.has(m.name))
		.map((m) => ({
			title: m.name,
			type: m.kind === "counter" ? "stat" : "line",
			metrics: [m.name],
			default: true,
		}));
	return { ...node, charts: [...declared.map((c) => ({ ...c, default: false })), ...defaults] };
}

export function packageWithDefaultCharts(
	metadata: PackageMetadata,
): Omit<PackageMetadata, "nodes"> & { nodes: NodeTypeView[] } {
	return { ...metadata, nodes: metadata.nodes.map(withDefaultCharts) };
}

const DevNodes = z.array(NodeTypeMetadata);

/**
 * Agent 上报的 dev 版本元信息（未经发布校验）：节点类型都合法时补上默认图表，否则原样返回。
 */
export function devMetadataWithDefaultCharts(
	metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
	const nodes = DevNodes.safeParse(metadata?.nodes);
	if (!metadata || !nodes.success) return metadata;
	return { ...metadata, nodes: nodes.data.map(withDefaultCharts) };
}
