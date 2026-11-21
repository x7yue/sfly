import pg from "pg";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * 已移除种类的节点（ADR 0028）留在历史数据里：场景版本不可变、保存接口已经不收带它们的文档，只能直接写库
 * 造出「移除之前保存的版本」和「绑定在它上面的历史运行」。
 *
 * 场景：入口 → 等待（`sleep`）→ 定时（`timer`）→ 通知（`feishu_notify`），三种都是已移除的种类。第 1 版带着它们；
 * 运行是绑定第 1 版、已经成功的历史运行，四个节点各有一条任务。删掉三个已移除的节点之后只剩入口节点，
 * 是一个干净、不需要 Agent 的场景。
 */
export const IDS = {
	scenario: "00000000-0000-4000-8000-0000000000a1",
	version: "00000000-0000-4000-8000-0000000000a2",
	run: "00000000-0000-4000-8000-0000000000a3",
	chain: "00000000-0000-4000-8000-0000000000a4",
	tasks: {
		entry: "00000000-0000-4000-8000-0000000000b1",
		wait: "00000000-0000-4000-8000-0000000000b2",
		at: "00000000-0000-4000-8000-0000000000b3",
		notify: "00000000-0000-4000-8000-0000000000b4",
	},
} as const;

/** 等待节点（Sleep）移除之前的配置：保存时补齐了默认值，全部写在文档里。 */
export const REMOVED_WAIT = {
	id: "wait",
	kind: "sleep",
	display_name: "歇一会",
	position: { x: 252, y: 0 },
	always: false,
	duration: "5s",
} as const;

/** 定时节点移除之前的配置。 */
export const REMOVED_TIMER = {
	id: "at",
	kind: "timer",
	position: { x: 504, y: 0 },
	always: false,
	at: "09:30:00",
	tz: "Asia/Shanghai",
} as const;

/** 通知节点移除之前的配置。 */
export const REMOVED_NODE = {
	id: "notify",
	kind: "feishu_notify",
	display_name: "通知群",
	position: { x: 756, y: 0 },
	always: true,
	bot: "ops",
	format: "text",
	text: "压测结束 ${{ params.env }}",
	at_all: false,
	title: "",
	color: "blue",
	markdown: "",
} as const;

/** 三个已移除的节点，按它们在链上的顺序。 */
export const REMOVED_NODES = [REMOVED_WAIT, REMOVED_TIMER, REMOVED_NODE] as const;

/** 移除之前保存的文档：和那时每个版本一样带着空的 `sticky_notes`（便签，读出时去掉）。 */
export const LEGACY_DOCUMENT = {
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [{ name: "env", type: "string" }],
			position: { x: 0, y: 0 },
		},
		...REMOVED_NODES,
	],
	edges: [
		{ from: "entry", to: "wait", kind: "chain" },
		{ from: "wait", to: "at", kind: "chain" },
		{ from: "at", to: "notify", kind: "chain" },
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
			"insert into orchestrations (id, project_id, name, description, head_version, created_at) values ($1, 'default', '移除之前的场景', '', 1, $2)",
			[IDS.scenario, AT],
		);
		await client.query(
			`insert into orchestration_versions (id, orchestration_id, number, document, author, created_at)
			values ($1, $2, 1, $3, '旧人', $4)`,
			[IDS.version, IDS.scenario, JSON.stringify(LEGACY_DOCUMENT), AT],
		);
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at, ended_at)
			values ($1, $2, $3, 'default', '旧人', '{"env":"A"}', 'success', $4, $4)`,
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
		await task(
			IDS.tasks.at,
			"at",
			{ at: "09:30:00", tz: "Asia/Shanghai" },
			{ triggered_at: AT, late: false },
		);
		await task(IDS.tasks.notify, "notify", { bot: "ops", format: "text", text: "压测结束 A" }, {});
		return IDS;
	} finally {
		await client.end();
	}
}

/** 一个正在运行的运行停在已移除的等待节点上：升级前开始、升级时它还在 `waiting`（唤醒它的扫描已经没有了）。 */
export const WAITING = {
	scenario: "00000000-0000-4000-8000-0000000000c1",
	version: "00000000-0000-4000-8000-0000000000c2",
	run: "00000000-0000-4000-8000-0000000000c3",
	chain: "00000000-0000-4000-8000-0000000000c4",
	tasks: {
		entry: "00000000-0000-4000-8000-0000000000d1",
		wait: "00000000-0000-4000-8000-0000000000d2",
	},
} as const;

/**
 * 写入这样的运行：入口 → 等待（`sleep`，任务在 `waiting`）→ 包节点 `after`（还没开始）。
 * 包节点用 stub@1.0.0（调用方先发布），默认 Agent 是 agent-a。
 */
export async function seedWaitingSleepRun(cp: TestControlPlane): Promise<typeof WAITING> {
	const document = {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } },
			{ ...REMOVED_WAIT, position: { x: 252, y: 0 } },
			{
				id: "after",
				kind: "package",
				package: "stub",
				node: "echo",
				inputs: {},
				position: { x: 504, y: 0 },
			},
		],
		edges: [
			{ from: "entry", to: "wait", kind: "chain" },
			{ from: "wait", to: "after", kind: "chain" },
		],
		packages: { stub: "1.0.0" },
		annotations: [],
		sticky_notes: [],
	};
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		await client.query(
			"insert into orchestrations (id, project_id, name, description, head_version, created_at) values ($1, 'default', '停在等待节点上的场景', '', 1, $2)",
			[WAITING.scenario, AT],
		);
		await client.query(
			`insert into orchestration_versions (id, orchestration_id, number, document, author, created_at)
			values ($1, $2, 1, $3, '旧人', $4)`,
			[WAITING.version, WAITING.scenario, JSON.stringify(document), AT],
		);
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
			values ($1, $2, $3, 'default', '旧人', '{}', 'running', $4)`,
			[WAITING.run, WAITING.scenario, WAITING.version, AT],
		);
		await client.query(
			`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at)
			values ($1, $2, 'entry', 0, '{}', 'running', $3)`,
			[WAITING.chain, WAITING.run, AT],
		);
		await client.query(
			`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, status, inputs, outputs, queued_at, started_at, ended_at)
			values ($1, $2, $3, 'entry', 1, 'success', null, '{}', $4, $4, $4)`,
			[WAITING.tasks.entry, WAITING.run, WAITING.chain, AT],
		);
		await client.query(
			`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, status, inputs, queued_at, started_at)
			values ($1, $2, $3, 'wait', 1, 'waiting', '{"duration":"5s"}', $4, $4)`,
			[WAITING.tasks.wait, WAITING.run, WAITING.chain, AT],
		);
		return WAITING;
	} finally {
		await client.end();
	}
}

