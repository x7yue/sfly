// 写入时打码（#505）：这次运行写进库和日志文件的值都是打码后的，Agent 收到的仍是原值，下游节点照旧拿到原值。
// 断言直接查库和文件，不经读取接口。值都是明显的假值。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_MASK as MASK } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo, orchestration, param, spawn } from "./support/chains.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { asLegacyRun } from "./support/legacy-run.js";
import {
	packageArchive,
	packageMetadata,
	publishInit,
	publishPackage,
} from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TOKEN = "fake-token-4c1e9a7b";
/** 上游节点作为普通输出交出来、之后才映射进子流程 secret 参数的值。 */
const LATE = "fake-late-77d3e2";

/** 主链：a 拿 token → b 拿 a 的输出 url → x 创建子流程 sub（k 取 a 的输出 code，sub 里声明成 secret）→ s1 拿 k。 */
const SCENARIO = orchestration(
	[
		[
			{ id: "entry", kind: "entry", params: [param("token", { secret: true }), param("host")] },
			echo("a", { text: "${{ params.token }}" }),
			echo("b", { text: "${{ nodes.a.outputs.url }}" }),
			spawn("x", { k: "${{ nodes.a.outputs.code }}" }),
		],
		[
			{ id: "sub", kind: "subflow_entry", name: "S", params: [param("k", { secret: true })] },
			echo("s1", { text: "got ${{ params.k }}" }),
		],
	],
	[["x", "sub"]],
);

async function query<T = Record<string, unknown>>(
	cp: TestControlPlane,
	sql: string,
	args: unknown[] = [],
): Promise<T[]> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		return (await client.query(sql, args)).rows as T[];
	} finally {
		await client.end();
	}
}

/** 库里 public 下每张表每一行的文字，和数据目录下每个日志文件的内容。 */
async function storedText(cp: TestControlPlane): Promise<string> {
	const tables = await query<{ name: string }>(
		cp,
		"select tablename as name from pg_tables where schemaname = 'public'",
	);
	const parts: string[] = [];
	for (const { name } of tables) {
		const rows = await query<{ row: string }>(cp, `select t::text as row from "${name}" t`);
		parts.push(...rows.map((r) => r.row));
	}
	const logs = join(cp.dataDir, "logs");
	for (const run of await readdir(logs).catch(() => [])) {
		for (const file of await readdir(join(logs, run))) {
			parts.push(await readFile(join(logs, run, file), "utf8"));
		}
	}
	return parts.join("\n");
}

const taskOf = async (cp: TestControlPlane, runId: string, nodeId: string) => {
	const [row] = await query<{
		id: string;
		inputs: Record<string, unknown> | null;
		outputs: Record<string, unknown> | null;
		error_message: string | null;
		error_location: string | null;
		progress: { message: string } | null;
	}>(
		cp,
		"select id, inputs, outputs, error_message, error_location, progress from tasks where run_id = $1 and node_id = $2 order by attempt desc limit 1",
		[runId, nodeId],
	);
	if (!row) throw new Error(`no task for ${nodeId}`);
	return row;
};

