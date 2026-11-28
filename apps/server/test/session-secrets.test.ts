// 会话令牌触发的运行默认不解析 secret 参数（#497，ADR 0029「助手会话」）：场景版本里内嵌的默认值、运行预设里的值、传给子流程 secret 参数的
// 常量都当作没有提供，只用触发请求里给的值；会话勾选了「联调时可以使用项目密钥」才放行，触发时定下、记在运行上。值都是明显的假值。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRET_MASK as MASK, runsApi, sessionsApi } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WITHHELD_REASON } from "../src/runs/withheld-secrets.js";
import { echo, orchestration, param, spawn } from "./support/chains.js";
import { TestAccounts } from "./support/credentials.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DEFAULT = "fake-default-6a1f0c";
const PRESET = "fake-preset-93be2d";
const GIVEN = "fake-given-4d7e81";
const CONSTANT = "fake-constant-2c5b9f";

interface Problem {
	code: string;
	message: string;
}

describe("会话令牌触发的运行不解析 secret 参数", () => {
	let cp: TestControlPlane;
	let accounts: TestAccounts;
	let agent: FakeAgent;
	let alice: string;
	let session: string;
	let sessionToken: string;
	let personal: string;

	const as = (token: string, method: string, body?: unknown): RequestInit => ({
		method,
		headers: {
			authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const send = (token: string, method: string, path: string, body?: unknown) =>
		cp.fetch(path, as(token, method, body));
	const json = async <T>(res: Response, status: number): Promise<T> => {
		expect(res.status, await res.clone().text()).toBe(status);
		return (await res.json()) as T;
	};
	/** 用这个凭据在默认项目里建一个场景、存一个版本，返回场景 ID。 */
	const scenarioBy = async (token: string, document: unknown) => {
		const { id } = await json<{ id: string }>(
			await send(token, "POST", "/projects/default/orchestrations", {
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
	const trigger = (token: string, id: string, body: { params?: unknown; preset?: string } = {}) =>
		send(token, "POST", `/orchestrations/${id}/runs`, { params: {}, ...body });
	const allowSecrets = async (value: boolean) =>
		sessionsApi.update.response.parse(
			await json(
				await send(personal, "PATCH", `/sessions/${session}`, { use_project_secrets: value }),
				200,
			),
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
	const runView = async (runId: string) =>
		runsApi.get.response.parse(await json(await send(personal, "GET", `/runs/${runId}`), 200));

	beforeEach(async () => {
		cp = await startTestControlPlane();
		accounts = new TestAccounts(cp.database.url);
		alice = await accounts.user("alice");
		await accounts.member("default", alice, "editor");
		session = await accounts.session(alice, "default");
		sessionToken = await accounts.sessionTokenIn(session, alice, "default");
		personal = await accounts.personalToken(alice);
		await publishPackage(cp, "stub", "1.0.0", {
			echo: ["out"],
			need: { outputs: [], inputs: { properties: { n: { type: "string" } }, required: ["n"] } },
		});
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await accounts.close();
		await cp.close();
	});

	it("「联调时可以使用项目密钥」：会话令牌改不了（403），人能改，会话视图里看得到", async () => {
		const refused = await send(sessionToken, "PATCH", `/sessions/${session}`, {
			use_project_secrets: true,
		});
		expect(refused.status).toBe(403);
		const [row] = await query<{ use_project_secrets: boolean }>(
			"select use_project_secrets from sessions where id = $1",
			[session],
		);
		expect(row?.use_project_secrets).toBe(false);
		expect((await allowSecrets(true)).use_project_secrets).toBe(true);
		const view = sessionsApi.get.response.parse(
			await json(await send(personal, "GET", `/sessions/${session}`), 200),
		);
		expect(view.use_project_secrets).toBe(true);
	});

	it("必填 secret 参数只有场景里的默认值：没勾选时触发被拒（只用已发布的节点），勾选之后照常运行、节点收到默认值", async () => {
		const id = await scenarioBy(
			sessionToken,
			orchestration(
				[
					[
						{
							id: "entry",
							kind: "entry",
							params: [param("token", { secret: true, required: true, default: DEFAULT })],
						},
						echo("a", { text: "${{ params.token }}" }),
					],
				],
				[],
			),
		);
		const refused = await json<{ error: Problem & { details: string[] } }>(
			await trigger(sessionToken, id),
			400,
		);
		expect(refused.error.code).toBe("secret_params_withheld");
		expect(refused.error.message).toContain("参数 token 是 secret 参数");
		expect(refused.error.message).toContain(WITHHELD_REASON);
		expect(await query("select id from runs")).toEqual([]);

		await allowSecrets(true);
		const run = await json<{ id: string }>(await trigger(sessionToken, id), 201);
		const a = await agent.nextAssign();
		expect(a.inputs.text).toBe(DEFAULT);
		expect((await runView(run.id)).secrets_withheld).toBe(false);
	});

	it("会话在触发请求里给的值照常用：节点收到它，日志里是掩码；运行和会话里的记录标着不解析", async () => {
		const id = await scenarioBy(
			sessionToken,
			orchestration(
				[
					[
						{
							id: "entry",
							kind: "entry",
							params: [param("token", { secret: true, required: true, default: DEFAULT })],
						},
						echo("a", { text: "${{ params.token }}" }),
					],
				],
				[],
			),
		);
		const run = await json<{ id: string }>(
			await trigger(sessionToken, id, { params: { token: GIVEN } }),
			201,
		);
		const a = await agent.nextAssign();
		expect(a.inputs.text).toBe(GIVEN);
		agent.logs(a, [[1, `using ${GIVEN}`]]);
		await agent.sync();
		const file = await readFile(join(cp.dataDir, "logs", run.id, `${a.taskId}.jsonl`), "utf8");
		expect(file).toContain(`using ${MASK}`);
		expect(file).not.toContain(GIVEN);
		expect((await runView(run.id)).secrets_withheld).toBe(true);
		const [record] = await query<{ payload: Record<string, unknown> }>(
			"select payload from session_events where session_id = $1 and type = 'platform' and payload->>'kind' = 'run'",
			[session],
		);
		expect(record?.payload).toMatchObject({ kind: "run", run_id: run.id, secrets_withheld: true });
	});

	it("复制带内嵌默认值和预设 secret 值的场景，会话触发副本：值都当作没有提供，必填的被拒，节点收不到原值", async () => {
		const source = await scenarioBy(
			personal,
			orchestration(
				[
					[
						{
							id: "entry",
							kind: "entry",
							params: [
								param("token", { secret: true, required: true, default: DEFAULT }),
								param("extra", { secret: true, default: DEFAULT }),
							],
						},
						echo("a", { text: "${{ params.token }}" }),
						echo("b", { text: "${{ params.extra }}" }),
					],
				],
				[],
			),
		);
		await json(
			await send(personal, "POST", `/orchestrations/${source}/presets`, {
				name: "存着 secret 值",
				params: [{ name: "token", value: PRESET }],
			}),
			201,
		);
		const copy = (
			await json<{ id: string }>(
				await send(sessionToken, "POST", `/orchestrations/${source}/copy`, { name: "联调副本" }),
				201,
			)
		).id;
		const [preset] = await query<{ id: string }>(
			"select id from run_presets where orchestration_id = $1",
			[copy],
		);
		if (!preset) throw new Error("预设没有跟着复制过去");

		for (const body of [{}, { preset: preset.id }]) {
			const refused = await json<{ error: Problem }>(await trigger(sessionToken, copy, body), 400);
			expect(refused.error.code).toBe("secret_params_withheld");
		}
		const run = await json<{ id: string }>(
			await trigger(sessionToken, copy, { preset: preset.id, params: { token: GIVEN } }),
			201,
		);
		const a = await agent.nextAssign();
		expect(a.inputs.text).toBe(GIVEN);
		await agent.succeed(a);
		const b = await agent.nextAssign();
		expect(b.inputs.text).toBeNull();
		await agent.succeed(b);
		await eventually(async () => expect((await runView(run.id)).status).toBe("success"));
		const inputs = await query<{ inputs: unknown }>("select inputs from tasks where run_id = $1", [
			run.id,
		]);
		expect(JSON.stringify(inputs)).not.toContain(DEFAULT);
		expect(JSON.stringify(inputs)).not.toContain(PRESET);
	});

	it("可选的 secret 参数被整值引用、节点要求字符串：派发失败，错误信息写明会话触发的运行不解析 secret 参数；预检给会话一条警告", async () => {
		const id = await scenarioBy(sessionToken, {
			...orchestration(
				[
					[
						{
							id: "entry",
							kind: "entry",
							params: [param("opt", { secret: true, default: DEFAULT })],
						},
						{
							id: "c",
							kind: "package",
							package: "stub",
							node: "need",
							inputs: { n: "${{ params.opt }}" },
						},
					],
				],
				[],
			),
		});
		const preflight = runsApi.preflight.response.parse(
			await json(await send(sessionToken, "GET", `/orchestrations/${id}/preflight`), 200),
		);
		expect(preflight.problems).toEqual([]);
		expect(preflight.warnings.filter((w) => w.code === "secret_param_withheld")).toEqual([
			expect.objectContaining({ message: expect.stringContaining("参数 opt 是 secret 参数") }),
		]);
		const human = runsApi.preflight.response.parse(
			await json(await send(personal, "GET", `/orchestrations/${id}/preflight`), 200),
		);
		expect(human.warnings.map((w) => w.code)).not.toContain("secret_param_withheld");

		const run = await json<{ id: string }>(await trigger(sessionToken, id), 201);
		await eventually(async () => expect((await runView(run.id)).status).toBe("failed"));
		const [task] = await query<{ error_kind: string; error_message: string }>(
			"select error_kind, error_message from tasks where run_id = $1 and node_id = 'c'",
			[run.id],
		);
		expect(task?.error_kind).toBe("config_error");
		expect(task?.error_message).toContain(`${WITHHELD_REASON}：opt 是 null`);
	});

	it("子流程的 secret 参数由常量或默认值提供：必填的触发时就拒绝，可选的节点拿到 null", async () => {
		const required = await scenarioBy(
			sessionToken,
			orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawn("x", { k: CONSTANT })],
					[
						{
							id: "sub",
							kind: "subflow_entry",
							name: "S",
							params: [param("k", { secret: true, required: true })],
						},
						echo("s1", { text: "${{ params.k }}" }),
					],
				],
				[["x", "sub"]],
			),
		);
		const refused = await json<{ error: Problem }>(await trigger(sessionToken, required), 400);
		expect(refused.error.code).toBe("secret_params_withheld");
		expect(refused.error.message).toContain(
			"子流程 S（sub） 的 secret 参数 k 由异步任务节点 x 传的常量提供",
		);

		const optional = await scenarioBy(
			sessionToken,
			orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawn("x", { k: CONSTANT })],
					[
						{
							id: "sub",
							kind: "subflow_entry",
							name: "S",
							params: [
								param("k", { secret: true }),
								param("d", { secret: true, default: DEFAULT }),
							],
						},
						echo("s1", { text: "${{ params.k }}", other: "${{ params.d }}" }),
					],
				],
				[["x", "sub"]],
			),
		);
		await json(await trigger(sessionToken, optional), 201);
		const s1 = await agent.nextAssign();
		expect(s1.inputs).toEqual({ text: null, other: null });
	});

	it("触发之后改勾选：这次运行的重试和中途创建的子流程照旧按触发时的决定", async () => {
		const id = await scenarioBy(
			sessionToken,
			orchestration(
				[
					[
						{
							id: "entry",
							kind: "entry",
							params: [param("token", { secret: true, default: DEFAULT })],
						},
						{ ...echo("a", { text: "${{ params.token }}" }), retries: 1 },
						spawn("x", { k: CONSTANT }),
					],
					[
						{ id: "sub", kind: "subflow_entry", name: "S", params: [param("k", { secret: true })] },
						echo("s1", { text: "${{ params.k }}" }),
					],
				],
				[["x", "sub"]],
			),
		);
		const run = await json<{ id: string }>(await trigger(sessionToken, id), 201);
		const a1 = await agent.nextAssign();
		expect(a1.inputs.text).toBeNull();
		await allowSecrets(true);
		await agent.fail(a1, "flaky");
		const a2 = await agent.nextAssign();
		expect(a2.attempt).toBe(2);
		expect(a2.inputs.text).toBeNull();
		await agent.succeed(a2);
		const s1 = await agent.nextAssign();
		expect(s1.inputs.text).toBeNull();
		expect((await runView(run.id)).secrets_withheld).toBe(true);

		// 对照：勾选之后新触发的运行解析默认值和常量。
		const allowed = await json<{ id: string }>(await trigger(sessionToken, id), 201);
		const a = await agent.nextAssign();
		expect(a.inputs.text).toBe(DEFAULT);
		await agent.succeed(a);
		expect((await agent.nextAssign()).inputs.text).toBe(CONSTANT);
		expect((await runView(allowed.id)).secrets_withheld).toBe(false);
	});

	it("人触发的运行照常解析默认值和预设里的值", async () => {
		const id = await scenarioBy(
			personal,
			orchestration(
				[
					[
						{
							id: "entry",
							kind: "entry",
							params: [param("token", { secret: true, required: true, default: DEFAULT })],
						},
						echo("a", { text: "${{ params.token }}" }),
					],
				],
				[],
			),
		);
		const run = await json<{ id: string }>(await trigger(personal, id), 201);
		expect((await agent.nextAssign()).inputs.text).toBe(DEFAULT);
		expect((await runView(run.id)).secrets_withheld).toBe(false);
	});
});
