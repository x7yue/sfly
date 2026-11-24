// 任务凭据（ADR 0029「凭据」，规格 #492）：派发一次任务尝试时签发，随 AssignTask 下发，只在这次尝试有效，
// 只能下载本项目任务的产物（任务里的 SDK 唯一发的请求）。有效期看这次尝试此刻的状态：还在 Agent 手上才有效，
// 结束、取消、租约过期、重试之后失效；Agent 停用、派发时连接用的那一个 Agent 凭据被吊销之后立刻失效（跟着那一个凭据走，
// 不看这个名字此刻有没有别的有效凭据）。真实控制面和数据库，假 Agent。
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

	/** `shared`：Agent 用共享令牌连接（旧方式，没有 Agent 凭据）。 */
	const setup = async (options: { shared?: boolean } = {}) => {
		cp = await startTestControlPlane({
			leaseMs: 5_000,
			...(options.shared ? { agentToken: "s3cret" } : {}),
		});
		db = new pg.Client({ connectionString: cp.database.url });
		await db.connect();
		accounts = new TestAccounts(cp.database.url);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		// Agent 凭据：上传产物要它（任务凭据不能上传）。
		const issued = options.shared
			? undefined
			: await cp.current.agentCredentials.issue("default" as never, "agent-a");
		const agentToken = issued?.token ?? "s3cret";
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", token: agentToken });
		agents.push(agent);
		const api = new ApiClient(cp);
		const scenario = await api.orchestrationWith(DOC);
		const runId = await api.triggerOk(scenario);
		const task = await agent.nextAssign();
		await agent.started(task);
		return {
			agent,
			agentToken,
			credentialId: issued?.credential.id ?? null,
			api,
			runId,
			task,
			scenario,
		};
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
		const { task, credentialId } = await setup();
		expect(task.taskToken).toMatch(/^sfly_tsk_[0-9a-f]{48}$/);
		const { rows } = await db.query(
			"select kind, project_id, task_id, user_id, session_id, scopes, token_hash, prefix, revoked_at, agent_credential_id from api_tokens where task_id = $1",
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
			// 派发时这条连接用的那一个 Agent 凭据：任务凭据跟着它走。
			agent_credential_id: credentialId,
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
	describe("停用 Agent、吊销它的凭据之后立刻不认（不等租约过期）", () => {
		const adminHeaders = async () => {
			const id = await accounts.user("boss");
			await accounts.member("default", id, "project_admin");
			return bearer(await accounts.personalToken(id));
		};
		const taskStatus = async (taskId: string) =>
			(await db.query("select status from tasks where id = $1", [taskId])).rows[0]?.status;

		it("停用这台 Agent：它手上任务的凭据立刻是 401，任务本身还在执行中（租约没过期）；别的 Agent 手上的不受影响", async () => {
			const { task, agent } = await setup();
			// 另一台 Agent 手上的任务：停用不碰它。
			const otherIssued = await cp.current.agentCredentials.issue("default" as never, "agent-b");
			const other = await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-b",
				token: otherIssued.token,
			});
			agents.push(other);
			const api = new ApiClient(cp);
			const second = await api.orchestrationWith({ ...DOC, default_agent: "agent-b" }, "第二个");
			await api.triggerOk(second);
			const otherTask = await other.nextAssign();
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(404);

			const res = await cp.fetch("/agents/agent-a/disable", {
				method: "POST",
				headers: await adminHeaders(),
			});
			expect(res.status).toBe(204);
			expect(await taskStatus(task.taskId)).toBe("running");
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
			expect((await download(otherTask.taskId, "nothing.txt", otherTask.taskToken)).status).toBe(
				404,
			);
			expect(agent.ended).toBe(true);
		});

		it("吊销派发时连接用的那个凭据：任务凭据立刻是 401，任务本身还在执行中（租约没过期）", async () => {
			const { task, credentialId } = await setup();
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(404);
			await cp.current.agentCredentials.revoke(
				"default" as never,
				"agent-a",
				credentialId as string,
			);
			expect(await taskStatus(task.taskId)).toBe("running");
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
		});

		it("全部吊销之后再给同名的 Agent 签发一个新的（不用来连接）：手上的任务凭据仍然是 401，不会又被认回来（凭据外泄之后的标准处理）；吊销和签发同时到也一样", async () => {
			const { task, credentialId } = await setup();
			await cp.current.agentCredentials.revoke(
				"default" as never,
				"agent-a",
				credentialId as string,
			);
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
			await cp.current.agentCredentials.issue("default" as never, "agent-a");
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
			expect(await taskStatus(task.taskId)).toBe("running");
		});

		it("吊销最后一个和签发新的同时到：任务凭据是 401（不管谁先落库）", async () => {
			const { task, credentialId } = await setup();
			await Promise.all([
				cp.current.agentCredentials.revoke("default" as never, "agent-a", credentialId as string),
				cp.current.agentCredentials.issue("default" as never, "agent-a"),
			]);
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
		});

		it("别的项目给同名的 Agent 签发了一个没吊销的凭据：吊销这个项目里连接用的那个之后，任务凭据照样是 401（不看别的项目的凭据）", async () => {
			const { task, credentialId } = await setup();
			await accounts.project("alpha");
			await cp.current.agentCredentials.issue("alpha" as never, "agent-a");
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(404);
			await cp.current.agentCredentials.revoke(
				"default" as never,
				"agent-a",
				credentialId as string,
			);
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
		});

		it("轮换（先签发新的、Agent 用新的重连、再吊销旧的）：旧连接上派发的任务，旧凭据吊销之后任务凭据是 401；新连接上派发的不受影响", async () => {
			const { task: oldTask, credentialId, agent } = await setup();
			const next = await cp.current.agentCredentials.issue("default" as never, "agent-a");
			// Agent 用新凭据重连，手上的旧任务照常带着（Hello 里的执行中任务）：它不会因为重连被放弃。
			const reconnected = await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-a",
				token: next.token,
				runningTasks: [{ taskId: oldTask.taskId, attempt: oldTask.attempt, started: true }],
			});
			agents.push(reconnected);
			await agent.disconnect().catch(() => undefined);
			// 新连接上派发一个新的任务。
			const api = new ApiClient(cp);
			const second = await api.orchestrationWith(DOC, "新连接上的任务");
			await api.triggerOk(second);
			const newTask = await reconnected.nextAssign();
			expect((await download(oldTask.taskId, "nothing.txt", oldTask.taskToken)).status).toBe(404);
			expect((await download(newTask.taskId, "nothing.txt", newTask.taskToken)).status).toBe(404);
			// 记在任务凭据上的是各自派发时连接用的那一个。
			const recorded = await db.query(
				"select task_id, agent_credential_id from api_tokens where task_id = any($1)",
				[[oldTask.taskId, newTask.taskId]],
			);
			const byTask = Object.fromEntries(
				recorded.rows.map((r) => [r.task_id, r.agent_credential_id]),
			);
			expect(byTask[oldTask.taskId]).toBe(credentialId);
			expect(byTask[newTask.taskId]).toBe(next.credential.id);
			// 吊销旧的：旧连接上派发的任务凭据不再被认，新连接上派发的照常。
			await cp.current.agentCredentials.revoke(
				"default" as never,
				"agent-a",
				credentialId as string,
			);
			expect((await download(oldTask.taskId, "nothing.txt", oldTask.taskToken)).status).toBe(401);
			expect((await download(newTask.taskId, "nothing.txt", newTask.taskToken)).status).toBe(404);
		});

		it("派发时连接用的是旧方式（共享令牌，没有记凭据；这一列加进来之前派发的也一样）：吊销 Agent 凭据和它无关，任务凭据照旧有效；停用才失效", async () => {
			const { task } = await setup({ shared: true });
			const { rows } = await db.query(
				"select agent_credential_id from api_tokens where task_id = $1",
				[task.taskId],
			);
			expect(rows[0]).toMatchObject({ agent_credential_id: null });
			// 这个名字后来有人签发、吊销了 Agent 凭据：和这条旧方式的连接无关。
			const issued = await cp.current.agentCredentials.issue("default" as never, "agent-a");
			await cp.current.agentCredentials.revoke("default" as never, "agent-a", issued.credential.id);
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(404);
			await db.query("update agents set disabled_at = now() where name = 'agent-a'");
			expect((await download(task.taskId, "nothing.txt", task.taskToken)).status).toBe(401);
		});
	});
});
