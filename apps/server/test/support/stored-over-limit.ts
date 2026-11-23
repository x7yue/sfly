import pg from "pg";

/**
 * 绕过保存校验，把场景已保存的版本里节点 `nodeId` 的 `field` 改成 `value`：模拟升级前保存的版本
 * （节点的超时、排队超时有上限，保存接口拒绝更大的值，#476、#559；库里可以已经有）。
 * `number` 给了就只改这一个版本，不给改全部版本。控制面缓存过版本文档的话，改完要重启它。
 */
export async function storeNodeField(
	databaseUrl: string,
	orchestrationId: string,
	nodeId: string,
	field: "timeout" | "queue_timeout",
	value: unknown,
	number?: number,
): Promise<void> {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const { rows } = await client.query<{
			id: string;
			document: { nodes: Array<Record<string, unknown>> };
		}>(
			"select id, document from orchestration_versions where orchestration_id = $1 and ($2::int is null or number = $2)",
			[orchestrationId, number ?? null],
		);
		if (rows.length === 0) throw new Error(`场景 ${orchestrationId} 没有要改的版本`);
		for (const row of rows) {
			const node = row.document.nodes.find((n) => n.id === nodeId);
			if (!node) throw new Error(`场景 ${orchestrationId} 的版本里没有节点 ${nodeId}`);
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
