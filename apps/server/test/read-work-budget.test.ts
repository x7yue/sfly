// 一次读取、一次写入的打码工作量预算（#517）：保密值由运行自己提供，值集合可以被凑成让单次调用接近上限的样子（很多很长、
// 首字符都一样的值）。一页有几百条动作，每条动作又有名称、字段、失败原因十几处文字：单次调用的上限只管一次调用，几百条加起来
// 要几秒到几十秒，控制面期间不响应。所以一次读取（一页、一份摘要）、一次写入（一批动作明细）共用一份预算，用完之后剩下的文字
// 整段盖住。这里用真实的控制面和假 Agent 量：写入一批 200 条动作、读一页、读摘要，每一步的耗时都有上限。
// 值都是明显的假值。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { ACTION_LIMITS, SECRET_MASK as MASK } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
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
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" }, { clock: cp.clock });
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

	/** 开头都是同样的一长串 a、最后几位不同的 1000 个值：和文字比较时要比到最后才对不上。 */
	const pathologicalValues = () =>
		Array.from({ length: 1000 }, (_, i) => `${"a".repeat(280)}${word(16)}${i % 10}`);

	/** 200 条动作，每条的名称、8 个字段（键和值）、失败原因都是到了上限、前面全是 a、最后一个字符是 b 的文字：每一处都要花满单次的上限。 */
	const actionEvents = () => {
		const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const name = `${"a".repeat(nameChars - 1)}b`;
		const value = `${"a".repeat(valueChars - 1)}b`;
		const reason = `${"a".repeat(reasonChars - 2)}b…`;
		const fields = Object.fromEntries(
			Array.from({ length: 8 }, (_, f) => [`${"a".repeat(nameChars - 2)}b${f}`, value]),
		);
		return Array.from({ length: 200 }, (_, i) => [
			agent.actionStart(i + 1, name, t0 + i * 10, { fields }),
			agent.actionEnd(i + 1, "failed", t0 + i * 10 + 5, { reason }),
		]).flat();
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
		await summary.text();
		expect(summary.status).toBe(200);
		expect(performance.now() - summaryStarted, "读摘要").toBeLessThan(2000);
	};

	it("保密值从一开始就知道：写入 200 条动作、读一页、读摘要，每一步都很快", async () => {
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

		const writeStarted = performance.now();
		agent.actions(task, actionEvents());
		await agent.sync();
		// 一批 200 条的写入：共用一份预算，不是每处文字各花满一次（那样要几十秒）
		expect(performance.now() - writeStarted, "写入一批 200 条动作").toBeLessThan(5000);
		await expectFastReads(task.taskId);
	}, 120_000);

	it("保密值后来才知道（子流程创建之后）：动作已经原样写下，读一页、读摘要，每一步都很快", async () => {
		// cfg 不是 secret，经参数映射传给子流程 subB 的 secret 参数 k 之后，它的值才是 secret 值
		const id = await api.orchestrationWith({
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
		const runId = await api.triggerOk(id, { cfg: pathologicalValues() });
		const first = await agent.nextAssign();
		const second = await agent.nextAssign();
		const [sa, b] = first.nodeId === "sa" ? [first, second] : [second, first];
		// 写入时这些值还不是 secret 值：文字原样写下，读的时候才每一处都要和这一千个值比
		agent.actions(sa, actionEvents());
		await agent.sync();
		await agent.succeed(b);
		await eventually(async () =>
			expect((await api.run(runId)).chains.map((c) => c.chain_id)).toContain("subB"),
		);
		await expectFastReads(sa.taskId);
	}, 120_000);
});
