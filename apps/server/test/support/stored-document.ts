import type { OrchestrationDocument } from "@sfly/schema";
import pg from "pg";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * 场景版本在库里存的文档（原样，没有经过任何接口）。读取接口给 secret 参数的默认值打码之后，
 * 测试要确认「保存时沿用了原值」只能直接看库：接口读出来的永远是打码后的。`number` 不给时取最新版本。
 */
export async function storedDocument(
	cp: TestControlPlane,
	scenario: string,
	number?: number,
): Promise<OrchestrationDocument> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const { rows } = await client.query<{ document: OrchestrationDocument }>(
			`select v.document from orchestration_versions v
			join orchestrations o on o.id = v.orchestration_id
			where v.orchestration_id = $1 and v.number = coalesce($2::int, o.head_version)`,
			[scenario, number ?? null],
		);
		if (rows.length !== 1) throw new Error(`场景 ${scenario} 没有版本 ${number ?? "（最新）"}`);
		return (rows[0] as { document: OrchestrationDocument }).document;
	} finally {
		await client.end();
	}
}

/** 文档里某个入口节点（entry 或 subflow_entry）声明的参数。 */
export function paramsOf(
	document: OrchestrationDocument,
	nodeId = "entry",
): Array<Record<string, unknown>> {
	const node = document.nodes.find((n) => n.id === nodeId);
	if (node?.kind !== "entry" && node?.kind !== "subflow_entry") {
		throw new Error(`${nodeId} 不是入口节点`);
	}
	return node.params;
}
