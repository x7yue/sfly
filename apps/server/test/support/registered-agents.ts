import pg from "pg";

/**
 * 直接写库登记几台 Agent（离线，从没连上过也一样）：场景派发到它们时保存不再带「还没有注册过」的警告（#500）。
 * 测试里要的是「这个项目里有这些 Agent」，不是真的连一台上来；已登记的名字不动。
 */
export async function registerAgents(
	databaseUrl: string,
	names: readonly string[],
	project = "default",
): Promise<void> {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		for (const name of names) {
			await client.query(
				`insert into agents (name, project_id, info, status, registered_at, last_seen_at)
				values ($1, $2, '{"agent_version":"1.0.0","os":"linux","arch":"x86_64","slots":1}', 'offline', $3, $3)
				on conflict (name) do nothing`,
				[name, project, "2026-01-01T00:00:00Z"],
			);
		}
	} finally {
		await client.end();
	}
}
