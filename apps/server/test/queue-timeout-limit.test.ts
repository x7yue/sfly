// 节点的排队超时有上限（#559）：排队截止时间 = 进入排队的时刻 + queue_timeout，要是一个有效的时间。
// 没有上限时，填一个很大的数（多打了几位）算出的是 Invalid Date：触发返回 500，或者运行已经开始、前面的节点明明成功了，
// 到这个节点时却被记成失败（「控制面无法保存任务结果：Invalid time value」）。
// 保存和检查拒绝（400，同一句话）；库里已有的超限版本在触发前的预检里报配置错误；已经触发的运行走到这个节点时它以
// config_error 失败；上限以内的最大值能正常触发、排队、派发。HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL。
import { type AgentView, agentsApi, QUEUE_TIMEOUT_MAX_SECONDS } from "@sfly/schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { ErrorKind, FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 超过上限的值：issue 里写的量级（约 8.64e12 秒以上算出的截止时间无效）。 */
const TOO_LARGE = 9_000_000_000_000;
const MESSAGE = (label: string, actual: number = TOO_LARGE) =>
	`节点 ${label}：queue_timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 ${actual}`;

type NodeSpec = { id: string; queue_timeout?: number; retries?: number; display_name?: string };

describe("节点的排队超时上限", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async () => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		agents.push(agent);
		return agent;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	/** 入口加按顺序串成链的包节点。 */
	const scenario = (...nodes: NodeSpec[]) => ({
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			...nodes.map((n) => ({
				...n,
				kind: "package",
				package: "stub",
				node: "echo",
				inputs: {},
			})),
		],
		edges: nodes.map((n, i) => ({
			from: i === 0 ? "entry" : (nodes[i - 1] as NodeSpec).id,
			to: n.id,
			kind: "chain",
		})),
		packages: { stub: "1.0.0" },
	});

	/** 绕过保存校验，把已保存的版本里节点 `nodeId` 的排队超时改成 `value`：模拟升级前保存的版本。 */
	const tamper = async (
		databaseUrl: string,
		orchestrationId: string,
		nodeId: string,
		value: number,
	) => {
		const client = new pg.Client({ connectionString: databaseUrl });
		await client.connect();
		try {
			const { rows } = await client.query<{
				id: string;
				document: { nodes: Array<{ id: string }> };
			}>("select id, document from orchestration_versions where orchestration_id = $1", [
				orchestrationId,
			]);
			for (const row of rows) {
				const node = row.document.nodes.find((n) => n.id === nodeId) as { queue_timeout?: number };
				node.queue_timeout = value;
				await client.query("update orchestration_versions set document = $1 where id = $2", [
					JSON.stringify(row.document),
					row.id,
				]);
			}
		} finally {
			await client.end();
		}
	};
	/** 注册过但不在线的 Agent：触发的任务排队等它。 */
	const registeredButOffline = async () => {
		await (await connect()).disconnect();
		agents.length = 0;
	};

	describe("保存和检查", () => {
		it("保存时被拒绝（400），错误信息写明是哪个节点、字段、范围、实际是多少", async () => {
			const id = await api.createOrchestration("排队超限");
			const res = await api.post(`/orchestrations/${id}/versions`, {
				base_version: 0,
				document: scenario({ id: "a", queue_timeout: TOO_LARGE, display_name: "等槽位" }),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { message: string } };
			expect(body.error.message).toContain(MESSAGE("等槽位（a）"));
		});

		it("检查（POST /check，sfly scenario check）和保存一样：400，同一句错误信息", async () => {
			const id = await api.createOrchestration("排队超限检查");
			const checked = await api.post(`/orchestrations/${id}/check`, {
				document: scenario({ id: "a", queue_timeout: TOO_LARGE }),
			});

			expect(checked.status).toBe(400);
			expect(((await checked.json()) as { error: { message: string } }).error.message).toContain(
				MESSAGE("a"),
			);
			// 检查没有保存：场景里还没有版本。
			expect(
				(await api.getJson<{ versions: unknown[] }>(`/orchestrations/${id}/versions`)).versions,
			).toHaveLength(0);
		});

		it("超时和排队超时都超限：两句都在，各写各的字段", async () => {
			const id = await api.createOrchestration("两个都超限");
			const doc = scenario({ id: "a", queue_timeout: TOO_LARGE });
			(doc.nodes[1] as Record<string, unknown>).timeout = 5_000_000_000;
			const res = await api.post(`/orchestrations/${id}/versions`, {
				base_version: 0,
				document: doc,
			});

			expect(res.status).toBe(400);
			const message = ((await res.json()) as { error: { message: string } }).error.message;
			expect(message).toContain(
				"节点 a：timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 5000000000",
			);
			expect(message).toContain(MESSAGE("a"));
		});

		it("上限本身可以保存", async () => {
			const id = await api.orchestrationWith(
				scenario({ id: "a", queue_timeout: QUEUE_TIMEOUT_MAX_SECONDS }),
			);

			const head = await api.getJson<{ document: { nodes: Array<Record<string, unknown>> } }>(
				`/orchestrations/${id}/head`,
			);
			expect(head.document.nodes[1]?.queue_timeout).toBe(QUEUE_TIMEOUT_MAX_SECONDS);
		});
	});

	describe("库里已有的超限版本（升级前保存的）", () => {
		it("触发前的预检阻断，指到这个节点的 queue_timeout；触发被拒绝（400），不是 500", async () => {
			const id = await api.orchestrationWith(scenario({ id: "a", queue_timeout: 120 }));
			await connect(); // 触发要求 Agent 注册过
			await tamper(cp.database.url, id, "a", TOO_LARGE);
			await cp.restart(); // 版本文档在控制面里缓存过：重启后重新读

			const { problems } = await api.getJson<{
				problems: Array<{ code: string; node_id?: string; message: string }>;
			}>(`/orchestrations/${id}/preflight`);
			expect(problems).toContainEqual(
				expect.objectContaining({
					code: "queue_timeout_out_of_range",
					node_id: "a",
					message: MESSAGE("a"),
				}),
			);
			expect((await api.trigger(id)).status).toBe(400);
		});

		it("检查：拉下来改了别处再检查，仍然是同一句 400；把这个字段改成合格的值才通过", async () => {
			const id = await api.orchestrationWith(scenario({ id: "a", queue_timeout: 120 }));
			await tamper(cp.database.url, id, "a", TOO_LARGE);
			await cp.restart();
			const { document } = await api.getJson<{
				document: { nodes: Array<Record<string, unknown>>; default_agent: string };
			}>(`/orchestrations/${id}/head`);
			expect(document.nodes[1]?.queue_timeout).toBe(TOO_LARGE);

			const stillBad = await api.post(`/orchestrations/${id}/check`, {
				document: { ...document, default_agent: "agent-b" },
			});
			expect(stillBad.status).toBe(400);
			expect(((await stillBad.json()) as { error: { message: string } }).error.message).toContain(
				MESSAGE("a"),
			);

			(document.nodes[1] as Record<string, unknown>).queue_timeout = 120;
			expect((await api.post(`/orchestrations/${id}/check`, { document })).status).toBe(200);
		});

		it("已经触发、第一个节点还在排队时版本里的值被改成超限：到这个节点时它以配置错误失败（不是 500，也不是把前面成功的节点记成失败），不重试", async () => {
			// 设了重试：配置错误不按重试配置重试（只有一次尝试），这条断言才有意义。
			const id = await api.orchestrationWith(
				scenario({ id: "a", queue_timeout: 120 }, { id: "b", queue_timeout: 120, retries: 2 }),
			);
			await registeredButOffline();
			const runId = await api.triggerOk(id); // a 排队等 Agent；预检通过时 b 的值还是合格的
			await tamper(cp.database.url, id, "b", TOO_LARGE);
			await cp.restart();

			const agent = await connect();
			await agent.succeed(await agent.nextAssign(), { v: 1 });

			await eventually(async () => {
				const b = await api.node(runId, "b");
				expect(b.status).toBe("failed");
				expect(b.error).toEqual({ kind: "config_error", message: MESSAGE("b"), location: null });
			});
			// 前面的节点成功了，仍然是成功；运行以失败结束；b 只有一次尝试，也没有派发。
			expect((await api.node(runId, "a")).status).toBe("success");
			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			expect((await api.node(runId, "b")).attempts.map((a) => [a.attempt, a.status])).toEqual([
				[1, "failed"],
			]);
			await agent.expectNoAssign();
		});

		it("节点失败要重试，但版本里的排队超时已经是超限的值：不再排新的尝试（算不出有效的截止时间），保留第一次的失败", async () => {
			const id = await api.orchestrationWith(scenario({ id: "a", queue_timeout: 120, retries: 2 }));
			await registeredButOffline();
			const runId = await api.triggerOk(id); // 第一次尝试已经排上队（截止时间是有效的）
			await tamper(cp.database.url, id, "a", TOO_LARGE);
			await cp.restart();

			const agent = await connect();
			await agent.fail(await agent.nextAssign(), "探测失败", ErrorKind.NODE_ERROR);

			await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
			const a = await api.node(runId, "a");
			expect(a.error?.kind).toBe("node_error");
			expect(a.error?.message).toBe("探测失败");
			expect(a.attempts.map((t) => t.attempt)).toEqual([1]);
			await agent.expectNoAssign();
		});
	});

	describe("上限以内的最大值", () => {
		it("能正常触发、排队（截止时间是有效的时间）、派发、执行", async () => {
			const id = await api.orchestrationWith(
				scenario({ id: "a", queue_timeout: QUEUE_TIMEOUT_MAX_SECONDS }),
			);
			await registeredButOffline();
			const runId = await api.triggerOk(id);

			// 排队：截止时间 = 进入排队的时刻（测试时钟 2026-01-01）+ 4294967295 秒。
			const listed = agentsApi.list.response.parse(
				await (await cp.fetch("/projects/default/agents")).json(),
			).agents;
			const queued = (listed as AgentView[])[0]?.queued_tasks[0];
			const expected = new Date(Date.UTC(2026, 0, 1) + QUEUE_TIMEOUT_MAX_SECONDS * 1000);
			expect(Number.isNaN(expected.getTime())).toBe(false);
			expect(queued?.queue_expires_at).toBe(expected.toISOString());

			// 派发、执行、成功。
			const agent = await connect();
			await agent.succeed(await agent.nextAssign(), { v: 1 });
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		});
	});
});
