// 已移除的节点种类（飞书通知节点、定时节点、Sleep 节点，ADR 0028）留在历史数据里时怎么办：
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
	REMOVED_NODES,
	seedRemovedKindScenario,
	seedWaitingRaceRun,
	seedWaitingSleepRun,
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
}

const REPLACEMENT = "在节点代码里用 ctx.notify 发飞书消息";
const SLEEP_REPLACEMENT = "在节点代码里等待，或把场景拆成两次运行";
const TIMER_REPLACEMENT = "在节点代码里等到那个时刻，或把场景拆成两次运行";

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
				["at", "timer", "success"],
				["notify", "feishu_notify", "success"],
			]);
			expect(chain?.nodes.find((n) => n.node_id === "at")?.outputs).toEqual({
				triggered_at: "2026-01-01T00:00:00Z",
				late: false,
			});
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
				`/projects/default/runs?orchestration_id=${IDS.scenario}`,
			);
			expect(list.runs.map((r) => [r.id, r.status])).toEqual([[IDS.run, "success"]]);
			for (const [id, kind] of [
				["wait", "sleep"],
				["at", "timer"],
				["notify", "feishu_notify"],
			]) {
				expect((await api.node(IDS.run, id as string)).kind).toBe(kind);
			}
		});

		it("运行绑定的版本：文档里的已移除节点带着当时的配置原样读出", async () => {
			const version = await api.getJson<{ document: Doc }>(
				`/orchestrations/${IDS.scenario}/versions/1`,
			);
			for (const node of REMOVED_NODES) {
				expect(version.document.nodes.find((n) => n.id === node.id)).toMatchObject(node);
			}
		});

		it("运行监控的平台指标：已移除节点的耗时照常算，响应里没有 wait_ms", async () => {
			const metrics = await api.getJson<{ nodes: Array<Record<string, unknown>> }>(
				`/runs/${IDS.run}/metrics/platform`,
			);
			expect(metrics.nodes.map((n) => [n.node_id, n.kind])).toEqual([
				["entry", "entry"],
				["wait", "sleep"],
				["at", "timer"],
				["notify", "feishu_notify"],
			]);
			for (const node of metrics.nodes) expect(node).not.toHaveProperty("wait_ms");
		});
	});

	describe("最新版本里还含有已移除的节点", () => {
		it("读出的最新版本认得它：配置原样带着，移除之前保存时带上的便签（sticky_notes）不带出", async () => {
			const { document } = await head();
			expect(document.nodes.map((n) => [n.id, n.kind])).toEqual([
				["entry", "entry"],
				["wait", "sleep"],
				["at", "timer"],
				["notify", "feishu_notify"],
			]);
			expect(document.nodes[1]).toMatchObject({ duration: "5s", display_name: "歇一会" });
			expect(document.nodes[2]).toMatchObject({ at: "09:30:00", tz: "Asia/Shanghai" });
			expect(document.nodes[3]).toMatchObject({ bot: "ops", text: "压测结束 ${{ params.env }}" });
			expect(document).not.toHaveProperty("sticky_notes");
		});

		it("预检阻断触发，指出节点、种类和替换办法；触发被拒绝，说明相同", async () => {
			const problems = await preflightProblems();
			expect(problems).toEqual([
				{
					code: "node_kind_removed",
					message: `节点 歇一会（wait） 的类型（已移除的节点类型 sleep，原来的「Sleep」）已不再支持，不能运行。替换办法：${SLEEP_REPLACEMENT}。别的节点引用了它的输出（triggered_at）的，也要一起改。`,
					node_id: "wait",
				},
				{
					code: "node_kind_removed",
					message: `节点 at 的类型（已移除的节点类型 timer，原来的「定时」）已不再支持，不能运行。替换办法：${TIMER_REPLACEMENT}。别的节点引用了它的输出（triggered_at、late）的，也要一起改。`,
					node_id: "at",
				},
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
			for (const node of REMOVED_NODES) {
				expect(body.document.nodes.find((n) => n.id === node.id)).toMatchObject(node);
			}
			expect(body.warnings.map((w) => [w.code, w.node_id])).toEqual([
				["node_kind_removed", "wait"],
				["node_kind_removed", "at"],
				["node_kind_removed", "notify"],
			]);

			const copied = await api.post(`/orchestrations/${IDS.scenario}/copy`, { name: "副本" });
			expect(copied.status).toBe(201);
			const { id } = (await copied.json()) as { id: string };
			const copy = await api.getJson<{ document: Doc }>(`/orchestrations/${id}/head`);
			for (const node of REMOVED_NODES) {
				expect(copy.document.nodes.find((n) => n.id === node.id)).toMatchObject(node);
			}
		});
	});

	describe("删掉已移除的节点后可以正常保存", () => {
		it("带着它保存被拒绝：错误信息写明哪些节点、怎么替换，不产生新版本", async () => {
			const res = await save((await head()).document, 1);
			expect(res.status).toBe(400);
			const { error } = (await res.json()) as { error: { code: string; message: string } };
			expect(error.code).toBe("invalid_document");
			expect(error.message).toBe(
				`场景里有 3 个已不再支持的节点（wait、at、notify），先删掉再保存。替换办法：已移除的节点类型 sleep：${SLEEP_REPLACEMENT}；已移除的节点类型 timer：${TIMER_REPLACEMENT}；已移除的节点类型 feishu_notify：${REPLACEMENT}。引用了它们输出的节点也要一起改`,
			);
			expect((await head()).number).toBe(1);
		});

		it("旧文件里已移除的节点和有内容的便签（sticky_notes）一起保存被拒绝：错误信息两样都写明，不产生新版本", async () => {
			// 移除之前 pull 下来的文件：文档里除了已移除的节点，还带着有内容的 sticky_notes。
			const res = await save(
				{ ...LEGACY_DOCUMENT, sticky_notes: [{ id: "sticky_1", text: "跑之前确认" }] },
				1,
			);
			expect(res.status).toBe(400);
			const { error } = (await res.json()) as { error: { code: string; message: string } };
			expect(error.code).toBe("invalid_document");
			expect(error.message).toContain(
				"场景里有 3 个已不再支持的节点（wait、at、notify），先删掉再保存",
			);
			expect(error.message).toContain("场景文档里的 sticky_notes（便签）有 1 条内容");
			expect(error.message).toContain("替换办法：便签：要留的内容写进节点的备注或注释框的备注");
			expect((await head()).number).toBe(1);
		});

		it("旧文件里已移除的节点带着空的 sticky_notes（每个旧版本都有）：错误信息只说已移除的节点，不提便签", async () => {
			expect(LEGACY_DOCUMENT).toHaveProperty("sticky_notes", []);
			const res = await save(LEGACY_DOCUMENT, 1);
			expect(res.status).toBe(400);
			const { error } = (await res.json()) as { error: { message: string } };
			expect(error.message).toContain("场景里有 3 个已不再支持的节点");
			expect(error.message).not.toContain("便签");
			expect(error.message).not.toContain("sticky_notes");
		});

		it("删掉它们之后保存成功，没有已移除节点的警告，再触发不被预检阻断", async () => {
			const { document } = await head();
			const without = {
				...document,
				nodes: document.nodes.filter((n) => n.id === "entry"),
				edges: [],
			};
			const res = await save(without, 1);
			expect(res.status, await res.clone().text()).toBe(201);
			const saved = (await res.json()) as { number: number; warnings: Problem[] };
			expect(saved.number).toBe(2);
			expect(saved.warnings.filter((w) => w.code === "node_kind_removed")).toEqual([]);

			expect(await preflightProblems()).toEqual([]);
			const runId = await api.triggerOk(IDS.scenario, { env: "A" });
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"));
			// 第 1 版没有被改动：已移除的节点还在里面。
			const v1 = await api.getJson<{ document: Doc }>(`/orchestrations/${IDS.scenario}/versions/1`);
			expect(v1.document.nodes.map((n) => n.id)).toEqual(["entry", "wait", "at", "notify"]);
		});
	});

	describe("只删掉一部分已移除的节点", () => {
		it("还留着的仍然拒绝保存，错误信息只写还留着的那些", async () => {
			const { document } = await head();
			const partly = {
				...document,
				nodes: document.nodes.filter((n) => n.id === "entry" || n.id === "at"),
				edges: [{ from: "entry", to: "at", kind: "chain" }],
			};
			const res = await save(partly, 1);
			expect(res.status).toBe(400);
			const { error } = (await res.json()) as { error: { message: string } };
			expect(error.message).toBe(
				`场景里有 1 个已不再支持的节点（at），先删掉再保存。替换办法：已移除的节点类型 timer：${TIMER_REPLACEMENT}。引用了它们输出的节点也要一起改`,
			);
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

	describe("升级时还停在等待节点上的运行", () => {
		it("控制面启动时：定时、Sleep 节点的 waiting 任务按配置错误失败，后面的节点跳过，运行结束", async () => {
			await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
			const waiting = await seedWaitingSleepRun(cp);
			expect((await api.run(waiting.run)).status).toBe("running");

			// 重启就是升级：启动时按节点种类找出没人会再唤醒的 waiting 任务。
			await cp.restart();

			await eventually(async () => expect((await api.run(waiting.run)).status).toBe("failed"));
			const run = await api.run(waiting.run);
			expect(
				Object.fromEntries(run.chains[0]?.nodes.map((n) => [n.node_id, n.status]) ?? []),
			).toEqual({ entry: "success", wait: "failed", after: "skipped" });
			const wait = await api.node(waiting.run, "wait");
			expect(wait.error?.kind).toBe("config_error");
			expect(wait.error?.message).toBe(
				`节点 歇一会（wait） 的类型（已移除的节点类型 sleep）已移除，不能执行（控制面升级时它正在等待，没有人会再唤醒它）：${SLEEP_REPLACEMENT}`,
			);
			expect(run.chains[0]?.status).toBe("failed");
		});

		it("某个历史运行排不出计划（节点在版本里查不到）：跳过它，不挡住控制面启动，别的运行照常处理", async () => {
			await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
			const waiting = await seedWaitingSleepRun(cp);
			const broken = {
				run: "00000000-0000-4000-8000-0000000000a1",
				chain: "00000000-0000-4000-8000-0000000000a2",
				task: "00000000-0000-4000-8000-0000000000a3",
			};
			const client = new pg.Client({ connectionString: cp.database.url });
			await client.connect();
			try {
				// 比 Sleep 任务更早写入：先处理它，它出错不能让后面的运行也被丢下。
				await client.query(
					`insert into runs (id, orchestration_id, orchestration_version_id, project_id, triggered_by, params, status, started_at)
					values ($1, $2, $3, 'default', '旧人', '{}', 'running', now())`,
					[broken.run, waiting.scenario, waiting.version],
				);
				await client.query(
					`insert into chain_instances (id, run_id, chain_id, depth, params, status, started_at)
					values ($1, $2, 'entry', 0, '{}', 'running', now())`,
					[broken.chain, broken.run],
				);
				await client.query(
					`insert into tasks (id, run_id, chain_instance_id, node_id, attempt, status, inputs, queued_at, started_at, seq)
					values ($1, $2, $3, 'ghost', 1, 'waiting', '{}', now(), now(), 0)`,
					[broken.task, broken.run, broken.chain],
				);
			} finally {
				await client.end();
			}

			await cp.restart();

			await eventually(async () => expect((await api.run(waiting.run)).status).toBe("failed"));
			expect((await api.run(broken.run)).status).toBe("running");
		});

		it("同一个运行里有两个停在已移除节点上：先失败的让总是执行的停止子流程节点把子流程停掉，后一个记为已停止，不被改写成失败", async () => {
			const race = await seedWaitingRaceRun(cp);
			await cp.restart();

			await eventually(async () => expect((await api.run(race.run)).status).toBe("failed"));
			const run = await api.run(race.run);
			const chain = (id: string) => run.chains.find((c) => c.chain_id === id);
			const statuses = (id: string) =>
				Object.fromEntries(chain(id)?.nodes.map((n) => [n.node_id, n.status]) ?? []);
			expect(statuses("entry")).toEqual({
				entry: "success",
				spawn: "success",
				wait: "failed",
				stop: "success",
			});
			// 子流程里的定时节点是被停止的（docs/SEMANTICS.md §4.1），整条子流程成功结束。
			expect(statuses("sub")).toEqual({ sub: "success", nap: "stopped" });
			expect(chain("sub")?.status).toBe("success");
			const stop = chain("entry")?.nodes.find((n) => n.node_id === "stop");
			expect(stop?.outputs).toEqual({ status: "success" });
			expect((await api.node(race.run, "wait")).error?.kind).toBe("config_error");
		});

		it("历史运行里已经结束的等待节点不受影响：重启之后它们还是原来的状态", async () => {
			await cp.restart();
			const run = await api.run(IDS.run);
			expect(run.status).toBe("success");
			expect(run.chains[0]?.nodes.map((n) => [n.node_id, n.status])).toEqual([
				["entry", "success"],
				["wait", "success"],
				["at", "success"],
				["notify", "success"],
			]);
		});
	});
});
