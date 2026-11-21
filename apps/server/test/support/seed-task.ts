import { randomUUID } from "node:crypto";
import pg from "pg";
import { ApiClient } from "./api-client.js";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * 直接写库种一个任务（不经过引擎和 Agent）：默认项目里的一个场景、绑定它的一个运行、一个链实例，和一个派给 `agent` 的任务。
 * 测试里要的是「某台 Agent 手上有这样一个任务」，不是真的把它跑起来。
 */
export async function seedTask(
	cp: TestControlPlane,
	options: { agent: string; status: "running" | "success" },
): Promise<{ run: string; task: string }> {
	const scenario = await new ApiClient(cp).orchestrationWith({
		nodes: [{ id: "entry", kind: "entry", params: [] }],
		edges: [],
		packages: {},
	});
	const run = randomUUID();
	const chain = randomUUID();
	const task = randomUUID();
	const at = "2026-01-01T00:00:00Z";
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		await client.query(
			`insert into agents (name, project_id, info, status, registered_at, last_seen_at)
			values ($1, 'default', '{"agent_version":"0.5.0","os":"linux","arch":"x86_64","slots":2}', 'offline', $2, $2)
			on conflict (name) do nothing`,
			[options.agent, at],
		);
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
			select $1, orchestration_id, id, 'default', '测试', '{}', 'running', $2
			from orchestration_versions where orchestration_id = $3`,
			[run, at, scenario],
		);
		await client.query(
			`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at)
			values ($1, $2, 'entry', 0, '{}', 'running', $3)`,
			[chain, run, at],
		);
		await client.query(
			`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, agent_name, status, queued_at, started_at)
			values ($1, $2, $3, 'a', 1, $4, $5, $6, $6)`,
			[task, run, chain, options.agent, options.status, at],
		);
	} finally {
		await client.end();
	}
	return { run, task };
}