describe("写入时打码：写进库和日志文件的是掩码，Agent 收到的是原值", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["url", "code"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 跑完整个场景：每个节点上报日志、进度、动作，a 交出带 token 的 url 和 code，s1 失败（原因里有 LATE、位置里有 token）。 */
	const runScenario = async () => {
		const runId = await api.triggerOk(await api.orchestrationWith(SCENARIO), {
			token: TOKEN,
			host: "h-1",
		});
		const report = (task: AssignedTask, value: string) => {
			agent.logs(task, [[1, `using ${value}`]]);
			agent.progress(task, 1, 2, `step ${value}`);
			const now = Date.UTC(2026, 0, 1);
			agent.actions(task, [
				agent.actionStart(1, `call ${value}`, now, { fields: { key: value } }),
				agent.actionEnd(1, "failed", now + 1, { reason: `refused ${value}` }),
			]);
		};
		const a = await agent.nextAssign();
		report(a, TOKEN);
		await agent.sync();
		await agent.succeed(a, { url: `https://x.test/?t=${TOKEN}`, code: LATE });
		const b = await agent.nextAssign();
		report(b, String(b.inputs.text));
		await agent.sync();
		await agent.succeed(b);
		const s1 = await agent.nextAssign();
		report(s1, LATE);
		await agent.sync();
		await agent.fail(s1, `bad ${LATE}`, undefined, undefined, `node.py:3 ${TOKEN}`);
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
		return { runId, a, b, s1 };
	};

	it("Agent 收到的输入是原值：a 拿到 token，b 拿到 a 的原样输出，子流程里的 s1 拿到 k 的原值", async () => {
		const { a, b, s1 } = await runScenario();
		expect(a.inputs.text).toBe(TOKEN);
		expect(b.inputs.text).toBe(`https://x.test/?t=${TOKEN}`);
		expect(s1.inputs.text).toBe(`got ${LATE}`);
	});

	it("库里：运行和链实例的参数、任务的输入输出、错误、进度都是掩码；token 在库和日志文件里一处都没有", async () => {
		const { runId } = await runScenario();
		const [run] = await query<{ params: Record<string, unknown>; masked_on_write: boolean }>(
			cp,
			"select params, masked_on_write from runs where id = $1",
			[runId],
		);
		expect(run).toEqual({ params: { token: MASK, host: "h-1" }, masked_on_write: true });
		const chains = await query<{ chain_id: string; params: Record<string, unknown> }>(
			cp,
			"select chain_id, params from chain_instances where run_id = $1 order by depth",
			[runId],
		);
		expect(chains).toEqual([
			{ chain_id: "entry", params: { token: MASK, host: "h-1" } },
			{ chain_id: "sub", params: { k: MASK } },
		]);
		const a = await taskOf(cp, runId, "a");
		expect(a.inputs).toEqual({ text: MASK });
		// code 是 a 交出时还不是 secret 的普通输出：之前写下的不追（已知边界）。
		expect(a.outputs).toEqual({ url: `https://x.test/?t=${MASK}`, code: LATE });
		expect(a.progress?.message).toBe(`step ${MASK}`);
		expect((await taskOf(cp, runId, "b")).inputs).toEqual({ text: `https://x.test/?t=${MASK}` });
		expect((await taskOf(cp, runId, "x")).inputs).toEqual({ k: MASK });
		const s1 = await taskOf(cp, runId, "s1");
		expect(s1.inputs).toEqual({ text: `got ${MASK}` });
		expect(s1.error_message).toBe(`bad ${MASK}`);
		expect(s1.error_location).toBe(`node.py:3 ${MASK}`);
		expect(s1.progress?.message).toBe(`step ${MASK}`);

		const text = await storedText(cp);
		expect(text).not.toContain(TOKEN);
		// LATE 只留在它还不是 secret 时写下的 a 的输出里。
		expect(text.split(LATE).length - 1).toBe(1);
	});

	it("日志文件和动作明细：子流程创建之后 s1 写下的 LATE 也是掩码", async () => {
		const { runId, s1 } = await runScenario();
		const file = await readFile(join(cp.dataDir, "logs", runId, `${s1.taskId}.jsonl`), "utf8");
		expect(file).toContain(`using ${MASK}`);
		expect(file).not.toContain(LATE);
		const actions = await query<{ name: string; fields: unknown; reason: string | null }>(
			cp,
			"select name, fields, reason from task_actions where task_id = $1",
			[s1.taskId],
		);
		expect(JSON.stringify(actions)).not.toContain(LATE);
		expect(JSON.stringify(actions)).toContain(`call ${MASK}`);
	});

	it("读取接口不再打码：读到的就是库里存的那份（a 的输出、b 的输入是掩码）", async () => {
		const { a, b } = await runScenario();
		const io = (id: string) =>
			api.getJson<{ inputs: unknown; outputs: unknown }>(`/tasks/${id}/io`);
		expect((await io(a.taskId)).outputs).toEqual({ url: `https://x.test/?t=${MASK}`, code: LATE });
		expect((await io(b.taskId)).inputs).toEqual({ text: `https://x.test/?t=${MASK}` });
	});

	it("带标记的运行读取时不再打码：直接改库写进去的原值原样读出来（证明读取没有再打一遍）", async () => {
		const { runId, b } = await runScenario();
		await query(cp, "update tasks set outputs = $2::jsonb where id = $1", [
			b.taskId,
			JSON.stringify({ planted: TOKEN }),
		]);
		expect((await api.getJson<{ outputs: unknown }>(`/tasks/${b.taskId}/io`)).outputs).toEqual({
			planted: TOKEN,
		});
		expect((await api.run(runId)).params).toEqual({ token: MASK, host: "h-1" });
	});

	it("没有标记的运行（写入时打码之前的）照旧在读取时打码", async () => {
		const id = await api.orchestrationWith(SCENARIO);
		const runId = await api.triggerOk(id, { token: TOKEN, host: "h-1" });
		const a = await agent.nextAssign();
		await asLegacyRun(cp, runId);
		await agent.succeed(a, { url: `https://x.test/?t=${TOKEN}`, code: "c" });
		const b = await agent.nextAssign();
		expect(b.inputs.text).toBe(`https://x.test/?t=${TOKEN}`);
		expect((await taskOf(cp, runId, "a")).outputs).toEqual({
			url: `https://x.test/?t=${TOKEN}`,
			code: "c",
		});
		const io = await api.getJson<{ outputs: unknown }>(`/tasks/${a.taskId}/io`);
		expect(io.outputs).toEqual({ url: `https://x.test/?t=${MASK}`, code: "c" });
		expect((await api.run(runId)).params).toEqual({ token: MASK, host: "h-1" });
	});

	it("控制面重启之后：重新解析的输入、重试的输入、中途创建的子流程参数，Agent 收到原值，库里是掩码", async () => {
		const retrying = orchestration(
			[
				[
					{ id: "entry", kind: "entry", params: [param("token", { secret: true })] },
					echo("a", { text: "${{ params.token }}" }),
					{ ...echo("b", { text: "${{ nodes.a.outputs.url }}" }), retries: 1 },
					spawn("x", { k: "${{ nodes.a.outputs.url }}" }),
				],
				[
					{ id: "sub", kind: "subflow_entry", name: "S", params: [param("k", { secret: true })] },
					echo("s1", { text: "${{ params.k }}" }),
				],
			],
			[["x", "sub"]],
		);
		const runId = await api.triggerOk(await api.orchestrationWith(retrying), { token: TOKEN });
		const a = await agent.nextAssign();
		await agent.disconnect();
		await cp.restart();
		agent = await FakeAgent.connect(
			cp.grpcUrl,
			{
				name: "agent-a",
				slots: 4,
				runningTasks: [{ taskId: a.taskId, attempt: a.attempt, started: true }],
			},
			{ clock: cp.clock },
		);
		const url = `https://x.test/?t=${TOKEN}`;
		await agent.succeed(a, { url });
		const b1 = await agent.nextAssign();
		expect(b1.inputs.text).toBe(url);
		await agent.fail(b1, "flaky");
		const b2 = await agent.nextAssign();
		expect(b2.attempt).toBe(2);
		expect(b2.inputs.text).toBe(url);
		await agent.succeed(b2);
		const s1 = await agent.nextAssign();
		expect(s1.inputs.text).toBe(url);
		expect((await taskOf(cp, runId, "b")).inputs).toEqual({ text: `https://x.test/?t=${MASK}` });
		expect((await taskOf(cp, runId, "s1")).inputs).toEqual({ text: MASK });
		await agent.succeed(s1);
		expect(await storedText(cp)).not.toContain(TOKEN);
	});

	it("控制面在上报中途重启：重连之后补报的日志照样打码", async () => {
		const runId = await api.triggerOk(await api.orchestrationWith(SCENARIO), {
			token: TOKEN,
			host: "h",
		});
		const a = await agent.nextAssign();
		agent.logs(a, [[1, `before ${TOKEN}`]]);
		await agent.sync();
		await agent.disconnect();
		await cp.restart();
		agent = await FakeAgent.connect(
			cp.grpcUrl,
			{
				name: "agent-a",
				slots: 4,
				runningTasks: [{ taskId: a.taskId, attempt: a.attempt, started: true }],
			},
			{ clock: cp.clock },
		);
		agent.logs(a, [
			[1, `before ${TOKEN}`],
			[2, `after ${TOKEN}`],
		]);
		await agent.sync();
		const file = await readFile(join(cp.dataDir, "logs", runId, `${a.taskId}.jsonl`), "utf8");
		expect(file).toContain(`after ${MASK}`);
		expect(file).not.toContain(TOKEN);
	});

	it("原值集合按运行：一个运行的 secret 值不用来打码别的运行（别的项目的运行更不会）", async () => {
		await runScenario();
		const plain = orchestration(
			[
				[
					{ id: "entry", kind: "entry", params: [param("v")] },
					echo("p", { text: "${{ params.v }}" }),
				],
			],
			[],
		);
		const runId = await api.triggerOk(await api.orchestrationWith(plain), { v: TOKEN });
		const p = await agent.nextAssign();
		agent.logs(p, [[1, `echo ${TOKEN}`]]);
		await agent.sync();
		await agent.succeed(p, { url: TOKEN });
		expect((await taskOf(cp, runId, "p")).outputs).toEqual({ url: TOKEN });
		const file = await readFile(join(cp.dataDir, "logs", runId, `${p.taskId}.jsonl`), "utf8");
		expect(file).toContain(`echo ${TOKEN}`);
	});

	it("派发时类型不符：错误信息里引用的值是掩码", async () => {
		await publishPackage(cp, "stub", "2.0.0", {
			echo: ["url", "code"],
			count: { outputs: [], inputs: { properties: { n: { type: "integer" } }, required: ["n"] } },
		});
		const typed = {
			...orchestration(
				[
					[
						{ id: "entry", kind: "entry", params: [param("token", { secret: true })] },
						echo("a", { text: "${{ params.token }}" }),
						{
							id: "c",
							kind: "package",
							package: "stub",
							node: "count",
							inputs: { n: "${{ nodes.a.outputs.url }}" },
						},
					],
				],
				[],
			),
			packages: { stub: "2.0.0" },
		};
		const runId = await api.triggerOk(await api.orchestrationWith(typed), { token: TOKEN });
		const a = await agent.nextAssign();
		await agent.succeed(a, { url: `u-${TOKEN}` });
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
		const c = await taskOf(cp, runId, "c");
		expect(c.error_message).toContain(MASK);
		expect(c.error_message).not.toContain(TOKEN);
	});
});

