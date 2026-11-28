// 打不打码只看完整的出现（#517，docs/SEMANTICS.md §2.1）：动作的字段的值（上限 256）、失败原因（上限 4096）在读取时按此刻的
// secret 值再打一遍码；文字的结尾是某个值的前缀（半截）时，输出里有没有掩码不能成为猜这个值的依据，所以半截原样留着，
// 完整的出现照常盖住。这里用真实的控制面和假 Agent：secret 值是子流程创建之后才知道的，动作已经原样写下，读一页明细、读摘要。
// 值都是明显的假值。
import { ACTION_LIMITS, SECRET_MASK as MASK } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { publishBench } from "./support/focus-items.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 后来才成为 secret 的值：入口参数 user 不是 secret，经参数映射传给子流程 subB 的 secret 参数 k 之后才是。 */
const LATE = "alice-late-value";

const lateDoc = () => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "user", type: "string" }] },
		{ id: "x1", kind: "async", params: {} },
		{ id: "subA", kind: "subflow_entry", name: "A", params: [] },
		{ id: "sa", kind: "package", package: "bench", node: "load" },
		{ id: "b", kind: "package", package: "bench", node: "probe" },
		{ id: "x2", kind: "async", params: { k: "${{ params.user }}" } },
		{
			id: "subB",
			kind: "subflow_entry",
			name: "B",
			params: [{ name: "k", type: "string", secret: true }],
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

interface ActionView {
	id: number;
	name: string;
	fields: Record<string, string>;
	reason?: string | null;
}

describe("动作的字段的值、失败原因：结尾是 secret 值的前缀时读取不改动，完整的出现盖住", () => {
	const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishBench(cp);
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 }, { clock: cp.clock });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	/** 到了上限的文字：前面是 `filler`，结尾是 `tail`。 */
	const full = (filler: string, tail: string, limit: number) =>
		`${filler.repeat(limit - tail.length)}${tail}`;
	/** 各种半截（长度不同）的结尾，和一个完整的值。 */
	const partials = [LATE.slice(0, 1), LATE.slice(0, 6), LATE.slice(0, LATE.length - 1)];
	const t0 = Date.parse("2026-01-01T00:00:00.000Z");

	/** 一个动作：名称、字段的键和值、失败原因都到了上限，结尾是 `tail`。 */
	const shape = (id: number, tail: string) => ({
		id,
		name: full("n", tail, nameChars),
		fields: { [full("k", tail, nameChars)]: full("v", tail, valueChars) },
		reason: full("r", tail, reasonChars),
	});
	const tails = [...partials, LATE];

	/** 触发、sa 写下这些动作（此时 LATE 还不是 secret 值）、b 结束让子流程 subB 创建（LATE 才成为 secret 值）。 */
	const startLateRun = async () => {
		const id = await api.orchestrationWith(lateDoc());
		const runId = await api.triggerOk(id, { user: LATE });
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
		const events = tails.flatMap((tail, i) => {
			const a = shape(i + 1, tail);
			return [
				agent.actionStart(a.id, a.name, t0 + i * 10, { fields: a.fields }),
				agent.actionEnd(a.id, "failed", t0 + i * 10 + 5, { reason: a.reason }),
			];
		});
		agent.actions(sa, events);
		await agent.sync();
		await agent.succeed(b);
		await eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);
		return sa satisfies AssignedTask;
	};

	/** 读出来的动作：只有完整的出现（最后一个）换成掩码，各种半截和原来一样。 */
	const expectMasked = (a: ActionView, tail: string) => {
		const mask = tail === LATE;
		const expected = (filler: string, limit: number) =>
			mask ? `${filler.repeat(limit - tail.length)}${MASK}` : full(filler, tail, limit);
		expect(a.name).toBe(expected("n", nameChars));
		expect(a.fields).toEqual({ [expected("k", nameChars)]: expected("v", valueChars) });
		expect(a.reason).toBe(expected("r", reasonChars));
	};

	it("读一页动作明细：字段的键和值、失败原因里的半截原样，完整的值盖住", async () => {
		const sa = await startLateRun();
		const res = await cp.fetch(`/tasks/${sa.taskId}/actions?limit=200`);
		expect(res.status).toBe(200);
		const page = (await res.json()) as { actions: ActionView[] };
		expect(page.actions).toHaveLength(tails.length);
		for (const a of page.actions) expectMasked(a, tails[a.id - 1] as string);
	});

	it("读动作摘要（最近结束的、最近失败的）：同样", async () => {
		const sa = await startLateRun();
		const end = agent.stamp(t0 + 5_000);
		const ended = tails.map((tail, i) => {
			const a = shape(i + 1, tail);
			return {
				...a,
				parent: null,
				depth: 0,
				...agent.stamp(t0 + i * 10),
				end_ts: end.ts,
				end_mono: end.mono,
				result: "failed" as const,
			};
		});
		const zero = {
			reported: tails.length,
			capped_ts: null,
			capped_mono: null,
			failed: tails.length,
		};
		agent.actionSummary(sa, {
			total: tails.length,
			reported: tails.length,
			names: [{ name: "n", total: tails.length, ...zero }],
			recent: ended,
			recent_failed: ended,
		});
		await agent.sync();
		const res = await cp.fetch(`/tasks/${sa.taskId}/actions/summary`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { recent: ActionView[]; recent_failed: ActionView[] };
		expect(body.recent).toHaveLength(tails.length);
		expect(body.recent_failed).toHaveLength(tails.length);
		for (const list of [body.recent, body.recent_failed])
			for (const a of list) expectMasked(a, tails[a.id - 1] as string);
	});
});
