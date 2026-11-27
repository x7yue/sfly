// 一次读取的打码预算（#517）：一页有几百条动作、上千行日志，每条动作又有名称、字段、失败原因十几处文字；预算只记完整的出现的次数
// （合并重叠之后的段数，限住输出被撑大），一次读取（一页、一份摘要）共用一份，用完之后这次读取里还有完整出现的文字整段盖住，
// 没有完整出现的文字原样（再多再长也不盖）；一次调用里读的几个运行各一份（一个运行用完了，也不牵连同一次读取里别的运行）；
// 一个运行的值集合大到建不了自动机，它的文字整段盖住，也只影响它自己。
// 真实的上限（2^20 段、100 多万个字符）要很大的文字才碰得到：这里把上限调小（`secretLimits`，只给测试用，控制面和测试在同一个进程里），
// 用真实的控制面和假 Agent 验证每个读取出口都取了预算：读一页动作、读摘要、读控制台、读 Agent 列表。值都是明显的假值。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { ACTION_LIMITS, SECRET_MASK as MASK } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_AUTOMATON_CHARS } from "../src/logs/aho-corasick.js";
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

	/** 读取预算调成 4 段完整的出现；一个运行的值集合所有写法合计超过 3000 个字符就建不了自动机。 */
	const LIMITS = { readMasks: 4, automatonChars: 3000 };
	/** 动作的一页、摘要：预算调成 20 段，每条动作的名称里有一处完整的出现。 */
	const ACTION_LIMITS_FOR_TEST = { readMasks: 20, automatonChars: 3000 };
	const SECRET = "fake-secret-value-one";

	const smallValues = () => [
		"fake-secret-value-one",
		"fake-secret-value-two",
		"fake-secret-value-3",
	];
	/** 值集合大到（上限调成 3000）建不了自动机的运行：50 个各 100 多个字符的值，`tag` 让每个测试的值不一样（值集合按值缓存）。 */
	const oversizeValues = (tag: string) =>
		Array.from({ length: 50 }, (_, i) => `fake-oversize-${tag}-${i}-${"p".repeat(100)}`);

	/** secret 值后来才知道的场景：cfg 不是 secret，经参数映射传给子流程 subB 的 secret 参数 k 之后，它的值才是 secret 值。 */
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

	/** 动作的名称（到上限 64 个字符）：开头有一处 `secret`（写入时已经知道这个值的话，存下来的是掩码）。 */
	const nameWith = (secret: string) => {
		const head = `n ${secret} `;
		return `${head}${"a".repeat(ACTION_LIMITS.nameChars - head.length - 1)}b`;
	};

	/** `count` 条动作，每条的名称里有一处 `secret`，8 个字段（键和值）、失败原因都到了上限。 */
	const actionEvents = (count: number, secret: string) => {
		const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const name = nameWith(secret);
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

	/** 动作摘要：1 个正在做的、最近结束的 20 个、最近失败的 5 个，名称里各有一处 `secret`，文字同 {@link actionEvents}。 */
	const sendSummary = (task: AssignedTask, secret: string) => {
		const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const name = nameWith(secret);
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

	type ActionsPage = { actions: Array<{ name: string }> };
	type Summary = {
		running: Array<{ name: string }>;
		recent: Array<{ name: string }>;
		recent_failed: Array<{ name: string }>;
	};
	const readPage = async (taskId: string) => {
		const res = await cp.fetch(`/tasks/${taskId}/actions?limit=200`);
		expect(res.status).toBe(200);
		return ((await res.json()) as ActionsPage).actions;
	};
	const readSummary = async (taskId: string) => {
		const res = await cp.fetch(`/tasks/${taskId}/actions/summary`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Summary;
		expect(body.recent.length).toBe(20);
		return [...body.running, ...body.recent, ...body.recent_failed].map((a) => a.name);
	};

	/** 读一页动作和动作摘要：每条动作一处完整的出现，前面的只盖 secret 值，用完预算之后剩下的整段盖住。 */
	const expectBudgetedReads = async (taskId: string) => {
		const page = await readPage(taskId);
		const masked = page.filter((a) => a.name === MASK).length;
		expect(page.length - masked, "预算用完之前的只盖 secret 值").toBe(20);
		expect(masked, "用完之后的整段盖住").toBe(page.length - 20);
		for (const a of page.filter((x) => x.name !== MASK)) {
			expect(a.name).toBe(`n ${MASK} ${"a".repeat(ACTION_LIMITS.nameChars - 24 - 1)}b`);
		}
		// 读摘要也用预算（另一次读取，另一份）：26 处完整的出现，超过 20，后面的整段盖住
		const names = await readSummary(taskId);
		expect(names.filter((n) => n === MASK).length, "摘要里用完之后的整段盖住").toBeGreaterThan(0);
		expect(names.filter((n) => n !== MASK).length, "摘要里前面的只盖 secret 值").toBeGreaterThan(0);
	};

	it("secret 值从一开始就知道：写入时已经盖住，存下来的没有完整的出现，读一页动作、读摘要，预算调得再小也一个字不多盖", async () => {
		const id = await api.orchestrationWith({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "cfg", type: "json", secret: true }] },
				{ id: "sa", kind: "package", package: "bench", node: "load" },
			],
			edges: [{ from: "entry", to: "sa", kind: "chain" }],
			packages: { bench: "1.0.0" },
		});
		await api.triggerOk(id, { cfg: [SECRET, "fake-secret-value-two", "fake-secret-value-3"] });
		const task = await agent.nextAssign();
		// 写入时的打码不带预算
		agent.actions(task, actionEvents(60, SECRET));
		sendSummary(task, SECRET);
		await agent.sync({ timeoutMs: 60_000 });
		await withSecretLimits({ readMasks: 3, automatonChars: 3000 }, async () => {
			const page = await readPage(task.taskId);
			expect(page.length).toBeGreaterThanOrEqual(60);
			const expected = `n ${MASK} ${"a".repeat(ACTION_LIMITS.nameChars - 24 - 1)}b`;
			expect(page.filter((a) => a.name !== expected)).toEqual([]);
			expect((await readSummary(task.taskId)).filter((n) => n !== expected)).toEqual([]);
		});
	}, 120_000);

	it("secret 值后来才知道（子流程创建之后）：动作已经原样写下，读一页、读摘要，用完预算之后剩下有完整出现的整段盖住", async () => {
		const id = await api.orchestrationWith(lateDoc());
		const runId = await api.triggerOk(id, {
			cfg: [SECRET, "fake-secret-value-two", "fake-secret-value-3"],
		});
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
		// 写入时这些值还不是 secret 值：文字原样写下，读的时候才每一处都要打一遍
		agent.actions(sa, actionEvents(60, SECRET));
		sendSummary(sa, SECRET);
		await agent.sync();
		await agent.succeed(b);
		await eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);
		await withSecretLimits(ACTION_LIMITS_FOR_TEST, () => expectBudgetedReads(sa.taskId));
	}, 120_000);

	/** 触发之后，sa 在跑，b 结束，子流程 subB 创建，`values` 才成为 secret 值。 */
	const startLateRun = async (values: unknown[]) => {
		const id = await api.orchestrationWith(lateDoc());
		// 触发时值集合已经太大会被拒绝（#632）：用真实的上限触发，之后（调小的上限下）值集合才在运行中变大
		const runId = await withSecretLimits({ automatonChars: MAX_AUTOMATON_CHARS }, () =>
			api.triggerOk(id, { cfg: values }),
		);
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

	/** 一个值出现 `n` 次的失败信息：每处是一段完整的出现。 */
	const mention = (value: string, n: number) => `boom ${Array(n).fill(value).join(" ")}`;

	it("同一次读取里几个运行（控制台的最近失败）：每个运行各一份预算；一个运行用光了、另一个的值集合太大，都只盖住它们自己，别的运行一个字不少", async () => {
		// 整个测试都在调小的上限下：值集合是在第一次用到时建自动机的，建的时候就要按这个上限判断大小
		await withSecretLimits(LIMITS, async () => {
			// 每个正常的运行的失败信息里有 3 处完整的出现：三个加起来超过一份预算（4），各用各的就都不到
			const normal = [] as Array<{ runId: string; token: string }>;
			const failNormal = async (token: string) => {
				const { runId, task } = await startNormalRun(token);
				await agent.fail(task, mention(token, 3));
				normal.push({ runId, token });
			};
			await failNormal("test-normal-value-1");
			await failNormal("test-normal-value-2");
			// 预算用光的运行：一条失败信息里有 6 处完整的出现，超过这个运行的预算
			const exhausted = await startLateRun(smallValues());
			await agent.succeed(exhausted.b);
			await subflowCreated(exhausted.runId);
			await agent.fail(exhausted.sa, mention(smallValues()[0] as string, 6));
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
				// 别的运行：只有它们自己的 secret 值被盖住，周围的文字都在
				for (const { runId } of normal) {
					expect(messageOf(runId), runId).toBe(`boom ${MASK} ${MASK} ${MASK}`);
				}
			}
		});
	}, 120_000);

	it("Agent 列表里几个运行占着槽位：用光预算的、值集合太大的运行只盖住它们自己，别的运行的进度说明一个字不少", async () => {
		await withSecretLimits(LIMITS, async () => {
			const read = async () => {
				const res = await cp.fetch("/projects/default/agents");
				const body = (await res.json()) as {
					agents: Array<{
						running_tasks: Array<{ run_id: string; progress: { message: string } | null }>;
					}>;
				};
				return body.agents.flatMap((a) => a.running_tasks);
			};
			const progressOf = (tasks: Awaited<ReturnType<typeof read>>, runId: string) =>
				tasks.find((t) => t.run_id === runId)?.progress?.message;
			/** 一个后来才知道 secret 值的运行：进度说明在 secret 值已知之前写下，存下来的是原文，读的时候才打码。 */
			const lateRun = async (values: unknown[], message: string) => {
				const run = await startLateRun(values);
				agent.progress(run.sa, 1, 2, message);
				await eventually(async () => expect(progressOf(await read(), run.runId)).toBe(message));
				await agent.succeed(run.b);
				await subflowCreated(run.runId);
				return run;
			};
			const exhausted = await lateRun(smallValues(), mention(smallValues()[0] as string, 6));
			const oversize = await lateRun(oversizeValues("agents"), "short message");
			// 三个运行各有 3 处完整的出现，合计 9，超过一份预算（4）：各用各的就都不到
			const normal = [] as string[];
			for (const token of ["test-normal-value-1", "test-normal-value-2", "test-normal-value-3"]) {
				const run = await lateRun([token], mention(token, 3));
				normal.push(run.runId);
			}
			const tasks = await read();
			expect(progressOf(tasks, exhausted.runId)).toBe(MASK);
			expect(progressOf(tasks, oversize.runId)).toBe(MASK);
			for (const runId of normal) {
				expect(progressOf(tasks, runId), runId).toBe(`boom ${MASK} ${MASK} ${MASK}`);
			}
		});
	}, 120_000);
});
