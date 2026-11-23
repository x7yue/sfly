// 一次读取的打码预算（#517）：一页有几百条动作、上千行日志，每条动作又有名称、字段、失败原因十几处文字，扫描虽然是线性的，
// 同步执行的时间还是它们的总和，所以一次读取（一页、一份摘要）共用一份预算（扫过的字符数、完整的出现的段数），用完之后剩下的文字
// 整段盖住；一次调用里读的几个运行各一份（一个运行用完了，也不牵连同一次读取里别的运行）；一个运行的值集合大到建不了自动机，
// 它的文字整段盖住，也只影响它自己。
// 真实的上限要几千万个字符才碰得到：这里把上限调小（`secretLimits`，只给测试用，控制面和测试在同一个进程里），用真实的控制面和
// 假 Agent 验证每个读取出口都取了预算：读一页动作、读摘要、读控制台、读 Agent 列表。值都是明显的假值。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { ACTION_LIMITS, SECRET_MASK as MASK } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { publishBench } from "./support/focus-items.js";
import { withSecretLimits } from "./support/secret-limits.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("读取的预算和值集合的大小：每个读取出口都有上限，一个运行用完或太大，只盖住它自己", () => {
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

	/** 读取预算调成 5 万个字符：每条动作的文字约 6.7 K，几条就用完；一个运行的值集合所有写法合计超过 3000 个字符就建不了自动机。 */
	const LIMITS = { readChars: 50_000, automatonChars: 3000 };

	const smallValues = () => [
		"fake-secret-value-one",
		"fake-secret-value-two",
		"fake-secret-value-3",
	];
	/** 值集合大到（上限调成 3000）建不了自动机的运行：50 个各 100 多个字符的值，`tag` 让每个测试的值不一样（值集合按值缓存）。 */
	const oversizeValues = (tag: string) =>
		Array.from({ length: 50 }, (_, i) => `fake-oversize-${tag}-${i}-${"p".repeat(100)}`);

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

	/** `count` 条动作，每条的名称、8 个字段（键和值）、失败原因都到了上限：每条约 6.7 K 个字符。 */
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

	/** 读一页动作和动作摘要：前面的原样，用完预算之后剩下的整段盖住（原文里没有掩码，确定的证据，不看耗时）。 */
	const expectBudgetedReads = async (taskId: string) => {
		const res = await cp.fetch(`/tasks/${taskId}/actions?limit=200`);
		expect(res.status).toBe(200);
		const page = (await res.json()) as { actions: Array<{ name: string }> };
		const masked = page.actions.filter((a) => a.name === MASK).length;
		expect(page.actions.length - masked, "预算用完之前的原样").toBeGreaterThan(0);
		expect(masked, "用完之后的整段盖住").toBeGreaterThan(0);

		const summary = await cp.fetch(`/tasks/${taskId}/actions/summary`);
		const body = (await summary.json()) as { recent: unknown[]; running: unknown[] };
		expect(summary.status).toBe(200);
		expect(body.recent.length).toBe(20);
		// 读摘要也用预算：26 条各约 6.7 K 个字符，5 万个字符的预算用不完它们
		expect(JSON.stringify(body)).toContain(MASK);
	};

	it("保密值从一开始就知道：读一页动作、读摘要，用完预算之后剩下的整段盖住", async () => {
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "cfg", type: "json", secret: true }] },
				{ id: "sa", kind: "package", package: "bench", node: "load" },
			],
			edges: [{ from: "entry", to: "sa", kind: "chain" }],
			packages: { bench: "1.0.0" },
		});
		await api.triggerOk(id, { cfg: smallValues() });
		const task = await agent.nextAssign();
		// 写入时的打码不带预算
		agent.actions(task, actionEvents(60));
		sendSummary(task);
		await agent.sync({ timeoutMs: 60_000 });
		await withSecretLimits(LIMITS, () => expectBudgetedReads(task.taskId));
	}, 120_000);

	it("保密值后来才知道（子流程创建之后）：动作已经原样写下，读一页、读摘要，用完预算之后剩下的整段盖住", async () => {
		const id = await api.orchestrationWith(lateDoc());
		const runId = await api.triggerOk(id, { cfg: smallValues() });
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
		// 写入时这些值还不是 secret 值：文字原样写下，读的时候才每一处都要打一遍
		agent.actions(sa, actionEvents(60));
		sendSummary(sa);
		await agent.sync();
		await agent.succeed(b);
		await eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);
		await withSecretLimits(LIMITS, () => expectBudgetedReads(sa.taskId));
	}, 120_000);

	/** 触发之后，sa 在跑，b 结束，子流程 subB 创建，`values` 才成为 secret 值。 */
	const startLateRun = async (values: unknown[]) => {
		const id = await api.orchestrationWith(lateDoc());
		const runId = await api.triggerOk(id, { cfg: values });
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

	it("同一次读取里几个运行（控制台的最近失败）：每个运行各一份预算；一个运行用光了、另一个的值集合太大，都只盖住它们自己，别的运行一个字不少", async () => {
		// 整个测试都在调小的上限下：值集合是在第一次用到时建自动机的，建的时候就要按这个上限判断大小
		await withSecretLimits(LIMITS, async () => {
			// 每个正常的运行的失败信息 3 万个字符：两个加起来超过一份预算（5 万），各用各的就都不到
			const filler = "y".repeat(30_000);
			const normal = [] as Array<{ runId: string; token: string }>;
			const failNormal = async (token: string) => {
				const { runId, task } = await startNormalRun(token);
				await agent.fail(task, `boom ${token} ${filler}`);
				normal.push({ runId, token });
			};
			await failNormal("test-normal-value-1");
			await failNormal("test-normal-value-2");
			// 预算用光的运行：一条 6 万个字符的失败信息，一条就超过这个运行的预算
			const exhausted = await startLateRun(smallValues());
			await agent.succeed(exhausted.b);
			await subflowCreated(exhausted.runId);
			await agent.fail(exhausted.sa, "a".repeat(60_000));
			// 值集合太大的运行：失败信息再短，也整段盖住
			const oversize = await startLateRun(oversizeValues("dash"));
			await agent.succeed(oversize.b);
			await subflowCreated(oversize.runId);
			await agent.fail(oversize.sa, "boom short message");
			await failNormal("test-normal-value-3");
			await eventually(async () => expect((await api.run(oversize.runId)).status).toBe("failed"));
			await eventually(async () => expect((await api.run(exhausted.runId)).status).toBe("failed"));

			{
				const res = await cp.fetch("/dashboard");
				const dashboard = (await res.json()) as {
					recent_ended: Array<{
						id: string;
						failure: { error: { message: string } | null } | null;
					}>;
				};
				const messageOf = (runId: string) =>
					dashboard.recent_ended.find((r) => r.id === runId)?.failure?.error?.message;
				expect(messageOf(exhausted.runId)).toBe(MASK);
				expect(messageOf(oversize.runId)).toBe(MASK);
				// 别的运行：只有它们自己的保密值被盖住，周围的文字都在
				for (const { runId, token } of normal) {
					expect(messageOf(runId), runId).toBe(`boom ${MASK} ${filler}`);
					expect(token).toBeDefined();
				}
			}
		});
	}, 120_000);

	it("Agent 列表里几个运行占着槽位：用光预算的、值集合太大的运行只盖住它们自己，别的运行的进度说明一个字不少", async () => {
		await withSecretLimits(LIMITS, async () => {
			const filler = "y".repeat(30_000);
			const exhausted = await startLateRun(smallValues());
			agent.progress(exhausted.sa, 1, 2, "a".repeat(60_000));
			await agent.succeed(exhausted.b);
			await subflowCreated(exhausted.runId);
			const oversize = await startLateRun(oversizeValues("agents"));
			agent.progress(oversize.sa, 1, 2, "short message");
			await agent.succeed(oversize.b);
			await subflowCreated(oversize.runId);
			const normal = [] as string[];
			for (const token of ["test-normal-value-1", "test-normal-value-2"]) {
				const { runId, task } = await startNormalRun(token);
				agent.progress(task, 1, 2, `step ${token} ${filler}`);
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
				for (const runId of [...normal, exhausted.runId, oversize.runId]) {
					expect(progressOf(tasks, runId), runId).toBeDefined();
				}
			});
			{
				const tasks = await read();
				expect(progressOf(tasks, exhausted.runId)).toBe(MASK);
				expect(progressOf(tasks, oversize.runId)).toBe(MASK);
				for (const runId of normal)
					expect(progressOf(tasks, runId), runId).toBe(`step ${MASK} ${filler}`);
			}
		});
	}, 120_000);
});
