// 运行预设（#328，ADR 0023）：运行列表（运行记录页的 GET /runs 与场景的 GET /orchestrations/:id/runs）里的 preset，
// 显示的是触发时记下的预设；预设之后改名、删除都不变。HTTP API + 假 Agent + 真实 PostgreSQL。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { runListApi, runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import type { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import {
	createPresetOk,
	deletePresetInDb,
	renamePresetInDb,
	triggerWithPreset,
} from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const scenario = () => ({
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "host", type: "string", required: true },
				{ name: "port", type: "number", default: 80 },
			],
		},
		{
			id: "a",
			kind: "package",
			package: "stub",
			node: "echo",
			inputs: { v: "${{ params.host }}" },
		},
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});

describe("运行列表里的运行预设", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a", slots: 4 });
	});
	afterEach(async () => {
		await agent.disconnect();
		await cp.close();
	});

	const allRuns = async () =>
		runListApi.list.response.parse(await api.getJson("/runs")).runs.map((r) => ({
			id: r.id,
			preset: r.preset,
		}));
	const scenarioRuns = async (id: string) =>
		runsApi.listForOrchestration.response
			.parse(await api.getJson(`/orchestrations/${id}/runs`))
			.runs.map((r) => ({ id: r.id, preset: r.preset }));
	/** 列表按开始时间从新到旧，每次触发之间推进时钟，顺序才是确定的。 */
	const triggeredWith = async (id: string, preset: string) => {
		const res = await triggerWithPreset(api, id, preset);
		expect(res.status, await res.clone().text()).toBe(201);
		(cp.clock as ManualClock).advance(1000);
		return ((await res.json()) as { id: string }).id;
	};

	it("用了预设的运行带着 {id, name}，没用预设的运行是 null，两个运行列表一致", async () => {
		const id = await api.orchestrationWith(scenario(), "订单压测");
		const preset = await createPresetOk(api, id, {
			name: "压测 A 集群",
			params: [{ name: "host", value: "a.example" }],
		});
		const withPreset = await triggeredWith(id, preset.id);
		const plain = await api.triggerOk(id, { host: "h" });

		const expected = [
			{ id: plain, preset: null },
			{ id: withPreset, preset: { id: preset.id, name: "压测 A 集群" } },
		];
		expect(await allRuns()).toEqual(expected);
		expect(await scenarioRuns(id)).toEqual(expected);
	});

	it("预设改名或删除以后，旧运行在运行列表里仍是触发时的名称", async () => {
		const id = await api.orchestrationWith(scenario());
		const renamed = await createPresetOk(api, id, {
			name: "压测 A 集群",
			params: [{ name: "host", value: "a.example" }],
		});
		const deleted = await createPresetOk(api, id, {
			name: "压测 B 集群",
			params: [{ name: "host", value: "b.example" }],
		});
		const runA = await triggeredWith(id, renamed.id);
		const runB = await triggeredWith(id, deleted.id);

		await renamePresetInDb(cp, renamed.id, "改过的名字");
		await deletePresetInDb(cp, deleted.id);

		const expected = [
			{ id: runB, preset: { id: deleted.id, name: "压测 B 集群" } },
			{ id: runA, preset: { id: renamed.id, name: "压测 A 集群" } },
		];
		expect(await allRuns()).toEqual(expected);
		expect(await scenarioRuns(id)).toEqual(expected);
		expect(runsApi.get.response.parse(await api.getJson(`/runs/${runA}`)).preset).toEqual({
			id: renamed.id,
			name: "压测 A 集群",
			params: ["host"],
		});
	});
});