/** 升级时同一个运行里有两个停在已移除节点上的运行：主链上的 Sleep 和子流程里的定时节点（子流程里的更晚写入）。 */
export const RACE = {
	scenario: "00000000-0000-4000-8000-0000000000e1",
	version: "00000000-0000-4000-8000-0000000000e2",
	run: "00000000-0000-4000-8000-0000000000e3",
	main: "00000000-0000-4000-8000-0000000000e4",
	sub: "00000000-0000-4000-8000-0000000000e5",
	tasks: {
		entry: "00000000-0000-4000-8000-0000000000f1",
		spawn: "00000000-0000-4000-8000-0000000000f2",
		wait: "00000000-0000-4000-8000-0000000000f3",
		subEntry: "00000000-0000-4000-8000-0000000000f4",
		nap: "00000000-0000-4000-8000-0000000000f5",
	},
} as const;

/**
 * 写入这样的运行：主链 入口 → 异步任务 `spawn` → Sleep `wait`（`waiting`）→ 总是执行的停止子流程节点 `stop`（停止
 * 子流程 `sub`，还没开始）；子流程 `sub` 里入口 → 定时节点 `nap`（`waiting`，任务序号比 `wait` 大）。
 * 重启后先处理 `wait`：它失败，总是执行的 `stop` 把子流程停掉，`nap` 因此应当是「已停止」，不是「失败」。
 */
export async function seedWaitingRaceRun(cp: TestControlPlane): Promise<typeof RACE> {
	const document = {
		nodes: [
			{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } },
			{ id: "spawn", kind: "async", params: {}, position: { x: 252, y: 0 } },
			{ ...REMOVED_WAIT, position: { x: 504, y: 0 } },
			{
				id: "stop",
				kind: "stop_subflow",
				subflow: "sub",
				always: true,
				position: { x: 756, y: 0 },
			},
			{ id: "sub", kind: "subflow_entry", name: "sub", params: [], position: { x: 252, y: 200 } },
			{
				id: "nap",
				kind: "timer",
				at: "09:30:00",
				tz: "Asia/Shanghai",
				position: { x: 504, y: 200 },
			},
		],
		edges: [
			{ from: "entry", to: "spawn", kind: "chain" },
			{ from: "spawn", to: "wait", kind: "chain" },
			{ from: "wait", to: "stop", kind: "chain" },
			{ from: "spawn", to: "sub", kind: "dispatch" },
			{ from: "sub", to: "nap", kind: "chain" },
		],
		packages: {},
		annotations: [],
		sticky_notes: [],
	};
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		await client.query(
			"insert into orchestrations (id, project_id, name, description, head_version, created_at) values ($1, 'default', '两个停在已移除节点上的场景', '', 1, $2)",
			[RACE.scenario, AT],
		);
		await client.query(
			`insert into orchestration_versions (id, orchestration_id, number, document, author, created_at)
			values ($1, $2, 1, $3, '旧人', $4)`,
			[RACE.version, RACE.scenario, JSON.stringify(document), AT],
		);
		await client.query(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
			values ($1, $2, $3, 'default', '旧人', '{}', 'running', $4)`,
			[RACE.run, RACE.scenario, RACE.version, AT],
		);
		await client.query(
			`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at)
			values ($1, $2, 'entry', 0, '{}', 'running', $3)`,
			[RACE.main, RACE.run, AT],
		);
		await client.query(
			`insert into chain_instances (id, run_id, chain_id, parent_chain_instance_id, async_node_id, depth, params, status, started_at)
			values ($1, $2, 'sub', $3, 'spawn', 1, '{}', 'running', $4)`,
			[RACE.sub, RACE.run, RACE.main, AT],
		);
		const task = (id: string, chain: string, node: string, status: string, inputs: unknown) =>
			client.query(
				`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, status, inputs, outputs, queued_at, started_at, ended_at)
				values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $8, $9)`,
				[
					id,
					RACE.run,
					chain,
					node,
					status,
					inputs === null ? null : JSON.stringify(inputs),
					status === "success" ? "{}" : null,
					AT,
					status === "success" ? AT : null,
				],
			);
		await task(RACE.tasks.entry, RACE.main, "entry", "success", null);
		await task(RACE.tasks.spawn, RACE.main, "spawn", "success", {});
		await task(RACE.tasks.wait, RACE.main, "wait", "waiting", { duration: "5s" });
		await task(RACE.tasks.subEntry, RACE.sub, "sub", "success", null);
		await task(RACE.tasks.nap, RACE.sub, "nap", "waiting", { at: "09:30:00", tz: "Asia/Shanghai" });
		return RACE;
	} finally {
		await client.end();
	}
}
