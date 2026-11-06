// 切入点 A：通过 HTTP API 保存编排、触发运行、查询状态；假 Agent 讲真实 gRPC；真实 PostgreSQL。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

type Doc = Record<string, unknown>;

/** 测试用节点包 stub@1.0.0 的节点类型和它们声明的输出键（触发前的预检要求引用的输出键已声明）。 */
const STUB_OUTPUTS = ["n", "v", "port", "config", "tags", "ok", "obj", "token", "missing"];
const STUB_NODES = Object.fromEntries(
	["echo", "first", "second", "third"].map((node) => [node, STUB_OUTPUTS]),
);

/** 入口节点 + 若干包节点串成的单链。 */
function chain(
	nodes: Array<Record<string, unknown>>,
	options: { params?: Array<Record<string, unknown>>; default_agent?: string } = {},
): Doc {
	const all: Array<Record<string, unknown>> = [
		{ id: "entry", kind: "entry", params: options.params ?? [] },
		...nodes.map((n) => ({ kind: "package", package: "stub", node: "echo", ...n })),
	];
	return {
		default_agent: options.default_agent ?? "agent-a",
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0" },
	};
}

describe("单链运行", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};
	/** 让 Agent 注册过但不在线（触发前的预检只要求 Agent 已注册）。 */
	const registerOffline = async (name: string) => (await connect({ name })).disconnect();

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", STUB_NODES);
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("触发", () => {
		it("手动触发创建运行，绑定到最新的编排版本并记录触发人", async () => {
			await registerOffline("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a", inputs: { v: 1 } }]));
			await api.saveVersion(id, chain([{ id: "a", inputs: { v: 2 } }]));

			const res = await api.trigger(id, {}, "小红");
			expect(res.status).toBe(201);
			const { id: runId } = (await res.json()) as { id: string };

			const run = await api.run(runId);
			expect(run).toMatchObject({
				orchestration_id: id,
				orchestration_version: 2,
				status: "running",
				triggered_by: "小红",
				started_at: "2026-01-01T00:00:00.000Z",
				ended_at: null,
			});

			const agent = await connect({ name: "agent-a" });
			expect((await agent.nextAssign()).inputs).toEqual({ v: 2 });
		});

		it("入口参数先按默认值填充，再用触发时传入的值覆盖", async () => {
			await registerOffline("agent-a");
			const id = await api.orchestrationWith(
				chain(
					[
						{
							id: "a",
							inputs: {
								host: "${{ params.host }}",
								port: "${{ params.port }}",
								verbose: "${{ params.verbose }}",
							},
						},
					],
					{
						params: [
							{ name: "host", type: "string", default: "localhost" },
							{ name: "port", type: "number", default: 80 },
							{ name: "verbose", type: "boolean", default: false },
						],
					},
				),
			);
			const runId = await api.triggerOk(id, { port: 8080 });
			expect((await api.run(runId)).params).toEqual({
				host: "localhost",
				port: 8080,
				verbose: false,
			});

			const agent = await connect({ name: "agent-a" });
			expect((await agent.nextAssign()).inputs).toEqual({
				host: "localhost",
				port: 8080,
				verbose: false,
			});
		});

		it("缺少必填参数时拒绝触发，不创建运行", async () => {
			await registerOffline("agent-a");
			const id = await api.orchestrationWith(
				chain([{ id: "a" }], {
					params: [
						{ name: "url", type: "string", required: true },
						{ name: "token", type: "string", required: true, default: "t" },
					],
				}),
			);
			const res = await api.trigger(id, {});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string; message: string } };
			expect(body.error.code).toBe("invalid_params");
			expect(body.error.message).toContain("url");
			expect(body.error.message).not.toContain("token");

			expect((await api.trigger(id, { url: "http://x" })).status).toBe(201);
		});

		it("参数类型不符或参数未声明时拒绝触发", async () => {
			await registerOffline("agent-a");
			const id = await api.orchestrationWith(
				chain([{ id: "a" }], { params: [{ name: "n", type: "number" }] }),
			);
			expect((await api.trigger(id, { n: "1" })).status).toBe(400);
			expect((await api.trigger(id, { other: 1 })).status).toBe(400);
		});

		it("编排不存在或还没有版本时拒绝触发", async () => {
			expect((await api.trigger("00000000-0000-0000-0000-000000000000")).status).toBe(404);
			const id = await api.createOrchestration("empty");
			expect((await api.trigger(id)).status).toBe(400);
		});

		it("包节点既没有选 Agent、场景也没有默认 Agent 时拒绝触发", async () => {
			const doc = chain([{ id: "a" }]);
			delete doc.default_agent;
			const id = await api.orchestrationWith(doc);
			const res = await api.trigger(id);
			expect(res.status).toBe(400);
			expect(JSON.stringify(await res.json())).toContain("a");
		});
	});

	describe("执行", () => {
		it("链上的节点严格按顺序执行，全部成功后运行标记为 success", async () => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(
				chain([
					{ id: "a", node: "first" },
					{ id: "b", node: "second" },
					{ id: "c", node: "third" },
				]),
			);
			const runId = await api.triggerOk(id);

			const a = await agent.nextAssign();
			expect(a).toMatchObject({
				nodeId: "a",
				node: "first",
				package: "stub",
				packageVersion: "1.0.0",
				attempt: 1,
				runId,
			});
			await agent.expectNoAssign();
			expect((await api.node(runId, "a")).status).toBe("running");
			expect((await api.node(runId, "b")).status).toBe("pending");

			await agent.succeed(a, { n: 1 });
			const b = await agent.nextAssign();
			expect(b.nodeId).toBe("b");
			await agent.expectNoAssign();
			expect((await api.run(runId)).status).toBe("running");

			await agent.succeed(b, { n: 2 });
			const c = await agent.nextAssign();
			expect(c.nodeId).toBe("c");
			await agent.succeed(c, { n: 3 });

			const run = await api.run(runId);
			expect(run.status).toBe("success");
			expect(run.ended_at).toBe("2026-01-01T00:00:00.000Z");
			expect(run.chains).toHaveLength(1);
			expect(run.chains[0]).toMatchObject({ chain_id: "entry", status: "success", depth: 0 });
			expect(
				run.chains[0]?.nodes.map((n) => ({ id: n.node_id, status: n.status, outputs: n.outputs })),
			).toEqual([
				{ id: "entry", status: "success", outputs: {} },
				{ id: "a", status: "success", outputs: { n: 1 } },
				{ id: "b", status: "success", outputs: { n: 2 } },
				{ id: "c", status: "success", outputs: { n: 3 } },
			]);
			const attempt = (await api.node(runId, "a")).attempts[0];
			expect(attempt).toMatchObject({
				task_id: a.taskId,
				attempt: 1,
				status: "success",
				agent: "agent-a",
			});
		});

		it("编排级默认 Agent 生效，单个节点另选的 Agent 覆盖默认 Agent", async () => {
			const agentA = await connect({ name: "agent-a" });
			const agentB = await connect({ name: "agent-b" });
			const id = await api.orchestrationWith(
				chain([{ id: "one" }, { id: "two", agent: "agent-b" }, { id: "three" }]),
			);
			const runId = await api.triggerOk(id);

			const one = await agentA.nextAssign();
			expect(one.nodeId).toBe("one");
			await agentA.succeed(one);
			const two = await agentB.nextAssign();
			expect(two.nodeId).toBe("two");
			await agentA.expectNoAssign();
			await agentB.succeed(two);
			const three = await agentA.nextAssign();
			expect(three.nodeId).toBe("three");
			await agentA.succeed(three);

			const nodes = (await api.run(runId)).chains[0]?.nodes ?? [];
			expect(nodes.map((n) => n.agent)).toEqual([null, "agent-a", "agent-b", "agent-a"]);
			expect((await api.run(runId)).status).toBe("success");
		});

		it("目标 Agent 不在线时任务排队，Agent 上线后再派发", async () => {
			await registerOffline("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const runId = await api.triggerOk(id);
			expect((await api.node(runId, "a")).status).toBe("queued");

			const agent = await connect({ name: "agent-a" });
			const a = await agent.nextAssign();
			expect(a.nodeId).toBe("a");
			expect((await api.node(runId, "a")).status).toBe("running");
		});

		it("节点失败时运行标记为 failed，错误类型和信息可以查到", async () => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(chain([{ id: "a" }, { id: "b" }]));
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "assertion failed");
			await agent.expectNoAssign();

			const run = await api.run(runId);
			expect(run.status).toBe("failed");
			expect(run.chains[0]?.status).toBe("failed");
			expect((await api.node(runId, "a")).error).toEqual({
				kind: "node_error",
				message: "assertion failed",
			});
		});

		it("运行不存在时返回 404", async () => {
			expect((await api.get("/runs/00000000-0000-0000-0000-000000000000")).status).toBe(404);
			expect((await api.get("/runs/nope")).status).toBe(404);
		});
	});

	describe("引用解析", () => {
		it("整值引用保持原类型；字符串里的内嵌引用按字符串拼接", async () => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(
				chain(
					[
						{ id: "start" },
						{
							id: "use",
							inputs: {
								port: "${{ nodes.start.outputs.port }}",
								config: "${{ nodes.start.outputs.config }}",
								tags: "${{ nodes.start.outputs.tags }}",
								ok: "${{ nodes.start.outputs.ok }}",
								url: "http://${{ params.host }}:${{ nodes.start.outputs.port }}/api?ok=${{nodes.start.outputs.ok}}",
								nested: { list: ["${{ params.host }}", "x-${{ params.host }}"] },
								constant: 42,
							},
						},
					],
					{ params: [{ name: "host", type: "string", default: "svc" }] },
				),
			);
			const runId = await api.triggerOk(id);
			await agent.succeed(await agent.nextAssign(), {
				port: 8080,
				config: { a: [1, 2] },
				tags: ["x"],
				ok: true,
			});

			const use = await agent.nextAssign();
			expect(use.inputs).toEqual({
				port: 8080,
				config: { a: [1, 2] },
				tags: ["x"],
				ok: true,
				url: "http://svc:8080/api?ok=true",
				nested: { list: ["svc", "x-svc"] },
				constant: 42,
			});
			expect((await api.node(runId, "use")).attempts[0]?.inputs).toEqual(use.inputs);
		});

		it("引用在派发时才解析：使用前面节点实际产生的输出", async () => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(
				chain([{ id: "a" }, { id: "b", inputs: { token: "${{ nodes.a.outputs.token }}" } }]),
			);
			await api.triggerOk(id);
			await agent.succeed(await agent.nextAssign(), { token: "abc-123" });
			expect((await agent.nextAssign()).inputs).toEqual({ token: "abc-123" });
		});

		it.each([
			["引用了本链后面的节点", { v: "${{ nodes.c.outputs.v }}" }, "reference_not_earlier"],
			["引用了不存在的节点", { v: "${{ nodes.zzz.outputs.v }}" }, "reference_unknown_node"],
			["引用了未声明的参数", { v: "${{ params.nope }}" }, "reference_unknown_param"],
			["引用写法不合法", { v: "${{ env.HOME }}" }, "reference_invalid"],
			["引用了未声明的输出键", { v: "${{ nodes.a.outputs.nope }}" }, "reference_unknown_output"],
		])("%s时拒绝触发（静态检查）", async (_name, inputs, code) => {
			await registerOffline("agent-a");
			const id = await api.orchestrationWith(
				chain([{ id: "a" }, { id: "b", inputs }, { id: "c" }]),
			);
			const res = await api.trigger(id);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string; details: unknown } };
			expect(body.error.code).toBe("invalid_orchestration");
			expect(body.error.details).toEqual([expect.objectContaining({ code, node_id: "b" })]);
		});

		it.each([
			["内嵌引用了非标量", { url: "x-${{ nodes.a.outputs.obj }}" }, "scalar"],
			["引用的输出键在运行时缺失", { v: "${{ nodes.a.outputs.missing }}" }, "missing"],
		])("%s时任务以 config_error 失败，不派发", async (_name, inputs, mention) => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(
				chain([{ id: "a" }, { id: "b", inputs }, { id: "c" }]),
			);
			const runId = await api.triggerOk(id);
			await agent.succeed(await agent.nextAssign(), { obj: { k: 1 } });
			await agent.expectNoAssign();

			const b = await api.node(runId, "b");
			expect(b.status).toBe("failed");
			expect(b.error?.kind).toBe("config_error");
			expect(b.error?.message).toContain(mention);
			expect((await api.run(runId)).status).toBe("failed");
		});
	});

	describe("槽位", () => {
		it("每个 Agent 同时运行的任务不超过它的槽位数", async () => {
			const agent = await connect({ name: "agent-a", slots: 2 });
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const runs = [await api.triggerOk(id), await api.triggerOk(id), await api.triggerOk(id)];

			const first = await agent.nextAssign();
			const second = await agent.nextAssign();
			await agent.expectNoAssign();
			const statuses = await Promise.all(runs.map(async (r) => (await api.node(r, "a")).status));
			expect(statuses.sort()).toEqual(["queued", "running", "running"]);

			await agent.succeed(first);
			const third = await agent.nextAssign();
			expect(new Set([first.runId, second.runId, third.runId])).toEqual(new Set(runs));
			await agent.succeed(second);
			await agent.succeed(third);
			for (const r of runs) expect((await api.run(r)).status).toBe("success");
		});

		it("排队的任务按触发顺序派发", async () => {
			await registerOffline("agent-a");
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const runs = [await api.triggerOk(id), await api.triggerOk(id), await api.triggerOk(id)];
			const agent = await connect({ name: "agent-a", slots: 1 });
			for (const runId of runs) {
				const task = await agent.nextAssign();
				expect(task.runId).toBe(runId);
				await agent.succeed(task);
			}
		});
	});

	describe("结果幂等", () => {
		it("同一 task_id + attempt 的结果重复上报只生效一次", async () => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(chain([{ id: "a" }, { id: "b" }]));
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();

			const ack = await agent.succeed(a, { v: 1 });
			expect(ack).toMatchObject({ taskId: a.taskId, attempt: 1 });
			const b = await agent.nextAssign();

			// 重复上报（哪怕内容不同）被确认但不改变状态，也不会再派发一次 b。
			await agent.succeed(a, { v: 999 });
			await agent.fail(a, "late failure");
			await agent.expectNoAssign();
			expect((await api.node(runId, "a")).outputs).toEqual({ v: 1 });
			expect((await api.node(runId, "a")).status).toBe("success");

			await agent.succeed(b);
			await agent.succeed(b);
			expect((await api.run(runId)).status).toBe("success");
		});

		it("attempt 不匹配或任务不存在的结果被忽略", async () => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();

			await agent.succeed({ taskId: a.taskId, attempt: 2 });
			await agent.succeed({ taskId: "00000000-0000-0000-0000-000000000000", attempt: 1 });
			await agent.succeed({ taskId: "not-a-uuid", attempt: 1 });
			expect((await api.node(runId, "a")).status).toBe("running");

			await agent.succeed(a);
			expect((await api.run(runId)).status).toBe("success");
		});

		it("别的 Agent 上报的结果被忽略", async () => {
			const agent = await connect({ name: "agent-a" });
			const other = await connect({ name: "agent-b" });
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();
			await other.succeed(a);
			expect((await api.node(runId, "a")).status).toBe("running");
			await agent.succeed(a);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		});
	});
});
