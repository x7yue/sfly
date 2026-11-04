// 切入点 A：异步任务节点与子流程（docs/SEMANTICS.md §1.2、§2.3、§4、§6.4）。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type ChainView, type RunView } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

type Node = Record<string, unknown> & { id: string };

/** 包节点：stub/echo。 */
const echo = (id: string, inputs: Record<string, unknown> = {}): Node => ({
	id,
	kind: "package",
	package: "stub",
	node: "echo",
	inputs,
});
const spawn = (id: string, params: Record<string, unknown> = {}): Node => ({
	id,
	kind: "async",
	params,
});
const param = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	type: "string",
	...extra,
});

/**
 * 由若干条链组成的编排：每条链是按顺序排列的节点（第一个是起点）；
 * dispatch 为 [异步任务节点, 子流程入口节点]。
 */
function orchestration(chains: Node[][], dispatch: Array<[string, string]>) {
	return {
		default_agent: "agent-a",
		nodes: chains.flat(),
		edges: [
			...chains.flatMap((c) =>
				c.slice(1).map((n, i) => ({ from: c[i]?.id, to: n.id, kind: "chain" })),
			),
			...dispatch.map(([from, to]) => ({ from, to, kind: "dispatch" })),
		],
		packages: { stub: "1.0.0" },
	};
}

const chainOf = (run: RunView, chainId: string): ChainView => {
	const chain = run.chains.find((c) => c.chain_id === chainId);
	if (!chain) throw new Error(`chain ${chainId} not in run ${run.id}`);
	return chain;
};
const statuses = (chain: ChainView) =>
	Object.fromEntries(chain.nodes.map((n) => [n.node_id, n.status]));

