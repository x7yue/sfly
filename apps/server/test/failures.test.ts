// 切入点 A：失败处理（docs/SEMANTICS.md §3.2、§3.3）——错误分类与重试、跳过与 always、运行状态。
// HTTP API + 讲真实 gRPC 的假 Agent + 真实 PostgreSQL。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { ErrorKind, FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** stub@1.0.0 的 echo 节点声明的输出键。 */
const OUTPUTS = ["v", "obj", "missing"];

/** 入口节点 + 若干 stub/echo 包节点串成的单链。 */
function chain(nodes: Array<Record<string, unknown>>): Record<string, unknown> {
	const all: Array<Record<string, unknown>> = [
		{ id: "entry", kind: "entry", params: [] },
		...nodes.map((n) => ({ kind: "package", package: "stub", node: "echo", ...n })),
	];
	return {
		default_agent: "agent-a",
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { stub: "1.0.0" },
	};
}

describe("失败处理", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: OUTPUTS });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const statuses = async (runId: string) =>
		Object.fromEntries(
			(await api.run(runId)).chains[0]?.nodes.map((n) => [n.node_id, n.status]) ?? [],
		);

	describe("错误分类与重试", () => {
		it.each([
			["node_error", ErrorKind.NODE_ERROR],
			["timeout", ErrorKind.TIMEOUT],
			["agent_lost", ErrorKind.AGENT_LOST],
		])("%s 按 retries 重试：每次重试是新任务、attempt 加 1、派发到同一个 Agent", async (kind, code) => {
			const id = await api.orchestrationWith(
				chain([{ id: "a", retries: 2, inputs: { v: 1 } }, { id: "b" }]),
			);
			const runId = await api.triggerOk(id);

			const seen = [];
			for (let attempt = 1; attempt <= 3; attempt++) {
				const task = await agent.nextAssign();
				expect(task).toMatchObject({ nodeId: "a", attempt });
				expect(task.inputs).toEqual({ v: 1 });
				seen.push(task.taskId);
				await agent.fail(task, `failure ${attempt}`, code);
			}
			expect(new Set(seen).size).toBe(3);
			await agent.expectNoAssign();

			const a = await api.node(runId, "a");
			expect(a.status).toBe("failed");
			expect(a.error).toEqual({ kind, message: "failure 3" });
			expect(
				a.attempts.map((t) => [t.task_id, t.attempt, t.status, t.agent, t.error?.kind]),
			).toEqual(seen.map((taskId, i) => [taskId, i + 1, "failed", "agent-a", kind]));
			expect(a.attempts.map((t) => t.error?.message)).toEqual([
				"failure 1",
				"failure 2",
				"failure 3",
			]);
			expect(await statuses(runId)).toMatchObject({ a: "failed", b: "skipped" });
			expect((await api.run(runId)).status).toBe("failed");
		});

		it("重试成功后链继续执行，运行成功", async () => {
			const id = await api.orchestrationWith(
				chain([
					{ id: "a", retries: 1 },
					{ id: "b", inputs: { v: "${{ nodes.a.outputs.v }}" } },
				]),
			);
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "flaky");
			const retry = await agent.nextAssign();
			expect(retry).toMatchObject({ nodeId: "a", attempt: 2 });
			await agent.succeed(retry, { v: "ok" });

			const b = await agent.nextAssign();
			expect(b).toMatchObject({ nodeId: "b", attempt: 1, inputs: { v: "ok" } });
			await agent.succeed(b);

			const run = await api.run(runId);
			expect(run.status).toBe("success");
			const a = await api.node(runId, "a");
			expect(a.status).toBe("success");
			expect(a.attempts.map((t) => t.status)).toEqual(["failed", "success"]);
		});

		it("没有配置 retries 时默认不重试", async () => {
			const id = await api.orchestrationWith(chain([{ id: "a" }]));
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign());
			await agent.expectNoAssign();
			expect((await api.node(runId, "a")).attempts).toHaveLength(1);
			expect((await api.run(runId)).status).toBe("failed");
		});

		it.each([
			["env_error", ErrorKind.ENV_ERROR],
			["config_error", ErrorKind.CONFIG_ERROR],
		])("%s 不重试", async (kind, code) => {
			const id = await api.orchestrationWith(chain([{ id: "a", retries: 3 }, { id: "b" }]));
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "no", code);
			await agent.expectNoAssign();

			const a = await api.node(runId, "a");
			expect(a.attempts).toHaveLength(1);
			expect(a.error).toEqual({ kind, message: "no" });
			expect(await statuses(runId)).toMatchObject({ a: "failed", b: "skipped" });
			expect((await api.run(runId)).status).toBe("failed");
		});

		it("派发时引用缺失的 config_error 不重试", async () => {
			const id = await api.orchestrationWith(
				chain([
					{ id: "a" },
					{ id: "b", retries: 2, inputs: { v: "${{ nodes.a.outputs.missing }}" } },
				]),
			);
			const runId = await api.triggerOk(id);
			await agent.succeed(await agent.nextAssign(), {});
			await agent.expectNoAssign();
			const b = await api.node(runId, "b");
			expect(b.status).toBe("failed");
			expect(b.error?.kind).toBe("config_error");
			expect(b.attempts).toHaveLength(1);
		});
	});

	describe("跳过与 always", () => {
		it("节点最终失败后普通节点标记为 skipped，always 节点照常执行，运行在所有节点结束后标记为 failed", async () => {
			const id = await api.orchestrationWith(
				chain([
					{ id: "a" },
					{ id: "b" },
					{ id: "c", always: true },
					{ id: "d" },
					{ id: "e", always: true },
				]),
			);
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign(), "boom");

			const c = await agent.nextAssign();
			expect(c.nodeId).toBe("c");
			expect(await statuses(runId)).toEqual({
				entry: "success",
				a: "failed",
				b: "skipped",
				c: "running",
				d: "pending",
				e: "pending",
			});
			// always 节点还在执行，运行还没结束。
			expect((await api.run(runId)).status).toBe("running");

			await agent.succeed(c);
			const e = await agent.nextAssign();
			expect(e.nodeId).toBe("e");
			expect(await statuses(runId)).toMatchObject({ d: "skipped", e: "running" });
			await agent.succeed(e);
			await agent.expectNoAssign();

			const run = await api.run(runId);
			expect(run.status).toBe("failed");
			expect(run.chains[0]?.status).toBe("failed");
			expect(run.ended_at).not.toBeNull();
			// 被跳过的节点没有尝试记录。
			expect((await api.node(runId, "b")).attempts).toEqual([]);
		});

		it("没有失败时 always 节点和普通节点一样按顺序执行", async () => {
			const id = await api.orchestrationWith(
				chain([{ id: "a" }, { id: "b", always: true }, { id: "c" }]),
			);
			const runId = await api.triggerOk(id);
			for (const nodeId of ["a", "b", "c"]) {
				const task = await agent.nextAssign();
				expect(task.nodeId).toBe(nodeId);
				await agent.succeed(task);
			}
			expect((await api.run(runId)).status).toBe("success");
		});

		it("always 节点失败时链标记为失败，后面的 always 节点继续执行、普通节点跳过", async () => {
			const id = await api.orchestrationWith(
				chain([{ id: "a" }, { id: "b", always: true }, { id: "c" }, { id: "d", always: true }]),
			);
			const runId = await api.triggerOk(id);
			await agent.succeed(await agent.nextAssign());
			await agent.fail(await agent.nextAssign(), "cleanup failed");
			const d = await agent.nextAssign();
			expect(d.nodeId).toBe("d");
			await agent.succeed(d);

			expect(await statuses(runId)).toEqual({
				entry: "success",
				a: "success",
				b: "failed",
				c: "skipped",
				d: "success",
			});
			const run = await api.run(runId);
			expect(run.status).toBe("failed");
			expect(run.chains[0]?.status).toBe("failed");
		});

		it("always 节点也按 retries 重试", async () => {
			const id = await api.orchestrationWith(
				chain([{ id: "a" }, { id: "b", always: true, retries: 1 }]),
			);
			const runId = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign());
			await agent.fail(await agent.nextAssign(), "first", ErrorKind.TIMEOUT);
			const retry = await agent.nextAssign();
			expect(retry).toMatchObject({ nodeId: "b", attempt: 2 });
			await agent.succeed(retry);
			expect((await api.run(runId)).status).toBe("failed");
			expect((await api.node(runId, "b")).status).toBe("success");
		});

		it("always 节点引用的上游输出缺失时得到 null", async () => {
			const id = await api.orchestrationWith(
				chain([
					{ id: "a" },
					{ id: "b" },
					{ id: "c" },
					{
						id: "d",
						always: true,
						inputs: {
							ok: "${{ nodes.a.outputs.v }}",
							absent: "${{ nodes.a.outputs.missing }}",
							failed: "${{ nodes.b.outputs.v }}",
							skipped: "${{ nodes.c.outputs.obj }}",
							text: "b=${{ nodes.b.outputs.v }}",
						},
					},
				]),
			);
			const runId = await api.triggerOk(id);
			await agent.succeed(await agent.nextAssign(), { v: 7 });
			await agent.fail(await agent.nextAssign());
			const d = await agent.nextAssign();
			expect(d.nodeId).toBe("d");
			expect(d.inputs).toEqual({
				ok: 7,
				absent: null,
				failed: null,
				skipped: null,
				text: "b=null",
			});
			await agent.succeed(d);
			expect((await api.run(runId)).status).toBe("failed");
		});

		it("普通节点派发时以 config_error 失败后，后面的 always 节点照常执行", async () => {
			const id = await api.orchestrationWith(
				chain([
					{ id: "a" },
					{ id: "b", inputs: { v: "${{ nodes.a.outputs.missing }}" } },
					{ id: "c" },
					{ id: "d", always: true },
				]),
			);
			const runId = await api.triggerOk(id);
			await agent.succeed(await agent.nextAssign(), {});
			const d = await agent.nextAssign();
			expect(d.nodeId).toBe("d");
			expect(await statuses(runId)).toMatchObject({ b: "failed", c: "skipped", d: "running" });
			await agent.succeed(d);
			expect((await api.run(runId)).status).toBe("failed");
		});
	});
});
