import { createRequire } from "node:module";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";

// 节点的超时、排队超时有上限（#476、#559）：保存接口拒绝更大的值，升级前保存的版本里可能已经有，
// 只能直接写库造出这样的历史版本。

/** pg 只装在 apps/server 里：从它的目录解析（e2e 不另加依赖）。 */
const { Client } = createRequire(new URL("../../server/package.json", import.meta.url))("pg") as {
	Client: new (config: {
		connectionString: string;
	}) => {
		connect(): Promise<void>;
		query<R>(sql: string, values: unknown[]): Promise<{ rows: R[] }>;
		end(): Promise<void>;
	};
};

/** 把场景所有版本里节点 `nodeId` 的 `field`（`timeout`、`queue_timeout`）改成 `value`（绕过保存的上限检查）。 */
export async function storeOverLimit(
	cp: TestControlPlane,
	scenario: string,
	nodeId: string,
	field: "timeout" | "queue_timeout",
	value: number,
): Promise<void> {
	const client = new Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const { rows } = await client.query<{
			id: string;
			document: { nodes: Array<Record<string, unknown>> };
		}>("select id, document from orchestration_versions where orchestration_id = $1", [scenario]);
		if (rows.length === 0) throw new Error(`场景 ${scenario} 没有版本`);
		for (const row of rows) {
			const node = row.document.nodes.find((n) => n.id === nodeId);
			if (!node) throw new Error(`场景 ${scenario} 的版本里没有节点 ${nodeId}`);
			node[field] = value;
			await client.query("update orchestration_versions set document = $1 where id = $2", [
				JSON.stringify(row.document),
				row.id,
			]);
		}
	} finally {
		await client.end();
	}
}
