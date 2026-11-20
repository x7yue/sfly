import pg from "pg";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * 已移除种类的节点（ADR 0028）留在历史数据里：场景版本不可修改、保存接口已经不收带它们的文档，只能直接写库
 * 造出「移除之前保存的版本」和「绑定在它上面的历史运行」。
 *
 * 场景：入口 → 等待（Sleep）→ 通知（`feishu_notify`，已移除）。第 1 版带这个通知节点；运行是绑定第 1 版、
 * 已经成功的历史运行，三个节点各有一条任务。
 */
export const IDS = {
	scenario: "00000000-0000-4000-8000-0000000000a1",
	version: "00000000-0000-4000-8000-0000000000a2",
	run: "00000000-0000-4000-8000-0000000000a3",
	chain: "00000000-0000-4000-8000-0000000000a4",
	tasks: {
		entry: "00000000-0000-4000-8000-0000000000b1",
		wait: "00000000-0000-4000-8000-0000000000b2",
		notify: "00000000-0000-4000-8000-0000000000b3",
	},
} as const;

/** 通知节点移除之前的配置：保存时补齐了默认值，全部写在文档里。 */
export const REMOVED_NODE = {
	id: "notify",
	kind: "feishu_notify",
	display_name: "通知群",
	position: { x: 504, y: 0 },
	always: true,
	bot: "ops",
	format: "text",
	text: "压测结束 ${{ params.env }}",
	at_all: false,
	title: "",
	color: "blue",
	markdown: "",
} as const;

/** 移除之前保存的文档（没有 sticky_notes 之类后来才有的字段也没关系：读出时补齐）。 */
export const LEGACY_DOCUMENT = {
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [{ name: "env", type: "string" }],
			position: { x: 0, y: 0 },
		},
		{ id: "wait", kind: "sleep", always: false, duration: "5s", position: { x: 252, y: 0 } },
		REMOVED_NODE,
	],
	edges: [
		{ from: "entry", to: "wait", kind: "chain" },
		{ from: "wait", to: "notify", kind: "chain" },
	],
	packages: {},
	annotations: [],
	sticky_notes: [],
} as const;

const AT = "2026-01-01T00:00:00Z";

/** 写入场景、第 1 版（带已移除的节点）和绑定它的历史运行。 */
export async function seedRemovedKindScenario(cp: TestControlPlane): Promise<typeof IDS> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		await client.query(
			"insert into orchestrations (id, name, description, head_version, created_at) values ($1, '移除之前的场景', '', 1, $2)",
			[IDS.scenario, AT],
		);
		await client.query(
			`insert into orchestration_versions (id, orchestration_id, number, document, author, created_at)
			values ($1, $2, 1, $3, '旧人', $4)`,
			[IDS.version, IDS.scenario, JSON.stringify(LEGACY_DOCUMENT), AT],
		);
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, triggered_by, params, status, started_at, ended_at)
			values ($1, $2, $3, '旧人', '{"env":"A"}', 'success', $4, $4)`,
			[IDS.run, IDS.scenario, IDS.version, AT],
		);
		await client.query(
			`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at, ended_at)
			values ($1, $2, 'entry', 0, '{"env":"A"}', 'success', $3, $3)`,
			[IDS.chain, IDS.run, AT],
		);
		const task = (id: string, node: string, inputs: unknown, outputs: unknown) =>
			client.query(
				`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, status, inputs, outputs, queued_at, started_at, ended_at)
				values ($1, $2, $3, $4, 1, 'success', $5, $6, $7, $7, $7)`,
				[id, IDS.run, IDS.chain, node, JSON.stringify(inputs), JSON.stringify(outputs), AT],
			);
		await task(IDS.tasks.entry, "entry", null, {});
		await task(IDS.tasks.wait, "wait", { duration: "5s" }, { triggered_at: AT });
		await task(IDS.tasks.notify, "notify", { bot: "ops", format: "text", text: "压测结束 A" }, {});
		return IDS;
	} finally {
		await client.end();
	}
}
