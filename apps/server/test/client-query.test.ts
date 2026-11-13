// API 客户端（@sfly/client）的查询：经公开接口对着真实的测试控制面，fetch 不替换。
import { type Client, createClient, type RunView } from "@sfly/client";
import { httpApis, logsApi, runsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { type FinishedRun, seedFinishedRun, startClientControlPlane } from "./support/client.js";
import { FakeAgent } from "./support/fake-agent.js";
import type { TestControlPlane } from "./support/test-control-plane.js";

describe("API 客户端的方法来自契约里标了 client 的接口", () => {
	const client = createClient({ baseUrl: "http://127.0.0.1:1" });
	const methodsOf = (value: object) =>
		Object.entries(value).flatMap(([domain, table]) =>
			typeof table === "object" ? Object.keys(table).map((name) => `${domain}.${name}`) : [],
		);

	it("客户端的方法正是契约里标了 client 的只读接口和下载", () => {
		const flagged = Object.entries(httpApis).flatMap(([domain, table]) =>
			Object.entries(table)
				.filter(([, def]) => def.client)
				.filter(([, def]) => def.method === "GET")
				.filter(([, def]) => !("kind" in def) || def.kind !== "stream")
				.map(([name]) => `${domain}.${name}`),
		);
		expect(methodsOf(client).sort()).toEqual(flagged.sort());
	});

	it("给 Agent 和安装脚本的接口、上传、SDK 与 sfly 索引、用户文档、在线编辑者都不进入客户端", () => {
		const methods = methodsOf(client);
		for (const domain of ["agentBinaries", "sdk", "docs", "presence"]) {
			expect(methods.filter((m) => m.startsWith(`${domain}.`))).toEqual([]);
		}
		for (const internal of ["artifacts.upload", "packages.publish", "packages.archive"]) {
			expect(methods).not.toContain(internal);
		}
	});
});

describe("API 客户端查询测试控制面", () => {
	let cp: TestControlPlane;
	let client: Client;
	let times: string[];
	let seeded: FinishedRun;
	let idle: string;

	beforeAll(async () => {
		({ cp, client, times } = await startClientControlPlane());
		seeded = await seedFinishedRun(cp);
		const api = new ApiClient(cp);
		await (await FakeAgent.connect(cp.grpcUrl, { name: "agent-b" })).disconnect();
		idle = await api.orchestrationWith(
			{
				default_agent: "agent-b",
				nodes: [{ id: "entry", kind: "entry", params: [] }],
				edges: [],
				packages: {},
			},
			"回归",
		);
	});
	afterAll(async () => {
		await cp.close();
	});

	it("列出场景，并按名称、最近运行的状态、引用的 Agent 筛选", async () => {
		const all = await client.orchestrations.list();
		expect(all.orchestrations.map((o) => o.name).sort()).toEqual(["回归", "巡检"]);
		expect(all.archived_count).toBe(0);

		const byName = await client.orchestrations.list({ query: { q: "巡" } });
		expect(byName.orchestrations.map((o) => o.id)).toEqual([seeded.scenarioId]);
		const byStatus = await client.orchestrations.list({ query: { status: "success" } });
		expect(byStatus.orchestrations.map((o) => o.id)).toEqual([seeded.scenarioId]);
		const byAgent = await client.orchestrations.list({ query: { agent: "agent-b" } });
		expect(byAgent.orchestrations.map((o) => o.id)).toEqual([idle]);
	});

	it("读场景详情、最新版本、版本历史和入口参数声明", async () => {
		const params = { id: seeded.scenarioId };
		const detail = await client.orchestrations.get({ params });
		expect(detail).toMatchObject({ id: seeded.scenarioId, name: "巡检", head_version: 1 });

		const head = await client.orchestrations.head({ params });
		expect(head.number).toBe(1);
		const { versions } = await client.orchestrations.versions({ params });
		expect(versions.map((v) => v.number)).toEqual([1]);
		const version = await client.orchestrations.version({ params: { ...params, number: "1" } });
		expect(version.document.nodes.map((n) => n.id)).toEqual(["entry", "check"]);

		const preflight = await client.runs.preflight({ params });
		expect(preflight.problems).toEqual([]);
		expect(preflight.params).toEqual([
			expect.objectContaining({ name: "env", type: "string", default: "staging" }),
		]);
	});

	it("列出运行并按场景、状态筛选，读运行详情", async () => {
		const { runs } = await client.runs.list();
		expect(runs.map((r) => r.id)).toEqual([seeded.runId]);
		const byScenario = await client.runs.list({ query: { orchestration_id: idle } });
		expect(byScenario.runs).toEqual([]);
		const failed = await client.runs.list({ query: { status: "failed" } });
		expect(failed.runs).toEqual([]);
		const forScenario = await client.runs.listForOrchestration({
			params: { id: seeded.scenarioId },
		});
		expect(forScenario.runs.map((r) => [r.id, r.status])).toEqual([[seeded.runId, "success"]]);

		const run = await client.runs.get({ params: { id: seeded.runId } });
		expectTypeOf(run).toEqualTypeOf<RunView>();
		expect(run).toMatchObject({ status: "success", params: { env: "prod" } });
		expect(run.chains[0]?.nodes.map((n) => [n.node_id, n.status])).toEqual([
			["entry", "success"],
			["check", "success"],
		]);
	});

	it("按任务和按运行分页读日志", async () => {
		const page = await client.logs.page({ params: { id: seeded.taskId } });
		expect(page.lines.map((l) => l.text)).toEqual(seeded.logLines);
		const older = await client.logs.page({
			params: { id: seeded.taskId },
			query: { limit: 1, before: page.lines[1]?.offset },
		});
		expect(older.lines.map((l) => l.text)).toEqual([seeded.logLines[0]]);

		const runPage = await client.logs.runPage({ params: { id: seeded.runId } });
		expect(runPage.lines.map((l) => l.text)).toEqual(seeded.logLines);
	});

	it("读指标摘要、目录和序列", async () => {
		const summary = await client.metrics.summary({ params: { id: seeded.runId } });
		expect(summary.tasks.flatMap((t) => t.metrics.map((m) => [m.name, m.points, m.last]))).toEqual([
			["tps", 2, 20],
		]);
		const catalog = await client.metrics.catalog({ params: { id: seeded.runId } });
		expect(catalog.nodes.map((n) => n.node_id)).toEqual(["check"]);
		const series = await client.metrics.series({
			params: { id: seeded.runId },
			query: { chain_instance_id: seeded.chainInstanceId, node_id: "check" },
		});
		expect(series.series.map((s) => s.name)).toEqual(["tps"]);
		const platform = await client.metrics.platform({ params: { id: seeded.runId } });
		expect(platform.run_id).toBe(seeded.runId);
	});

	it("列出产物，产物和日志的下载地址是绝对地址，直接请求能拿到内容", async () => {
		const { artifacts } = await client.artifacts.list({ params: { id: seeded.taskId } });
		expect(artifacts.map((a) => a.name)).toEqual([seeded.artifact.name]);

		const before = times.length;
		const artifactUrl = client.artifacts.download({
			params: { id: seeded.taskId, "*": seeded.artifact.name },
		});
		const taskLogUrl = client.logs.download({ params: { id: seeded.taskId } });
		const runLogUrl = client.logs.runDownload({ params: { id: seeded.runId } });
		expect(times).toHaveLength(before);

		for (const url of [artifactUrl, taskLogUrl, runLogUrl]) {
			expect(new URL(url).origin).toBe(new URL(cp.httpUrl).origin);
		}
		const artifact = await fetch(artifactUrl);
		expect(artifact.status).toBe(200);
		expect(await artifact.text()).toBe(seeded.artifact.body);
		for (const url of [taskLogUrl, runLogUrl]) {
			const res = await fetch(url);
			expect(res.status, url).toBe(200);
			const rows = (await res.text())
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line) as { text: string });
			expect(rows.map((r) => r.text)).toEqual(seeded.logLines);
		}
	});

	it("列出 Agent 和节点包，读节点包的详情、版本和节点类型", async () => {
		const { agents } = await client.agents.list();
		expect(agents.map((a) => a.name)).toEqual(["agent-a", "agent-b"]);

		const { packages } = await client.packages.list();
		expect(packages.map((p) => p.name)).toEqual(["probe"]);
		const detail = await client.packages.get({ params: { name: "probe" } });
		expect(detail.versions.map((v) => v.version)).toEqual(["1.0.0"]);
		const version = await client.packages.version({ params: { name: "probe", version: "1.0.0" } });
		expect(version.metadata.nodes.map((n) => n.name)).toEqual(["check"]);
		const nodeType = await client.packages.nodeType({
			params: { name: "probe", version: "1.0.0", node: "check" },
		});
		expect(nodeType.metrics?.map((m) => m.name)).toEqual(["tps"]);
	});

	it("读控制台统计、健康检查和飞书机器人", async () => {
		const dashboard = await client.dashboard.get();
		expect(dashboard.runs).toMatchObject({ success: 1, failed: 0 });
		expect(dashboard.agents.list.map((a) => a.name)).toEqual(["agent-a", "agent-b"]);

		expect(await client.system.health()).toMatchObject({ status: "ok", database: "ok" });
		expect((await client.feishuBots.list()).bots).toEqual([]);
	});

	it("必填的输入不能省略：类型检查报错，运行时抛出 TypeError 而不发请求", async () => {
		const before = times.length;
		// @ts-expect-error runs.get 必须给 params.id
		await expect(client.runs.get()).rejects.toThrow(TypeError);
		expect(times).toHaveLength(before);
	});

	it("底层入口按路由描述调用：契约定义、没有方法的接口、下载", async () => {
		const run = await client.request(runsApi.get, { params: { id: seeded.runId } });
		expect(run).toMatchObject({ id: seeded.runId, status: "success" });
		expect(await client.request({ method: "GET", path: "/sdk/project-settings" })).toMatchObject({
			version: cp.version,
		});
		const download = await client.request(logsApi.download, { params: { id: seeded.taskId } });
		expect(await download.text()).toContain(seeded.logLines[0]);
		expect(client.url(runsApi.get, { params: { id: seeded.runId } })).toBe(
			`${cp.httpUrl}/runs/${seeded.runId}`,
		);
	});
});
