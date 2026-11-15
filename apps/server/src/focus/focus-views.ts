import type { OrchestrationDocument } from "@sfly/schema";
import { type ChartView, type FocusItemView, NodeTypeMetadata } from "@sfly/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { orchestrationVersions } from "../db/schema.js";
import { nodeTypeOf } from "../metrics/node-types.js";
import { withDefaultCharts } from "../packages/default-charts.js";
import type { FocusItem } from "./focus-list.js";

/** 场景和它的最新版本号（0 表示还没有保存过版本）。 */
interface HeadRef {
	id: string;
	headVersion: number;
}

async function headDocument(db: Db, { id, headVersion }: HeadRef) {
	if (headVersion === 0) return undefined;
	const [row] = await db
		.select({ document: orchestrationVersions.document })
		.from(orchestrationVersions)
		.where(
			and(
				eq(orchestrationVersions.orchestrationId, id),
				eq(orchestrationVersions.number, headVersion),
			),
		);
	return row?.document;
}

/**
 * 文档里 `nodeId` 这个节点的节点类型声明的图表，含平台为没被图表引用的指标生成的默认图表；
 * 节点不是包节点、锁定的节点包版本找不到、或者元信息不合法时为 undefined。开发版本取节点所在 Agent 当前加载的源码。
 */
export async function declaredCharts(
	db: Db,
	document: OrchestrationDocument,
	nodeId: string,
): Promise<ChartView[] | undefined> {
	const node = document.nodes.find((n) => n.id === nodeId);
	if (node?.kind !== "package") return undefined;
	const ref = await nodeTypeOf(db, document, nodeId, node.agent ?? document.default_agent ?? null);
	const type = NodeTypeMetadata.safeParse(ref?.type);
	return type.success ? (withDefaultCharts(type.data).charts ?? []) : undefined;
}

/** 包含 `nodeId` 这个节点的最后一个版本号；没有任何版本包含它时为 null。 */
async function lastVersionWithNode(
	db: Db,
	orchestrationId: string,
	nodeId: string,
): Promise<number | null> {
	const [row] = await db
		.select({ number: orchestrationVersions.number })
		.from(orchestrationVersions)
		.where(
			and(
				eq(orchestrationVersions.orchestrationId, orchestrationId),
				sql`(${orchestrationVersions.document} -> 'nodes') @> ${JSON.stringify([{ id: nodeId }])}::jsonb`,
			),
		)
		.orderBy(desc(orchestrationVersions.number))
		.limit(1);
	return row?.number ?? null;
}

/**
 * 每个关注项和场景最新版本的对照（FocusItemView 的 `status`）：节点在不在，节点锁定的节点包版本有没有这张图表。
 * 顺序和 `items` 一致；状态每次读的时候对照得出，不存。
 */
export async function focusItemViews(
	db: Db,
	orchestration: HeadRef,
	items: readonly FocusItem[],
): Promise<FocusItemView[]> {
	if (items.length === 0) return [];
	const head = await headDocument(db, orchestration);
	const chartsByNode = new Map<string, Promise<ChartView[] | undefined>>();
	const chartsOf = (document: OrchestrationDocument, nodeId: string) => {
		const known = chartsByNode.get(nodeId);
		if (known) return known;
		const loading = declaredCharts(db, document, nodeId);
		chartsByNode.set(nodeId, loading);
		return loading;
	};
	return Promise.all(
		items.map(async (item): Promise<FocusItemView> => {
			const { node_id, chart } = item;
			const named = { node_id, chart, ...(item.title === undefined ? {} : { title: item.title }) };
			if (!head?.nodes.some((n) => n.id === node_id)) {
				const last_version = await lastVersionWithNode(db, orchestration.id, node_id);
				return { ...named, status: "node_missing", last_version };
			}
			const declared = (await chartsOf(head, node_id))?.find((c) => c.title === chart);
			return declared
				? { ...named, status: "ok", chart_type: declared.type }
				: { ...named, status: "chart_missing" };
		}),
	);
}
