// 一次读取的打码工作量预算（#517）：保密值由运行自己提供，值集合可以被凑成让单次调用接近上限的样子（很多很长、开头都一样的值）。
// 一页有几百条动作、上千行日志，每条动作又有名称、字段、失败原因十几处文字：单次调用的上限只管一次调用，几百条加起来
// 要几秒到几十秒，控制面期间不响应。所以一次读取（一页、一份摘要）共用一份预算（扫描和找到的出现位置都计入），用完之后剩下的文字
// 整段盖住；一次调用里读的几个运行各一份（一个运行再病态，也不牵连同一次读取里别的运行）。
// 这里用真实的控制面和假 Agent 量：读一页动作、读摘要，每一步的耗时都有上限；病态的运行和正常的运行同时读，正常的一个字不少。
// 值都是明显的假值。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { ACTION_LIMITS, SECRET_MASK as MASK } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { publishBench } from "./support/focus-items.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("病态的 secret 值集合：一次读取、一次写入的同步耗时有上限", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 8 }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 确定的伪随机，不用 Math.random：失败了能重现。 */
	let seed = 11;
	const random = (n: number): number => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return Math.floor((seed / 4294967296) * n);
	};
	const word = (n: number) =>
		Array.from({ length: n }, () => "bcdefghijklmnopqrstuvwxyz"[random(25)]).join("");

	/** 开头都是同样的一长串 a、最后几位不同的 500 个各 1000 个字符的值：和文字比较时每个正则都要比很久。 */
	const pathologicalValues = () =>
		Array.from({ length: 500 }, (_, i) => `${"a".repeat(980)}${word(16)}${i % 10}${i}`);

	/** 保密值后来才知道的场景：cfg 不是 secret，经参数映射传给子流程 subB 的 secret 参数 k 之后，它的值才是 secret 值。 */
	const lateDoc = () => ({
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [{ name: "cfg", type: "json" }] },
			{ id: "x1", kind: "async", params: {} },
			{ id: "subA", kind: "subflow_entry", name: "A", params: [] },
			{ id: "sa", kind: "package", package: "bench", node: "load" },
			{ id: "b", kind: "package", package: "bench", node: "probe" },
			{ id: "x2", kind: "async", params: { k: "${{ params.cfg }}" } },
			{
				id: "subB",
				kind: "subflow_entry",
				name: "B",
				params: [{ name: "k", type: "json", secret: true }],
			},
		],
		edges: [
			{ from: "entry", to: "x1", kind: "chain" },
			{ from: "x1", to: "b", kind: "chain" },
			{ from: "b", to: "x2", kind: "chain" },
			{ from: "x1", to: "subA", kind: "dispatch" },
			{ from: "subA", to: "sa", kind: "chain" },
			{ from: "x2", to: "subB", kind: "dispatch" },
		],
		packages: { bench: "1.0.0" },
	});

	/** `count` 条动作，每条的名称、8 个字段（键和值）、失败原因都是到了上限、前面全是 a、最后一个字符是 b 的文字：每一处都要扫很久。 */
	const actionEvents = (count: number) => {
		const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const name = `${"a".repeat(nameChars - 1)}b`;
		const value = `${"a".repeat(valueChars - 1)}b`;
		const reason = `${"a".repeat(reasonChars - 2)}b…`;
		const fields = Object.fromEntries(
			Array.from({ length: 8 }, (_, f) => [`${"a".repeat(nameChars - 2)}b${f}`, value]),
		);
		return Array.from({ length: count }, (_, i) => [
			agent.actionStart(i + 1, name, t0 + i * 10, { fields }),
			agent.actionEnd(i + 1, "failed", t0 + i * 10 + 5, { reason }),
		]).flat();
	};

	/** 动作摘要：1 个正在做的、最近结束的 20 个、最近失败的 5 个，文字同 {@link actionEvents}。 */
	const sendSummary = (task: AssignedTask) => {
		const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const name = `${"a".repeat(nameChars - 1)}b`;
		const value = `${"a".repeat(valueChars - 1)}b`;
		const fields = Object.fromEntries(
			Array.from({ length: 8 }, (_, f) => [`${"a".repeat(nameChars - 2)}b${f}`, value]),
		);
		const end = agent.stamp(t0 + 5_000);
		const running = { id: 1, parent: null, depth: 0, name, fields, ...agent.stamp(t0) };
		const ended = (id: number) => ({
			...running,
			id,
			...agent.stamp(t0 + id),
			end_ts: end.ts,
			end_mono: end.mono,
			result: "failed" as const,
			reason: `${"a".repeat(reasonChars - 2)}b…`,
		});
		const zero = { reported: 200, capped_ts: null, capped_mono: null, failed: 200 };
		agent.actionSummary(task, {
			total: 200,
			reported: 200,
			names: [{ name, total: 200, ...zero }],
			running: [running],
			recent: Array.from({ length: 20 }, (_, i) => ended(i + 2)),
			recent_failed: Array.from({ length: 5 }, (_, i) => ended(i + 30)),
		});
	};

	/** 读一页动作和动作摘要，每一步的耗时都有上限；用完预算之后剩下的整段盖住。 */
	const expectFastReads = async (taskId: string) => {
		const readStarted = performance.now();
		const res = await cp.fetch(`/tasks/${taskId}/actions?limit=200`);
		const page = (await res.json()) as { actions: Array<{ name: string }> };
		const read = performance.now() - readStarted;
		expect(res.status).toBe(200);
		expect(page.actions.length).toBeGreaterThan(0);
		expect(read, "读一页 200 条").toBeLessThan(2000);
		// 用完预算之后剩下的整段盖住：不是原样放过
		expect(page.actions.some((a) => a.name === MASK)).toBe(true);

		const summaryStarted = performance.now();
		const summary = await cp.fetch(`/tasks/${taskId}/actions/summary`);
		const body = (await summary.json()) as { recent: unknown[]; running: unknown[] };
		expect(summary.status).toBe(200);
		expect(body.recent.length).toBe(20);
		expect(performance.now() - summaryStarted, "读摘要").toBeLessThan(2000);
	};

	it("保密值从一开始就知道：读一页动作、读摘要，每一步都很快", async () => {
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "cfg", type: "json", secret: true }] },
				{ id: "sa", kind: "package", package: "bench", node: "load" },
			],
			edges: [{ from: "entry", to: "sa", kind: "chain" }],
			packages: { bench: "1.0.0" },
		});
		await api.triggerOk(id, { cfg: pathologicalValues() });
		const task = await agent.nextAssign();
		// 写入时的打码不带预算，和 dev 一样；写得少一点，这条测的是读取
		agent.actions(task, actionEvents(60));
		sendSummary(task);
		await agent.sync({ timeoutMs: 60_000 });
		await expectFastReads(task.taskId);
	}, 120_000);

	it("保密值后来才知道（子流程创建之后）：动作已经原样写下，读一页、读摘要，每一步都很快", async () => {
		const id = await api.orchestrationWith(lateDoc());
		const runId = await api.triggerOk(id, { cfg: pathologicalValues() });
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
		// 写入时这些值还不是 secret 值：文字原样写下，读的时候才每一处都要和这一千个值比
		agent.actions(sa, actionEvents(200));
		sendSummary(sa);
		await agent.sync();
		await agent.succeed(b);
		await eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);
		await expectFastReads(sa.taskId);
	}, 120_000);

	/** 保密值开头都是同样的一长串 a 的病态运行：触发之后，sa 在跑，b 结束，子流程 subB 创建，值才成为 secret 值。 */
	const startPathologicalRun = async () => {
		const id = await api.orchestrationWith(lateDoc());
		const runId = await api.triggerOk(id, {
			cfg: Array.from({ length: 500 }, (_, i) => `${"a".repeat(980)}${word(16)}${i % 10}${i}`),
		});
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
		return { runId, sa, b };
	};
	const subflowCreated = (runId: string) =>
		eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);

	/** 正常的运行：一个 secret 参数，一个节点（返回它的任务）。 */
	const startNormalRun = async (token: string) => {
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "token", type: "string", secret: true }] },
				{ id: "n", kind: "package", package: "bench", node: "load" },
			],
			edges: [{ from: "entry", to: "n", kind: "chain" }],
			packages: { bench: "1.0.0" },
		});
		const runId = await api.triggerOk(id, { token });
		return { runId, task: await agent.nextAssign() };
	};

	it("同一次读取里几个运行（控制台的最近失败）：一个运行的保密值再病态，也只盖住它自己的内容，别的运行一个字不少", async () => {
		const normal = [] as Array<{ runId: string; token: string }>;
		const failNormal = async (token: string) => {
			const { runId, task } = await startNormalRun(token);
			await agent.fail(task, `boom ${token} end`);
			normal.push({ runId, token });
		};
		await failNormal("test-normal-value-1");
		await failNormal("test-normal-value-2");
		const pathological = await startPathologicalRun();
		await agent.succeed(pathological.b);
		await subflowCreated(pathological.runId);
		// 病态的运行里一条 30 万个字符的失败信息：写入时那些值还不是 secret 值，原样存下，读的时候一条就用光这个运行的预算
		await agent.fail(pathological.sa, "a".repeat(300_000));
		await failNormal("test-normal-value-3");
		await failNormal("test-normal-value-4");
		await eventually(async () => expect((await api.run(pathological.runId)).status).toBe("failed"));

		const started = performance.now();
		const res = await cp.fetch("/dashboard");
		const dashboard = (await res.json()) as {
			recent_ended: Array<{ id: string; failure: { error: { message: string } | null } | null }>;
		};
		expect(performance.now() - started, "读控制台").toBeLessThan(3000);
		const messageOf = (runId: string) =>
			dashboard.recent_ended.find((r) => r.id === runId)?.failure?.error?.message;
		// 病态的运行：用光了自己的预算，整段盖住
		expect(messageOf(pathological.runId)).toBe(MASK);
		// 同一次读取里别的运行：只有它们自己的保密值被盖住，周围的文字都在
		for (const { runId } of normal) expect(messageOf(runId), runId).toBe(`boom ${MASK} end`);
	}, 120_000);

	it("Agent 列表里几个运行占着槽位：病态的运行用光自己的预算，别的运行的进度说明一个字不少", async () => {
		const pathological = await startPathologicalRun();
		agent.progress(pathological.sa, 1, 2, "a".repeat(300_000));
		await agent.succeed(pathological.b);
		await subflowCreated(pathological.runId);
		const normal = [] as string[];
		for (const token of ["test-normal-value-1", "test-normal-value-2"]) {
			const { runId, task } = await startNormalRun(token);
			agent.progress(task, 1, 2, `step ${token}`);
			normal.push(runId);
		}
		const read = async () => {
			const res = await cp.fetch("/agents");
			const body = (await res.json()) as {
				agents: Array<{
					running_tasks: Array<{ run_id: string; progress: { message: string } | null }>;
				}>;
			};
			return body.agents.flatMap((a) => a.running_tasks);
		};
		const progressOf = (tasks: Awaited<ReturnType<typeof read>>, runId: string) =>
			tasks.find((t) => t.run_id === runId)?.progress?.message;
		await eventually(async () => {
			const tasks = await read();
			expect(progressOf(tasks, normal[0] as string)).toBeDefined();
			expect(progressOf(tasks, normal[1] as string)).toBeDefined();
			expect(progressOf(tasks, pathological.runId)).toBeDefined();
		});
		const started = performance.now();
		const tasks = await read();
		expect(performance.now() - started, "读 Agent 列表").toBeLessThan(3000);
		expect(progressOf(tasks, pathological.runId)).toBe(MASK);
		for (const runId of normal) expect(progressOf(tasks, runId), runId).toBe(`step ${MASK}`);
	}, 120_000);
});
