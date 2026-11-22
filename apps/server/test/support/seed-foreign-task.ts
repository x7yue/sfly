import { randomUUID } from "node:crypto";
import pg from "pg";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * 直接写库种一个「别的项目」的任务（不经过引擎和 Agent）：新建项目 `project`，里面一个场景、绑定它的运行和一个派给
 * `agent` 的、正占着槽位（`status`）的任务。测试要的是「这台 Agent 的槽位被别的项目的任务占着」，不是真的把它跑起来。
 */
export async function seedForeignTask(
	cp: TestControlPlane,
	options: {
		project: string;
		agent: string;
		status?: "running" | "dispatched";
		scenarioName?: string;
	},
): Promise<{ run: string; task: string; scenario: string }> {
	const scenario = randomUUID();
	const version = randomUUID();
	const run = randomUUID();
	const chain = randomUUID();
	const task = randomUUID();
	const at = "2026-01-01T00:00:00Z";
	const document = {
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "a", kind: "package", package: "stub", node: "echo", display_name: "别人的节点" },
		],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { stub: "1.0.0" },
		annotations: [],
	};
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		await client.query(
			"insert into projects (id, display_name, created_at) values ($1, $1, $2) on conflict (id) do nothing",
			[options.project, at],
		);
		await client.query(
			"insert into orchestrations (id, project_id, name, description, head_version, created_at) values ($1, $2, $3, '', 1, $4)",
			[scenario, options.project, options.scenarioName ?? "别的项目的场景", at],
		);
		await client.query(
			`insert into orchestration_versions (id, orchestration_id, number, document, author, created_at)
			values ($1, $2, 1, $3, '别人', $4)`,
			[version, scenario, JSON.stringify(document), at],
		);
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
			values ($1, $2, $3, $4, '别人', '{}', 'running', $5)`,
			[run, scenario, version, options.project, at],
		);
		await client.query(
			`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at)
			values ($1, $2, 'entry', 0, '{}', 'running', $3)`,
			[chain, run, at],
		);
		await client.query(
			`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, agent_name, status, queued_at, started_at)
			values ($1, $2, $3, 'a', 1, $4, $5, $6, $6)`,
			[task, run, chain, options.agent, options.status ?? "running", at],
		);
	} finally {
		await client.end();
	}
	return { run, task, scenario };
}
