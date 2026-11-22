// 任务凭据（ADR 0029「凭据」，规格 #492）：派发一次任务尝试时签发，随 AssignTask 下发，只在这次尝试有效，
// 只能下载本项目任务的产物（任务里的 SDK 唯一发的请求）。有效期看这次尝试此刻的状态：还在 Agent 手上才有效，
// 结束、取消、租约过期、重试之后失效。真实控制面和数据库，假 Agent。
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { hashCredential } from "../src/auth/credential-hash.js";
import { ApiClient } from "./support/api-client.js";
import { bearer, TestAccounts } from "./support/credentials.js";
import { FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const DOC = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo", retries: 1 },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

describe("任务凭据", () => {
	let cp: TestControlPlane;
	let db: pg.Client;
	let accounts: TestAccounts;
	const agents: FakeAgent[] = [];

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((agent) => agent.disconnect()));
		await db?.end();
		await accounts?.close();
		await cp?.close();
	});

	const setup = async () => {
		cp = await startTestControlPlane({ leaseMs: 5_000 });
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		accounts = new TestAccounts(cp.database.url);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		// Agent 凭据：上传产物要它（任务凭据不能上传）。
		const issued = await cp.current.agentCredentials.issue("default" as never, "agent-a");
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", token: issued.token });
		agents.push(agent);
		const api = new ApiClient(cp);
		const scenario = await api.orchestrationWith(DOC);
		const runId = await api.triggerOk(scenario);
		const task = await agent.nextAssign();
		await agent.started(task);
		return { agent, agentToken: issued.token, api, runId, task, scenario };
	};
	const download = (taskId: string, name: string, token?: string) =>
		cp.fetch(`/tasks/${taskId}/artifacts/${name}`, token ? { headers: bearer(token) } : {});
	const upload = (taskId: string, name: string, body: string, token: string) =>
		cp.fetch(`/tasks/${taskId}/artifacts/${name}`, {
			method: "PUT",
			headers: { "content-type": "application/octet-stream", ...bearer(token) },
			body,
		});

	it("派发消息带着任务凭据（sfly_tsk_ 前缀）；库里只有哈希和前缀，限本项目、属于这一次尝试，没有用户", async () => {
		const { task } = await setup();
		expect(task.taskToken).toMatch(/^sfly_tsk_[0-9a-f]{48}$/);
		const { rows } = await db.query(
			"select kind, project_id, task_id, user_id, session_id, scopes, token_hash, prefix, revoked_at from api_tokens where task_id = $1",
			[task.taskId],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "task",
			project_id: "default",
			task_id: task.taskId,
			user_id: null,
			session_id: null,
			scopes: [],
			token_hash: hashCredential(task.taskToken),
			prefix: task.taskToken.slice(0, 13),
			revoked_at: null,
		});
		expect(JSON.stringify(rows[0])).not.toContain(task.taskToken);
	});

	it("任务在 Agent 手上时能下载本项目这个任务的产物（SDK 唯一发的请求）；不带凭据的下载照旧可以", async () => {
		const { task, agentToken } = await setup();
		expect((await upload(task.taskId, "report.txt", "你好", agentToken)).status).toBe(201);
		const res = await download(task.taskId, "report.txt", task.taskToken);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("你好");
		// 不带凭据（#494 之前照旧放行）。
		expect((await download(task.taskId, "report.txt")).status).toBe(200);
	});

	it("任务凭据只能下载产物：上传产物、读场景、取消运行、列 Agent 都是 403", async () => {
		const { task, runId, scenario } = await setup();
		const asTask = (method: string, path: string) =>
			cp.fetch(path, { method, headers: bearer(task.taskToken) });
		expect((await upload(task.taskId, "x.txt", "x", task.taskToken)).status).toBe(403);
		for (const [method, path] of [
			["GET", "/orchestrations"],
			["GET", `/orchestrations/${scenario}`],
			["POST", `/runs/${runId}/cancel`],
			["GET", "/agents"],
			["GET", `/runs/${runId}`],
			["GET", `/tasks/${task.taskId}/artifacts`],
		] as const) {
			expect((await asTask(method, path)).status, `${method} ${path}`).toBe(403);
		}
	});

	it("别的项目的任务凭据请求这个项目任务的产物：404；换成别的任务也一样不行", async () => {
		const { task, agentToken } = await setup();
		await upload(task.taskId, "report.txt", "你好", agentToken);
		await accounts.project("alpha");
		// 一个属于项目甲的任务凭据（任务在项目甲里还在 Agent 手上）。
		await db.query(
			`insert into orchestrations (id, project_id, name, description, head_version, created_at)
			values ('11111111-1111-4111-8111-111111111111', 'alpha', 'alpha-scenario', '', 0, now())`,
		);
		const alien = await accounts.taskCredential("alpha", task.taskId);
		const res = await download(task.taskId, "report.txt", alien);
		// 凭据限定的项目是 alpha：这个任务在默认项目里，访问检查一律 404，说法和不存在一样。
		expect([401, 404]).toContain(res.status);
		expect(res.status).not.toBe(200);
	});

	it("任务结束之后凭据立即失效（401）：成功", async () => {
		const { agent, task } = await setup();
		expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(404);
		await agent.succeed(task);
		expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
	});

	it("任务被取消之后失效", async () => {
		const { agent, task, runId, api } = await setup();
		expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(404);
		await api.cancelOk(runId);
		// Agent 收到取消、结束任务（优雅取消：它终止进程树后上报 cancelled）。
		await agent.nextCancel();
		await agent.cancelled(task);
		expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
	});

	it("租约过期（Agent 失联，任务以 agent_lost 失败）之后失效；重试的新一次尝试拿到的是另一个凭据，旧的仍然是 401", async () => {
		const { agent, task, api, runId } = await setup();
		expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(404);
		// 不再续约：租约到期，任务以 agent_lost 失败并按 retries 重试（同一台 Agent 还连着，新的一次尝试派给它）。
		(cp.clock as ManualClock).advance(60_000);
		const retry = await agent.nextAssign();
		await agent.started(retry);
		expect(retry.taskId).not.toBe(task.taskId);
		expect(retry.taskToken).not.toBe(task.taskToken);
		expect(retry.taskToken).toMatch(/^sfly_tsk_/);
		expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
		expect((await download(retry.taskId, "nothing.txt", retry.taskToken)).status).toBe(404);
		// 一次尝试的凭据只对这一次尝试：旧凭据去下载新尝试的产物也不行。
		expect((await download(retry.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
		expect((await api.run(runId)).status).toBe("running");
	});
});
