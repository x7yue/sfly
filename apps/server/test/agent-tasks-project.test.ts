// Agent 列表里每台 Agent 的「正在做的任务」「排队的任务」只列读者项目里的，别的项目的只给个数（#500）：
// 派发只用场景所在项目的 Agent，正常情况下不会有别的项目的任务在一台 Agent 上（升级之前派发的、库里手工改的），这里直接写库造出来。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentHub } from "../src/agents/agent-hub.js";
import { type Database, openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT, type ProjectId } from "../src/projects/project-id.js";
import { AsyncQueue } from "../src/util/async-queue.js";
import { Mutex } from "../src/util/mutex.js";
import { ManualClock } from "./support/manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const BETA = "beta" as ProjectId;
const AT = "2026-01-01T00:00:00Z";
const DOCUMENT = {
	default_agent: "agent-b",
	nodes: [{ id: "entry", kind: "entry", params: [] }],
	edges: [],
	packages: {},
};
const INFO = { agent_version: "1.0.0", os: "linux", arch: "x86_64", slots: 4 };

describe("Agent 列表的任务名单按读者的项目过滤（#500）", () => {
	let testDb: TestDatabase;
	let database: Database;
	let hub: AgentHub;
	/** 默认项目（项目甲）在项目乙的 Agent 上的任务：场景名、运行编号、节点名、任务编号都不能出现在项目乙读到的列表里。 */
	const secret = {
		scenario: "项目甲的私有场景",
		run: crypto.randomUUID(),
		nodeRunning: "alpha_running_node",
		nodeQueued: "alpha_queued_node",
		taskRunning: crypto.randomUUID(),
		taskQueued: crypto.randomUUID(),
	};
	const own = { run: crypto.randomUUID(), task: crypto.randomUUID() };

	/** 在 `project` 里建一个场景、它的版本和一个运行中的运行，返回链实例的 ID。 */
	async function runIn(project: ProjectId, name: string, run: string): Promise<string> {
		const scenario = crypto.randomUUID();
		const version = crypto.randomUUID();
		const chain = crypto.randomUUID();
		const q = (sql: string, params: unknown[]) => database.pool.query(sql, params);
		await q(
			"insert into orchestrations (id, name, project_id, head_version, created_at) values ($1, $2, $3, 1, $4)",
			[scenario, name, project, AT],
		);
		await q(
			"insert into orchestration_versions (id, orchestration_id, number, document, author, created_at) values ($1, $2, 1, $3, '测试', $4)",
			[version, scenario, JSON.stringify(DOCUMENT), AT],
		);
		await q(
			`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
			values ($1, $2, $3, $4, '测试', '{}', 'running', $5)`,
			[run, scenario, version, project, AT],
		);
		await q(
			`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at)
			values ($1, $2, 'entry', 0, '{}', 'running', $3)`,
			[chain, run, AT],
		);
		return chain;
	}
	const task = (id: string, run: string, chain: string, node: string, status: string) =>
		database.pool.query(
			`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, agent_name, status, queued_at, started_at)
			values ($1, $2, $3, $4, 1, 'agent-b', $5, $6, $7)`,
			[id, run, chain, node, status, AT, status === "queued" ? null : AT],
		);

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		await database.pool.query(
			"insert into projects (id, display_name, created_at) values ($1, '项目乙', $2)",
			[BETA, AT],
		);
		hub = new AgentHub({
			db: database.db,
			clock: new ManualClock(AT),
			mutex: new Mutex(),
			version: "1.0.0",
		});
		await hub.attach(BETA, "agent-b", INFO, new AsyncQueue());
		const alpha = await runIn(DEFAULT_PROJECT, secret.scenario, secret.run);
		await task(secret.taskRunning, secret.run, alpha, secret.nodeRunning, "running");
		await task(secret.taskQueued, secret.run, alpha, secret.nodeQueued, "queued");
		const beta = await runIn(BETA, "项目乙的场景", own.run);
		await task(own.task, own.run, beta, "beta_node", "running");
	});
	afterAll(async () => {
		hub.closeAll();
		await database.close();
		await testDb.drop();
	});

	it("项目乙读到自己的任务，项目甲的只有个数；响应里没有项目甲的场景名、运行编号、节点名、任务编号", async () => {
		const [agent] = await hub.list(BETA);
		expect(agent?.running_tasks.map((t) => t.task_id)).toEqual([own.task]);
		expect(agent?.queued_tasks).toEqual([]);
		expect(agent?.other_project_running).toBe(1);
		expect(agent?.other_project_queued).toBe(1);
		const text = JSON.stringify(await hub.list(BETA));
		for (const value of Object.values(secret)) expect(text).not.toContain(value);
		// 按名字取一台 Agent 同样过滤。
		expect(JSON.stringify(await hub.find(BETA, "agent-b"))).not.toContain(secret.scenario);
	});

	it("最近一次安装是为项目甲的任务装的：状态照给，不给任务编号；为项目乙的任务装的照常给", async () => {
		const installFor = (taskId: string) =>
			database.pool.query(
				`update agents set info = jsonb_set(info, '{install}', $1::jsonb) where name = 'agent-b'`,
				[
					JSON.stringify({
						package: "demo",
						version: "1.0.0",
						state: "installed",
						task_id: taskId,
					}),
				],
			);
		await installFor(secret.taskRunning);
		const [agent] = await hub.list(BETA);
		expect(agent?.install).toEqual({
			package: "demo",
			version: "1.0.0",
			state: "installed",
			task_id: "",
		});
		const text = JSON.stringify(await hub.list(BETA));
		for (const value of Object.values(secret)) expect(text).not.toContain(value);
		expect(JSON.stringify(await hub.find(BETA, "agent-b"))).not.toContain(secret.taskRunning);

		await installFor(own.task);
		expect((await hub.list(BETA))[0]?.install?.task_id).toBe(own.task);
	});

	it("项目甲读不到项目乙的 Agent，也就读不到它上面的任务", async () => {
		expect(await hub.list(DEFAULT_PROJECT)).toEqual([]);
	});
});
