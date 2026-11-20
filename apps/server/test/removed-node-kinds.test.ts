// 已移除的节点种类（飞书通知节点，ADR 0028）留在历史数据里时怎么办：
// 1. 历史运行照常能看：运行视图、版本、运行列表里已移除的节点显示成它当时的种类名，不报错；
// 2. 最新版本里还含有已移除节点的场景：读出时认得，预检阻断触发并说明替换办法；
// 3. 删掉这些节点之后可以正常保存；带着它们保存被拒绝，错误信息写明哪些节点、怎么替换。
// 不改动已保存的场景版本：版本是不可变的记录，恢复和复制也原样带着已移除节点的配置。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import {
	IDS,
	LEGACY_DOCUMENT,
	REMOVED_NODE,
	seedRemovedKindScenario,
} from "./support/removed-kind-scenario.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

interface Doc {
	nodes: Array<Record<string, unknown> & { id: string; kind: string }>;
	edges: Array<{ from: string; to: string; kind: string }>;
	annotations: unknown[];
	sticky_notes: unknown[];
}

const REPLACEMENT = "在节点代码里用 ctx.notify 发飞书消息";

describe("已移除的节点种类留在历史数据里", () => {
	let cp: TestControlPlane;
	let api: ApiClient;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await seedRemovedKindScenario(cp);
	});
	afterEach(async () => {
		await cp.close();
	});

	const head = () =>
		api.getJson<{ number: number; document: Doc }>(`/orchestrations/${IDS.scenario}/head`);
	const preflightProblems = async () =>
		(await api.getJson<{ problems: Problem[] }>(`/orchestrations/${IDS.scenario}/preflight`))
			.problems;
	const save = (document: unknown, baseVersion: number) =>
		api.post(`/orchestrations/${IDS.scenario}/versions`, { base_version: baseVersion, document });

	describe("历史运行照常能看", () => {
		it("运行视图：已移除的节点还在链上，种类名是它当时的，状态、输入和输出照常", async () => {
			const run = await api.run(IDS.run);
			expect(run.status).toBe("success");
			const [chain] = run.chains;
			expect(chain?.nodes.map((n) => [n.node_id, n.kind, n.status])).toEqual([
				["entry", "entry", "success"],
				["wait", "sleep", "success"],
				["notify", "feishu_notify", "success"],
			]);
			const notify = chain?.nodes.find((n) => n.node_id === "notify");
			expect((notify as { display_name?: string } | undefined)?.display_name).toBe("通知群");
			expect(notify?.attempts[0]?.inputs).toEqual({
				bot: "ops",
				format: "text",
				text: "压测结束 A",
			});
		});

		it("运行列表和按运行读节点的接口也不报错", async () => {
			const list = await api.getJson<{ runs: Array<{ id: string; status: string }> }>(
				`/runs?orchestration_id=${IDS.scenario}`,
			);
			expect(list.runs.map((r) => [r.id, r.status])).toEqual([[IDS.run, "success"]]);
			const node = await api.node(IDS.run, "notify");
			expect(node.kind).toBe("feishu_notify");
		});

		it("运行绑定的版本：文档里的已移除节点带着当时的配置原样读出", async () => {
			const version = await api.getJson<{ document: Doc }>(
				`/orchestrations/${IDS.scenario}/versions/1`,
			);
			expect(version.document.nodes.find((n) => n.id === "notify")).toMatchObject(REMOVED_NODE);
		});
	});

	describe("最新版本里还含有已移除的节点", () => {
		it("读出的最新版本认得它：配置原样带着，后来新增的字段补上默认值", async () => {
			const { document } = await head();
			expect(document.nodes.map((n) => [n.id, n.kind])).toEqual([
				["entry", "entry"],
				["wait", "sleep"],
				["notify", "feishu_notify"],
			]);
			expect(document.nodes[2]).toMatchObject({ bot: "ops", text: "压测结束 ${{ params.env }}" });
			expect(document.sticky_notes).toEqual([]);
		});

		it("预检阻断触发，指出节点、种类和替换办法；触发被拒绝，说明相同", async () => {
			const problems = await preflightProblems();
			expect(problems).toEqual([
				{
					code: "node_kind_removed",
					message: `节点 通知群（notify） 的类型（已移除的节点类型 feishu_notify，原来的「飞书通知」）已不再支持，不能运行。替换办法：${REPLACEMENT}`,
					node_id: "notify",
				},
			]);
			const res = await api.trigger(IDS.scenario, { env: "A" });
			expect(res.status).toBe(400);
			const body = (await res.json()) as {
				error: { code: string; details: Problem[] };
			};
			expect(body.error.code).toBe("invalid_orchestration");
			expect(body.error.details).toEqual(problems);
		});

		it("恢复这个版本、复制场景：新版本和副本里已移除的节点还是原样，保存的警告里有它", async () => {
			const restored = await api.postEmpty(`/orchestrations/${IDS.scenario}/versions/1/restore`);
			expect(restored.status).toBe(201);
			const body = (await restored.json()) as {
				number: number;
				document: Doc;
				warnings: Problem[];
			};
			expect(body.number).toBe(2);
			expect(body.document.nodes.find((n) => n.id === "notify")).toMatchObject(REMOVED_NODE);
			expect(body.warnings.map((w) => [w.code, w.node_id])).toEqual([
				["node_kind_removed", "notify"],
			]);

			const copied = await api.post(`/orchestrations/${IDS.scenario}/copy`, { name: "副本" });
			expect(copied.status).toBe(201);
			const { id } = (await copied.json()) as { id: string };
			const copy = await api.getJson<{ document: Doc }>(`/orchestrations/${id}/head`);
			expect(copy.document.nodes.find((n) => n.id === "notify")).toMatchObject(REMOVED_NODE);
		});
	});

	describe("删掉已移除的节点后可以正常保存", () => {
		it("带着它保存被拒绝：错误信息写明哪些节点、怎么替换，不产生新版本", async () => {
			const res = await save(LEGACY_DOCUMENT, 1);
			expect(res.status).toBe(400);
			const { error } = (await res.json()) as { error: { code: string; message: string } };
			expect(error.code).toBe("invalid_document");
			expect(error.message).toBe(
				`场景里有 1 个已不再支持的节点（notify），先删掉再保存。替换办法：已移除的节点类型 feishu_notify：${REPLACEMENT}`,
			);
			expect((await head()).number).toBe(1);
		});

		it("删掉它（前后的节点接上）之后保存成功，没有已移除节点的警告，再触发不被预检阻断", async () => {
			const { document } = await head();
			const without = {
				...document,
				nodes: document.nodes.filter((n) => n.kind !== "feishu_notify"),
				edges: [{ from: "entry", to: "wait", kind: "chain" }],
			};
			const res = await save(without, 1);
			expect(res.status, await res.clone().text()).toBe(201);
			const saved = (await res.json()) as { number: number; warnings: Problem[] };
			expect(saved.number).toBe(2);
			expect(saved.warnings.filter((w) => w.code === "node_kind_removed")).toEqual([]);

			expect(await preflightProblems()).toEqual([]);
			const runId = await api.triggerOk(IDS.scenario, { env: "A" });
			await api.cancelOk(runId);
			// 第 1 版没有被改动：已移除的节点还在里面。
			const v1 = await api.getJson<{ document: Doc }>(`/orchestrations/${IDS.scenario}/versions/1`);
			expect(v1.document.nodes.map((n) => n.id)).toEqual(["entry", "wait", "notify"]);
		});
	});

	describe("升级前开始、还没跑完的运行走到已移除的节点", () => {
		it("节点按配置错误失败，后面的普通节点跳过，运行结束；同一个 Agent 上别的运行不受影响", async () => {
			await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
			const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
			const pkg = (id: string) => ({
				id,
				kind: "package",
				package: "stub",
				node: "echo",
				inputs: {},
			});
			const chain = (...nodes: Array<Record<string, unknown>>) => ({
				default_agent: "agent-a",
				nodes: [{ id: "entry", kind: "entry", params: [] }, ...nodes],
				edges: nodes.map((n, i) => ({
					from: i === 0 ? "entry" : nodes[i - 1]?.id,
					to: n.id,
					kind: "chain",
				})),
				packages: { stub: "1.0.0" },
			});
			const id = await api.orchestrationWith(chain(pkg("a"), pkg("b")));
			const runId = await api.triggerOk(id);
			const a = await agent.nextAssign();

			// 模拟「升级时它还在运行、版本是移除之前保存的」：直接在库里把第 1 版改成 a 和 b 之间有一个已移除的节点。
			const legacy = chain(pkg("a"), REMOVED_NODE, pkg("b"));
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				await client.query(
					"update orchestration_versions set document = $2 where orchestration_id = $1 and number = 1",
					[id, JSON.stringify(legacy)],
				);
			} finally {
				await client.end();
			}
			await agent.disconnect();
			await cp.restart();
			const back = await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-a",
				runningTasks: [{ taskId: a.taskId, attempt: a.attempt }],
			});
			try {
				await back.succeed(a, { v: 1 });
				await eventually(async () => expect((await api.run(runId)).status).toBe("failed"));
				const run = await api.run(runId);
				expect(
					Object.fromEntries(run.chains[0]?.nodes.map((n) => [n.node_id, n.status]) ?? []),
				).toEqual({
					entry: "success",
					a: "success",
					notify: "failed",
					b: "skipped",
				});
				const notify = await api.node(runId, "notify");
				expect(notify.error?.kind).toBe("config_error");
				expect(notify.error?.message).toContain("已移除，不能执行");
				expect(notify.error?.message).toContain(REPLACEMENT);

				// 同一个 Agent 上别的运行照常派发、完成：派发没有被这份算不出的计划拖住。
				const other = await api.orchestrationWith(chain(pkg("x")), "别的场景");
				const otherRun = await api.triggerOk(other);
				const x = await back.nextAssign();
				expect(x.nodeId).toBe("x");
				await back.succeed(x);
				await eventually(async () => expect((await api.run(otherRun)).status).toBe("success"));
			} finally {
				await back.disconnect();
			}
		});
	});
});
