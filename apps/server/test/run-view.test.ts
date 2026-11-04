// 切入点 A：触发前的预检、运行列表、运行状态的 SSE 推送（#9）。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
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
});