describe("异步任务节点与子流程", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 8 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 依次收下 n 个派发，按节点 ID 返回。 */
	async function assigns(n: number): Promise<Record<string, AssignedTask>> {
		const out: Record<string, AssignedTask> = {};
		for (let i = 0; i < n; i++) {
			const task = await agent.nextAssign();
			out[task.nodeId] = task;
		}
		return out;
	}

	it("嵌套两层：参数按值传入子流程，异步任务节点立即成功并输出子流程实例 ID，主链不等待", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[
						{ id: "entry", kind: "entry", params: [param("p")] },
						echo("a"),
						spawn("spawn1", { x: "${{ nodes.a.outputs.v }}", y: "${{ params.p }}" }),
						echo("b", { v: "main-${{ params.p }}" }),
					],
					[
						{ id: "sub1", kind: "subflow_entry", params: [param("x"), param("y")] },
						echo("c", { v: "${{ params.x }}/${{ params.y }}" }),
						spawn("spawn2", { z: "${{ nodes.c.outputs.v }}" }),
					],
					[
						{ id: "sub2", kind: "subflow_entry", params: [param("z", { required: true })] },
						echo("d", { v: "${{ params.z }}" }),
					],
				],
				[
					["spawn1", "sub1"],
					["spawn2", "sub2"],
				],
			),
		);
		const runId = await api.triggerOk(id, { p: "P" });
		await agent.succeed(await agent.nextAssign(), { v: "A" });

		// 主链和子流程的第一个包节点同时派发。
		const first = await assigns(2);
		expect(first.b?.inputs).toEqual({ v: "main-P" });
		expect(first.c?.inputs).toEqual({ v: "A/P" });

		let run = await api.run(runId);
		const main = chainOf(run, "entry");
		const sub1 = chainOf(run, "sub1");
		expect(main).toMatchObject({ depth: 0, parent_chain_instance_id: null, async_node_id: null });
		expect(sub1).toMatchObject({
			depth: 1,
			parent_chain_instance_id: main.id,
			async_node_id: "spawn1",
			status: "running",
			params: { x: "A", y: "P" },
		});
		const spawn1 = main.nodes.find((n) => n.node_id === "spawn1");
		expect(spawn1).toMatchObject({
			kind: "async",
			status: "success",
			outputs: { chain_instance_id: sub1.id },
		});
		// 每条链只列出自己的节点。
		expect(sub1.nodes.map((n) => n.node_id)).toEqual(["sub1", "c", "spawn2"]);
		expect(statuses(sub1)).toEqual({ sub1: "success", c: "running", spawn2: "pending" });

		// 主链先结束，运行仍在进行。
		await agent.succeed(first.b as AssignedTask);
		run = await api.run(runId);
		expect(chainOf(run, "entry").status).toBe("success");
		expect(run.status).toBe("running");
		expect(run.ended_at).toBeNull();

		await agent.succeed(first.c as AssignedTask, { v: "C" });
		const d = await agent.nextAssign();
		expect(d).toMatchObject({ nodeId: "d", inputs: { v: "C" } });
		run = await api.run(runId);
		const sub2 = chainOf(run, "sub2");
		expect(sub2).toMatchObject({
			depth: 2,
			parent_chain_instance_id: chainOf(run, "sub1").id,
			async_node_id: "spawn2",
			params: { z: "C" },
		});
		expect(chainOf(run, "sub1").status).toBe("success");
		expect(run.status).toBe("running");

		await agent.succeed(d);
		run = await api.run(runId);
		expect(run.chains.map((c) => [c.chain_id, c.status])).toEqual([
			["entry", "success"],
			["sub1", "success"],
			["sub2", "success"],
		]);
		expect(new Set(run.chains.map((c) => c.id)).size).toBe(3);
		expect(run.status).toBe("success");
		expect(run.ended_at).not.toBeNull();
		await agent.expectNoAssign();
	});

	it("子流程实例 ID 由运行、父链实例和异步任务节点确定：不同运行不同，同一运行里每个子流程只有一个实例", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawn("spawn")],
					[{ id: "sub", kind: "subflow_entry", params: [] }, echo("c")],
				],
				[["spawn", "sub"]],
			),
		);
		const ids: string[] = [];
		for (let i = 0; i < 2; i++) {
			const runId = await api.triggerOk(id);
			const c = await agent.nextAssign();
			expect(c.nodeId).toBe("c");
			await agent.succeed(c);
			const run = await api.run(runId);
			expect(run.chains).toHaveLength(2);
			const sub = chainOf(run, "sub");
			expect(chainOf(run, "entry").nodes[1]?.outputs).toEqual({ chain_instance_id: sub.id });
			expect(sub.id).not.toBe(chainOf(run, "entry").id);
			ids.push(sub.id);
			expect(run.status).toBe("success");
		}
		expect(ids[0]).not.toBe(ids[1]);
	});

	it("子流程里的 Sleep 节点：时长引用子流程参数，只让子流程等待，到点后子流程继续，运行在子流程结束后才结束", async () => {
		const clock = cp.clock as ManualClock;
		const start = clock.now().getTime();
		const id = await api.orchestrationWith(
			orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawn("spawn", { wait: "10m" }), echo("b")],
					[
						{ id: "sub", kind: "subflow_entry", params: [param("wait", { required: true })] },
						{ id: "s", kind: "sleep", always: false, duration: "${{ params.wait }}" },
						echo("c"),
					],
				],
				[["spawn", "sub"]],
			),
		);
		const runId = await api.triggerOk(id);

		// 主链不受子流程里的等待影响。
		const b = await agent.nextAssign();
		expect(b.nodeId).toBe("b");
		await agent.succeed(b);

		let run = await api.run(runId);
		expect(chainOf(run, "entry").status).toBe("success");
		const sub = chainOf(run, "sub");
		expect(sub.status).toBe("running");
		expect(statuses(sub)).toEqual({ sub: "success", s: "waiting", c: "pending" });
		expect(sub.nodes.find((n) => n.node_id === "s")?.attempts[0]).toMatchObject({
			status: "waiting",
			agent: null,
			wake_at: new Date(start + 10 * 60_000).toISOString(),
		});
		expect(run.status).toBe("running");

		clock.advance(10 * 60_000 - 1000);
		await agent.expectNoAssign(150);
		clock.advance(1000);
		const c = await agent.nextAssign();
		expect(c.nodeId).toBe("c");
		run = await api.run(runId);
		expect(chainOf(run, "sub").nodes.find((n) => n.node_id === "s")).toMatchObject({
			status: "success",
			outputs: { triggered_at: new Date(start + 10 * 60_000).toISOString() },
		});
		await agent.succeed(c);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
		expect(chainOf(await api.run(runId), "sub").status).toBe("success");
	});

	it("子流程失败不影响主链；所有链结束后运行为 failed", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawn("spawn"), echo("b"), echo("b2")],
					[{ id: "sub", kind: "subflow_entry", params: [] }, echo("c"), echo("c2")],
				],
				[["spawn", "sub"]],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(2);
		await agent.fail(first.c as AssignedTask, "sub boom");

		let run = await api.run(runId);
		expect(chainOf(run, "sub").status).toBe("failed");
		expect(statuses(chainOf(run, "sub"))).toMatchObject({ c: "failed", c2: "skipped" });
		expect(chainOf(run, "entry").status).toBe("running");
		expect(run.status).toBe("running");

		await agent.succeed(first.b as AssignedTask);
		const b2 = await agent.nextAssign();
		expect(b2.nodeId).toBe("b2");
		await agent.succeed(b2);

		run = await api.run(runId);
		expect(chainOf(run, "entry").status).toBe("success");
		expect(run.status).toBe("failed");
		expect(run.ended_at).not.toBeNull();
	});

	it("主链失败不取消子流程：运行等子流程结束后才结束", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawn("spawn"), echo("b"), echo("b2")],
					[{ id: "sub", kind: "subflow_entry", params: [] }, echo("c"), echo("c2")],
				],
				[["spawn", "sub"]],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(2);
		await agent.fail(first.b as AssignedTask, "main boom");

		let run = await api.run(runId);
		expect(chainOf(run, "entry").status).toBe("failed");
		expect(statuses(chainOf(run, "entry"))).toMatchObject({ b: "failed", b2: "skipped" });
		expect(chainOf(run, "sub").status).toBe("running");
		expect(run.status).toBe("running");

		// 子流程照常推进。
		await agent.succeed(first.c as AssignedTask);
		const c2 = await agent.nextAssign();
		expect(c2.nodeId).toBe("c2");
		run = await api.run(runId);
		expect(run.status).toBe("running");
		await agent.succeed(c2);

		run = await api.run(runId);
		expect(chainOf(run, "sub").status).toBe("success");
		expect(run.status).toBe("failed");
		expect(run.ended_at).not.toBeNull();
	});

	it("前面的节点失败时异步任务节点被跳过，子流程不会被触发", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, echo("a"), spawn("spawn")],
					[{ id: "sub", kind: "subflow_entry", params: [] }, echo("c")],
				],
				[["spawn", "sub"]],
			),
		);
		const runId = await api.triggerOk(id);
		await agent.fail(await agent.nextAssign(), "boom");
		await agent.expectNoAssign();

		const run = await api.run(runId);
		expect(run.chains.map((c) => c.chain_id)).toEqual(["entry"]);
		expect(statuses(chainOf(run, "entry"))).toEqual({
			entry: "success",
			a: "failed",
			spawn: "skipped",
		});
		expect(run.status).toBe("failed");
	});

	it("映射的值不符合子流程参数类型时，异步任务节点以 config_error 失败", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[
						{ id: "entry", kind: "entry", params: [] },
						echo("a"),
						spawn("spawn", { n: "${{ nodes.a.outputs.v }}" }),
						echo("b"),
					],
					[
						{ id: "sub", kind: "subflow_entry", params: [param("n", { type: "number" })] },
						echo("c"),
					],
				],
				[["spawn", "sub"]],
			),
		);
		const runId = await api.triggerOk(id);
		await agent.succeed(await agent.nextAssign(), { v: "not a number" });
		await agent.expectNoAssign();

		const run = await api.run(runId);
		expect(run.chains.map((c) => c.chain_id)).toEqual(["entry"]);
		const node = chainOf(run, "entry").nodes.find((n) => n.node_id === "spawn");
		expect(node?.status).toBe("failed");
		expect(node?.error?.kind).toBe("config_error");
		expect(node?.error?.message).toContain("n");
		expect(statuses(chainOf(run, "entry"))).toMatchObject({ b: "skipped" });
		expect(run.status).toBe("failed");
	});

	it("取消运行时主链和子流程一起取消：各链的 always 节点照常执行，未到达的异步任务节点不再触发子流程", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[
						{ id: "entry", kind: "entry", params: [] },
						spawn("spawn"),
						echo("b"),
						{ ...echo("b2"), always: true },
					],
					[
						{ id: "sub", kind: "subflow_entry", params: [] },
						echo("c"),
						spawn("spawn2"),
						{ ...echo("c2"), always: true },
						echo("c3"),
					],
					[{ id: "sub2", kind: "subflow_entry", params: [] }, echo("d")],
				],
				[
					["spawn", "sub"],
					["spawn2", "sub2"],
				],
			),
		);
		const runId = await api.triggerOk(id);
		const first = await assigns(2);

		await api.cancelOk(runId);
		const cancels = [await agent.nextCancel(), await agent.nextCancel()];
		expect(new Set(cancels.map((c) => c.taskId))).toEqual(
			new Set([first.b?.taskId, first.c?.taskId]),
		);
		await agent.cancelled(first.b as AssignedTask);
		await agent.cancelled(first.c as AssignedTask);

		const cleanup = await assigns(2);
		expect(Object.keys(cleanup).sort()).toEqual(["b2", "c2"]);
		let run = await api.run(runId);
		expect(run.status).toBe("running");
		await agent.succeed(cleanup.b2 as AssignedTask);
		await agent.succeed(cleanup.c2 as AssignedTask);
		await agent.expectNoAssign();

		run = await api.run(runId);
		expect(run.status).toBe("cancelled");
		expect(run.chains.map((c) => [c.chain_id, c.status])).toEqual([
			["entry", "cancelled"],
			["sub", "cancelled"],
		]);
		expect(statuses(chainOf(run, "entry"))).toEqual({
			entry: "success",
			spawn: "success",
			b: "cancelled",
			b2: "success",
		});
		expect(statuses(chainOf(run, "sub"))).toEqual({
			sub: "success",
			c: "cancelled",
			spawn2: "cancelled",
			c2: "success",
			c3: "cancelled",
		});
	});

	it("运行的 SSE 推送包含子流程实例的状态变化", async () => {
		const id = await api.orchestrationWith(
			orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawn("spawn")],
					[{ id: "sub", kind: "subflow_entry", params: [] }, echo("c")],
				],
				[["spawn", "sub"]],
			),
		);
		const runId = await api.triggerOk(id);
		const sse = await SseClient.open(cp, `/runs/${runId}/events`);
		try {
			const until = async (ok: (run: RunView) => boolean) => {
				for (;;) {
					const { data } = await sse.next<RunView>("run");
					if (ok(data)) return data;
				}
			};
			await until((r) => r.chains.some((c) => c.chain_id === "sub" && c.status === "running"));
			await agent.succeed(await agent.nextAssign());
			const done = await until((r) => r.status === "success");
			expect(done.chains.map((c) => [c.chain_id, c.status])).toEqual([
				["entry", "success"],
				["sub", "success"],
			]);
		} finally {
			sse.close();
		}
	});
});

