// 带 secret 值的任务不派到工作台（#497，ADR 0029「助手会话」）：派到哪台 Agent，原值就落在哪台的 task.json 里，工作台上助手的命令读得到。
// 只有勾选了「联调时可以使用项目密钥」的会话触发的运行放行；能在触发前看出来的预检阻断，要到派发时才知道的（经子流程参数传进来的、
// 上游节点的原样输出）派发时任务以配置错误失败。值都是明显的假值。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { runsApi } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { echo, orchestration, param, spawn } from "./support/chains.js";
import { TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const TOKEN = "fake-token-b81e3a";
const WORKBENCH = "workbench-a";

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

/** 入口有 secret 参数 token 和普通参数 host；a 派到工作台，输入取 `input`。 */
const onWorkbench = (input: string) =>
	orchestration(
		[
			[
				{
					id: "entry",
					kind: "entry",
					params: [param("token", { secret: true }), param("host")],
				},
				{ ...echo("a", { text: input }), agent: WORKBENCH },
			],
		],
		[],
	);

describe("带 secret 值的任务不派到工作台", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let agent: FakeAgent;
	let workbench: FakeAgent;
	let alice: string;
	let session: string;
	let sessionToken: string;
	let personal: string;

	const send = (token: string, method: string, path: string, body?: unknown) =>
		cp.fetch(path, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const json = async <T>(res: Response, status: number): Promise<T> => {
		expect(res.status, await res.clone().text()).toBe(status);
		return (await res.json()) as T;
	};
	const scenarioBy = async (token: string, document: unknown, project = "default") => {
		const { id } = await json<{ id: string }>(
			await send(token, "POST", `/projects/${project}/orchestrations`, {
				name: `场景 ${Math.random()}`,
			}),
			201,
		);
		await json(
			await send(token, "POST", `/orchestrations/${id}/versions`, { base_version: 0, document }),
			201,
		);
		return id;
	};
	const trigger = (token: string, id: string, params: Record<string, unknown>) =>
		send(token, "POST", `/orchestrations/${id}/runs`, { params });
	const preflight = async (token: string, id: string) =>
		runsApi.preflight.response.parse(
			await json(await send(token, "GET", `/orchestrations/${id}/preflight`), 200),
		).problems;
	const allowSecrets = async (value: boolean) =>
		json(
			await send(personal, "PATCH", `/sessions/${session}`, { use_project_secrets: value }),
			200,
		);
	const query = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => {
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			return (await client.query(sql, args)).rows as T[];
		} finally {
			await client.end();
		}
	};
	const taskOf = async (runId: string, nodeId: string) => {
		const [row] = await query<{
			agent_name: string;
			status: string;
			error_kind: string | null;
			error_message: string | null;
			inputs: unknown;
		}>(
			"select agent_name, status, error_kind, error_message, inputs from tasks where run_id = $1 and node_id = $2",
			[runId, nodeId],
		);
		return row;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		alice = await accounts.user("alice");
		await accounts.member("default", alice, "editor");
		session = await accounts.session(alice, "default");
		sessionToken = await accounts.sessionTokenIn(session, alice, "default");
		personal = await accounts.personalToken(alice);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["url"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
		workbench = await FakeAgent.connect(cp.grpcUrl, { name: WORKBENCH, slots: 4 });
		await query("update projects set workbench_agent = $1 where id = 'default'", [WORKBENCH]);
	});
	afterEach(async () => {
		await agent.disconnect();
		await workbench.disconnect();
		await accounts.close();
		await cp.close();
	});

	it("人触发：引用 secret 参数、派到工作台的任务预检阻断；不带 secret 参数的照常派到工作台", async () => {
		const secret = await scenarioBy(personal, onWorkbench("${{ params.token }}"));
		const problems = await preflight(personal, secret);
		expect(problems).toEqual([
			expect.objectContaining({
				code: "secret_task_on_workbench",
				node_id: "a",
				message: expect.stringContaining("引用了 secret 参数 token"),
			}),
		]);
		const refused = await json<{ error: Problem & { details: Problem[] } }>(
			await trigger(personal, secret, { token: TOKEN, host: "h" }),
			400,
		);
		expect(refused.error.code).toBe("invalid_orchestration");
		expect(refused.error.details.map((p) => p.code)).toEqual(["secret_task_on_workbench"]);

		const plain = await scenarioBy(personal, onWorkbench("${{ params.host }}"));
		expect(await preflight(personal, plain)).toEqual([]);
		await json(await trigger(personal, plain, { token: TOKEN, host: "h" }), 201);
		expect((await workbench.nextAssign()).inputs.text).toBe("h");
	});

	it("会话触发：没勾选时同样预检阻断；勾选了的会话触发的运行，带 secret 参数的任务派到本项目的工作台照常执行", async () => {
		const id = await scenarioBy(sessionToken, onWorkbench("${{ params.token }}"));
		expect((await preflight(sessionToken, id)).map((p) => p.code)).toContain(
			"secret_task_on_workbench",
		);
		await json(await trigger(sessionToken, id, { token: TOKEN, host: "h" }), 400);

		await allowSecrets(true);
		expect(await preflight(sessionToken, id)).toEqual([]);
		const run = await json<{ id: string }>(
			await trigger(sessionToken, id, { token: TOKEN, host: "h" }),
			201,
		);
		const a = await workbench.nextAssign();
		expect(a.inputs.text).toBe(TOKEN);
		await workbench.succeed(a);
		await eventually(async () => expect((await taskOf(run.id, "a"))?.status).toBe("success"));
	});

	it("子流程在运行中途创建、经普通参数把 secret 值传给派到工作台的节点：派发被拒绝，任务以配置错误失败", async () => {
		const id = await scenarioBy(
			personal,
			orchestration(
				[
					[
						{ id: "entry", kind: "entry", params: [param("token", { secret: true })] },
						spawn("x", { k: "${{ params.token }}" }),
					],
					[
						{ id: "sub", kind: "subflow_entry", name: "S", params: [param("k")] },
						{ ...echo("s1", { text: "${{ params.k }}" }), agent: WORKBENCH },
					],
				],
				[["x", "sub"]],
			),
		);
		expect(await preflight(personal, id)).toEqual([]);
		const run = await json<{ id: string }>(await trigger(personal, id, { token: TOKEN }), 201);
		await eventually(async () => expect((await taskOf(run.id, "s1"))?.status).toBe("failed"));
		const s1 = await taskOf(run.id, "s1");
		expect(s1?.error_kind).toBe("config_error");
		expect(s1?.error_message).toContain(`它派发到的 Agent ${WORKBENCH} 是这个项目的工作台`);
		expect(JSON.stringify(s1)).not.toContain(TOKEN);
		await workbench.expectNoAssign();
	});

	it("上游节点把 secret 值放进输出、下游引用它派到工作台：下游派发被拒绝，任务以配置错误失败并写明原因", async () => {
		const id = await scenarioBy(
			personal,
			orchestration(
				[
					[
						{ id: "entry", kind: "entry", params: [param("token", { secret: true })] },
						echo("a", { text: "${{ params.token }}" }),
						{ ...echo("b", { text: "${{ nodes.a.outputs.url }}" }), agent: WORKBENCH },
					],
				],
				[],
			),
		);
		const run = await json<{ id: string }>(await trigger(personal, id, { token: TOKEN }), 201);
		const a = await agent.nextAssign();
		await agent.succeed(a, { url: `https://x.test/?t=${TOKEN}` });
		await eventually(async () => expect((await taskOf(run.id, "b"))?.status).toBe("failed"));
		const b = await taskOf(run.id, "b");
		expect(b?.error_kind).toBe("config_error");
		expect(b?.error_message).toContain("的输入里有 secret 值");
		await workbench.expectNoAssign();
	});

	it("项目甲的会话即使勾选了，也不能把带 secret 参数的任务派到项目乙的工作台", async () => {
		await allowSecrets(true);
		await query(
			"insert into projects (id, display_name, created_at) values ('beta', '项目乙', now())",
		);
		const issued = await json<{ token: string }>(
			await cp.fetch("/projects/beta/agents/workbench-b/credentials", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
			201,
		);
		const other = await FakeAgent.connect(cp.grpcUrl, {
			name: "workbench-b",
			slots: 1,
			token: issued.token,
		});
		try {
			await query("update projects set workbench_agent = 'workbench-b' where id = 'beta'");
			const document = {
				...orchestration(
					[
						[
							{ id: "entry", kind: "entry", params: [param("token", { secret: true })] },
							{ ...echo("a", { text: "${{ params.token }}" }), agent: "workbench-b" },
						],
					],
					[],
				),
			};
			const id = await scenarioBy(sessionToken, document);
			const refused = await json<{ error: Problem & { details: Problem[] } }>(
				await trigger(sessionToken, id, { token: TOKEN }),
				400,
			);
			expect(refused.error.details.map((p) => p.code)).toContain("agent_not_registered");
			expect(await query("select id from tasks where agent_name = 'workbench-b'")).toEqual([]);
			await other.expectNoAssign();
		} finally {
			await other.disconnect();
		}
	});
});
