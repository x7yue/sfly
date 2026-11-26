// 直接写库，造「这个运行、这个场景版本是哪个会话做的」的记录（`runs.session_id`、`orchestration_versions.session_id`）：
// 页面的端到端测试看运行页、版本历史上的「经 会话「…」」，不靠会话令牌的签发（签发和吊销由控制面的测试守着，#547）。
import pg from "pg";

async function withClient(
	databaseUrl: string,
	run: (client: pg.Client) => Promise<void>,
): Promise<void> {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		await run(client);
	} finally {
		await client.end();
	}
}

/** 这个运行是这个会话触发的（令牌的名称按控制面的写法「会话：<标题>」）。 */
export function recordRunSession(
	databaseUrl: string,
	runId: string,
	session: { id: string; title: string },
): Promise<void> {
	return withClient(databaseUrl, async (client) => {
		await client.query("update runs set session_id = $1, triggered_token = $2 where id = $3", [
			session.id,
			`会话：${session.title}`,
			runId,
		]);
	});
}

/** 这个场景的这个版本是这个会话保存的。 */
export function recordVersionSession(
	databaseUrl: string,
	scenarioId: string,
	version: number,
	session: { id: string; title: string },
): Promise<void> {
	return withClient(databaseUrl, async (client) => {
		await client.query(
			"update orchestration_versions set session_id = $1, author_token = $2 where orchestration_id = $3 and number = $4",
			[session.id, `会话：${session.title}`, scenarioId, version],
		);
	});
}
