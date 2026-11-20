import type { ChartView, FocusItemView, OrchestrationDocument } from "@sfly/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { orchestrationVersions } from "../db/schema.js";
import { declaredNodeType } from "../metrics/node-types.js";
import type { FocusItem } from "./focus-list.js";

/** 场景和它的最新版本号（0 表示还没有保存过版本）。 */
interface HeadRef {
	id: string;
	headVersion: number;
}

async function headDocument(db: Db | Tx, { id, headVersion }: HeadRef) {
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

/** 文档里 `nodeId` 这个节点的节点类型声明的图表，含默认图表；见 {@link declaredNodeType}。 */
export async function declaredCharts(
	db: Db | Tx,
	document: OrchestrationDocument,
	nodeId: string,
): Promise<ChartView[] | undefined> {
	const type = await declaredNodeType(db, document, nodeId);
	return type && (type.charts ?? []);
}

/** 包含 `nodeId` 这个节点的最后一个版本号；没有任何版本包含它时为 null。 */
async function lastVersionWithNode(
	db: Db | Tx,
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
 * 顺序和 `items` 一致；状态每次读的时候对照得出，不存。`db` 可能是事务（PATCH、归档），所以一条接一条地读，不并发
 * （CODING_STANDARDS「数据库」）。
 */
export async function focusItemViews(
	db: Db | Tx,
	orchestration: HeadRef,
	items: readonly FocusItem[],
): Promise<FocusItemView[]> {
	if (items.length === 0) return [];
	const head = await headDocument(db, orchestration);
	const chartsByNode = new Map<string, ChartView[] | undefined>();
	const views: FocusItemView[] = [];
	for (const item of items) {
		const { node_id, chart } = item;
		const named = { node_id, chart, ...(item.title === undefined ? {} : { title: item.title }) };
		if (!head?.nodes.some((n) => n.id === node_id)) {
			const last_version = await lastVersionWithNode(db, orchestration.id, node_id);
			views.push({ ...named, status: "node_missing", last_version });
			continue;
		}
		if (!chartsByNode.has(node_id)) {
			chartsByNode.set(node_id, await declaredCharts(db, head, node_id));
		}
		const declared = chartsByNode.get(node_id)?.find((c) => c.title === chart);
		views.push(
			declared
				? { ...named, status: "ok", chart_type: declared.type }
				: { ...named, status: "chart_missing" },
		);
	}
	return views;
}
