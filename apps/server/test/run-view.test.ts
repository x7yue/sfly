// 切入点 A：触发前的预检、运行列表、运行状态的 SSE 推送（#9）。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type RunView } from "./support/api-client.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

interface Preflight {
	version: number;
	params: Array<Record<string, unknown>>;
	problems: Problem[];
}

/** 入口节点 + 若干 stub 包节点串成的单链。 */
function chain(
	nodes: Array<Record<string, unknown>>,
	options: { params?: Array<Record<string, unknown>>; default_agent?: string } = {},
) {
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

describe("运行视图", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text", "n"] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("触发前预检", () => {
		it("给出最新版本号和入口参数声明，检查通过时没有问题", async () => {
			await connect({ name: "agent-a" });
			const params = [
				{ name: "url", type: "string", required: true },
				{ name: "retries", type: "number", default: 3 },
			];
			const id = await api.orchestrationWith(chain([{ id: "a" }], { params }));
			await api.saveVersion(id, chain([{ id: "a" }, { id: "b" }], { params }));

			const preflight = await api.getJson<Preflight>(`/orchestrations/${id}/preflight`);
			expect(preflight).toEqual({
				version: 2,
				params: [
					{ name: "url", type: "string", required: true, secret: false },
					{ name: "retries", type: "number", default: 3, required: false, secret: false },
				],
				problems: [],
			});
		});

		it("结构、引用、包版本校验失败或引用的 Agent 未注册时列出具体原因，并拒绝触发", async () => {
			await connect({ name: "agent-a" });
			const doc = chain([
				{ id: "a", inputs: { v: "${{ params.nope }}" } },
				{ id: "b", agent: "ghost" },
				{ id: "c", node: "missing_type" },
			]);
			doc.nodes.push({ id: "lonely", kind: "package", package: "stub", node: "echo" });
			const id = await api.orchestrationWith(doc);

			const { problems } = await api.getJson<Preflight>(`/orchestrations/${id}/preflight`);
			const found = problems.map((p) => [p.code, p.node_id]);
			expect(found).toEqual(
				expect.arrayContaining([
					["orphan_node", "lonely"],
					["reference_unknown_param", "a"],
					["unknown_node_type", "c"],
					["agent_not_registered", "b"],
				]),
			);
			expect(problems.find((p) => p.code === "agent_not_registered")?.message).toContain("ghost");

			const res = await api.trigger(id);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string; details: Problem[] } };
			expect(body.error.code).toBe("invalid_orchestration");
			expect(body.error.details).toEqual(problems);
			expect(await api.getJson(`/orchestrations/${id}/runs`)).toEqual({ runs: [] });
		});

		it("引用的 Agent 已注册但不在线时可以触发，任务排队", async () => {
			const agent = await connect({ name: "agent-a" });
			await agent.disconnect();
			const id = await api.orchestrationWith(chain([{ id: "a" }]));

			expect((await api.getJson<Preflight>(`/orchestrations/${id}/preflight`)).problems).toEqual(
				[],
			);
			const runId = await api.triggerOk(id);
			expect((await api.node(runId, "a")).status).toBe("queued");
		});

		it("编排还没有版本时预检给出原因；编排不存在时 404", async () => {
			const none = "00000000-0000-0000-0000-000000000000";
			expect((await api.get(`/orchestrations/${none}/runs`)).status).toBe(404);
			const id = await api.createOrchestration("empty");
			expect(await api.getJson<Preflight>(`/orchestrations/${id}/preflight`)).toMatchObject({
				version: 0,
				params: [],
				problems: [{ code: "no_version" }],
			});
			const missing = "00000000-0000-0000-0000-000000000000";
			expect((await api.get(`/orchestrations/${missing}/preflight`)).status).toBe(404);
		});
	});

	describe("运行状态的 SSE 推送", () => {
		const streams: SseClient[] = [];
		afterEach(() => {
			for (const s of streams.splice(0)) s.close();
		});
		const subscribe = async (runId: string) => {
			const sse = await SseClient.open(cp, `/runs/${runId}/events`);
			streams.push(sse);
			return sse;
		};
		/** 等到一条满足条件的 run 推送。 */
		const until = async (sse: SseClient, ok: (run: RunView) => boolean) => {
			for (;;) {
				const { data } = await sse.next<RunView>("run");
				if (ok(data)) return data;
			}
		};
		const statusOf = (run: RunView, nodeId: string) =>
			run.chains[0]?.nodes.find((n) => n.node_id === nodeId)?.status;

		it("订阅时先收到运行的当前状态，之后运行和节点的状态变化都会推送", async () => {
			await (await connect({ name: "agent-a" })).disconnect();
			const id = await api.orchestrationWith(chain([{ id: "a" }, { id: "b" }]));
			const runId = await api.triggerOk(id);

			const sse = await subscribe(runId);
			const snapshot = (await sse.next<RunView>("run")).data;
			expect(snapshot).toEqual(await api.run(runId));
			expect(statusOf(snapshot, "a")).toBe("queued");

			// Agent 上线后派发：a 进入 running。
			const agent = await connect({ name: "agent-a" });
			const a = await agent.nextAssign();
			await until(sse, (run) => statusOf(run, "a") === "running");

			await agent.succeed(a, { n: 1 });
			const afterA = await until(sse, (run) => statusOf(run, "b") === "running");
			expect(statusOf(afterA, "a")).toBe("success");

			await agent.fail(await agent.nextAssign(), "boom");
			const ended = await until(sse, (run) => run.status !== "running");
			expect(ended).toMatchObject({ status: "failed", ended_at: "2026-01-01T00:00:00.000Z" });
			expect(ended.chains[0]?.nodes.find((n) => n.node_id === "b")?.error).toEqual({
				kind: "node_error",
				message: "boom",
			});
			await sse.expectNone(100);
		});

		it("只推送订阅的那个运行；运行不存在时返回 404", async () => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const watched = await api.triggerOk(id);
			const sse = await subscribe(watched);
			await sse.next("run");
			const first = await agent.nextAssign();

			await api.triggerOk(id);
			await agent.succeed(await agent.nextAssign());
			await sse.expectNone(200);

			await agent.succeed(first);
			expect((await until(sse, (run) => run.status === "success")).id).toBe(watched);

			const res = await api.get("/runs/00000000-0000-0000-0000-000000000000/events");
			expect(res.status).toBe(404);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
		});

		it("节点详情里每次尝试都有输入、输出、所在 Agent 和排队 / 开始 / 结束时间", async () => {
			const clock = cp.clock as ManualClock;
			await (await connect({ name: "agent-a" })).disconnect();
			const id = await api.orchestrationWith(
				chain([{ id: "a", inputs: { text: "${{ params.who }}" } }], {
					params: [{ name: "who", type: "string", required: true }],
				}),
			);
			const runId = await api.triggerOk(id, { who: "世界" });
			clock.advance(5_000);
			const agent = await connect({ name: "agent-a" });
			const task = await agent.nextAssign();
			clock.advance(2_000);
			await agent.succeed(task, { text: "你好" });

			const sse = await subscribe(runId);
			const run = (await sse.next<RunView>("run")).data;
			const node = run.chains[0]?.nodes.find((n) => n.node_id === "a");
			expect(node?.attempts).toEqual([
				{
					task_id: task.taskId,
					attempt: 1,
					status: "success",
					agent: "agent-a",
					inputs: { text: "世界" },
					outputs: { text: "你好" },
					error: null,
					queued_at: "2026-01-01T00:00:00.000Z",
					started_at: "2026-01-01T00:00:05.000Z",
					ended_at: "2026-01-01T00:00:07.000Z",
				},
			]);
		});
	});

	describe("运行列表", () => {
		it("按开始时间从新到旧列出运行：触发人、开始时间、结束时间、状态、编排版本", async () => {
			const clock = cp.clock as ManualClock;
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const other = await api.orchestrationWith(chain([{ id: "a" }]));

			const first = await api.triggerOk(id, {});
			clock.advance(90_000);
			await agent.succeed(await agent.nextAssign());
			await api.saveVersion(id, chain([{ id: "a" }, { id: "b" }]));
			clock.advance(10_000);
			const res = await api.trigger(id, {}, "小红");
			const second = ((await res.json()) as { id: string }).id;
			await api.triggerOk(other);

			expect(await api.getJson(`/orchestrations/${id}/runs`)).toEqual({
				runs: [
					{
						id: second,
						orchestration_id: id,
						orchestration_version: 2,
						status: "running",
						triggered_by: "小红",
						started_at: "2026-01-01T00:01:40.000Z",
						ended_at: null,
					},
					{
						id: first,
						orchestration_id: id,
						orchestration_version: 1,
						status: "success",
						triggered_by: "tester",
						started_at: "2026-01-01T00:00:00.000Z",
						ended_at: "2026-01-01T00:01:30.000Z",
					},
				],
			});
		});
	});
});