describe("子流程的静态检查（保存时警告，触发时阻断）", () => {
	let cp: TestControlPlane;
	let api: ApiClient;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		await agent.disconnect();
	});
	afterEach(async () => {
		await cp.close();
	});

	interface Problem {
		code: string;
		message: string;
		node_id?: string;
	}
	async function problems(document: unknown): Promise<Problem[]> {
		const id = await api.orchestrationWith(document);
		const res = await api.trigger(id);
		if (res.status === 201) return [];
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; details: Problem[] } };
		expect(body.error.code).toBe("invalid_orchestration");
		return body.error.details;
	}

	it("子流程可以触发运行：预检通过", async () => {
		const doc = orchestration(
			[
				[{ id: "entry", kind: "entry", params: [] }, spawn("spawn", { x: "1" })],
				[{ id: "sub", kind: "subflow_entry", params: [param("x")] }, echo("c")],
			],
			[["spawn", "sub"]],
		);
		const id = await api.orchestrationWith(doc);
		const preflight = await api.getJson<{ problems: Problem[] }>(`/orchestrations/${id}/preflight`);
		expect(preflight.problems).toEqual([]);
	});

	it("嵌套超过 3 层时报错", async () => {
		/** 嵌套 depth 层的编排：每层子流程里放一个异步任务节点触发下一层，最内层放一个包节点。 */
		const nested = (depth: number) => {
			const levels = Array.from({ length: depth }, (_, i) => i + 1);
			return orchestration(
				[
					[{ id: "entry", kind: "entry", params: [] }, spawn("spawn0")],
					...levels.map((l) => [
						{ id: `sub${l}`, kind: "subflow_entry", params: [] },
						l < depth ? spawn(`spawn${l}`) : echo(`leaf${l}`),
					]),
				],
				levels.map((l): [string, string] => [`spawn${l - 1}`, `sub${l}`]),
			);
		};
		expect(await problems(nested(3))).toEqual([]);
		expect(await problems(nested(4))).toEqual([
			expect.objectContaining({ code: "nesting_too_deep", node_id: "sub4" }),
		]);
	});

	it("子流程入口节点只能被一个异步任务节点连接", async () => {
		const doc = orchestration(
			[
				[{ id: "entry", kind: "entry", params: [] }, spawn("s1"), spawn("s2")],
				[{ id: "sub", kind: "subflow_entry", params: [] }, echo("c")],
			],
			[
				["s1", "sub"],
				["s2", "sub"],
			],
		);
		expect((await problems(doc)).map((p) => p.code)).toContain("subflow_multiple_triggers");
	});

	it("子流程看不到主链的数据：引用主链参数或主链节点的输出会被拒绝", async () => {
		const doc = orchestration(
			[
				[{ id: "entry", kind: "entry", params: [param("p")] }, echo("a"), spawn("spawn")],
				[
					{ id: "sub", kind: "subflow_entry", params: [] },
					echo("c", { x: "${{ params.p }}", y: "${{ nodes.a.outputs.v }}" }),
				],
			],
			[["spawn", "sub"]],
		);
		expect((await problems(doc)).map((p) => [p.code, p.node_id])).toEqual([
			["reference_unknown_param", "c"],
			["reference_not_earlier", "c"],
		]);
	});

	it("参数映射只能映射子流程入口声明的参数，必填参数必须映射", async () => {
		const doc = orchestration(
			[
				[{ id: "entry", kind: "entry", params: [] }, spawn("spawn", { nope: "1" })],
				[
					{
						id: "sub",
						kind: "subflow_entry",
						params: [
							param("need", { required: true }),
							param("opt"),
							param("dflt", { required: true, default: "d" }),
						],
					},
					echo("c"),
				],
			],
			[["spawn", "sub"]],
		);
		expect((await problems(doc)).map((p) => [p.code, p.node_id])).toEqual([
			["subflow_param_unknown", "spawn"],
			["subflow_param_missing", "spawn"],
		]);
	});
});