describe("ctx.notify：存下和发到群里的消息都是掩码", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let feishu: FakeFeishu;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		feishu = await startFakeFeishu();
		const metadata = packageMetadata({
			name: "alerts",
			version: "1.0.0",
			nodes: [
				{
					name: "alert",
					title: "告警",
					entry: "alerts:alert",
					inputs: {
						type: "object",
						properties: {
							bot: { type: "string", "x-sfly-type": "feishu_bot" },
							token: { type: "string" },
						},
						required: ["bot"],
						order: ["bot", "token"],
					},
					outputs: { type: "object", properties: {} },
				},
			],
		});
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
		await api.createFeishuBot("ops", feishu.webhookUrl("tok-ops-1a2b3c4d"));
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 2 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await feishu.close();
		await cp.close();
	});

	it("消息体里节点写进去的 secret 值：feishu_messages.body 和发出的请求都是掩码", async () => {
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [param("token", { secret: true })] },
				{
					id: "alert",
					kind: "package",
					package: "alerts",
					node: "alert",
					inputs: { bot: "ops", token: "${{ params.token }}" },
				},
			],
			edges: [{ from: "entry", to: "alert", kind: "chain" }],
			packages: { alerts: "1.0.0" },
		});
		await api.triggerOk(id, { token: TOKEN });
		const task = await agent.nextAssign();
		expect(task.inputs.token).toBe(TOKEN);
		agent.send({
			case: "notification",
			value: {
				taskId: task.taskId,
				attempt: task.attempt,
				eventJson: JSON.stringify({ type: "notify", ts: 0, bot: "ops", text: `leaked ${TOKEN}` }),
			},
		});
		await eventually(() => expect(feishu.requests).toHaveLength(1));
		expect(feishu.requests[0]?.json).toEqual({
			msg_type: "text",
			content: { text: `leaked ${MASK}` },
		});
		const [stored] = await query<{ body: unknown }>(cp, "select body from feishu_messages");
		expect(JSON.stringify(stored?.body)).not.toContain(TOKEN);
	});
});
