// 复制场景时关注项一起复制（#344 / #348）：最后修改记为复制的人；联调副本走同一条复制路径。
// HTTP API + 假 Agent + 真实 PostgreSQL，手动时钟。
import { orchestrationsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import {
	benchDocument,
	orchestrationView,
	publishBench,
	putFocusItemsOk,
} from "./support/focus-items.js";
import { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const LOAD_TPS = { node_id: "load", chart: "TPS" };
const LOAD_LATENCY = { node_id: "load", chart: "延迟" };
const PROBE_LEVEL = { node_id: "probe", chart: "level" };

describe("复制场景时复制关注项", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;
	let agent: FakeAgent | undefined;

	const copy = async (id: string, name: string, nickname: string) => {
		const res = await api.post(`/orchestrations/${id}/copy`, { name }, nickname);
		expect(res.status, await res.clone().text()).toBe(201);
		return orchestrationsApi.copy.response.parse(await res.json());
	};

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishBench(cp);
	});
	afterEach(async () => {
		await agent?.disconnect();
		agent = undefined;
		await cp.close();
	});

	it("列表、名字和失效的项原样复制，最后修改记为复制的人和时间，写「复制自」源场景；源场景不变", async () => {
		const source = await api.orchestrationWith(benchDocument(), "撮合浸泡");
		await putFocusItemsOk(api, source, [{ ...LOAD_TPS, title: "撮合 TPS" }, PROBE_LEVEL], "小红");
		await api.saveVersion(source, benchDocument([["load", "load"]]));
		const before = await orchestrationView(api, source);
		clock.advance(3_600_000);

		const copied = await copy(source, "撮合浸泡 副本", "小明");
		expect(copied.name).toBe("撮合浸泡 副本");
		expect(copied.focus_items).toEqual([
			{ ...LOAD_TPS, title: "撮合 TPS", status: "ok", chart_type: "area" },
			// 副本的第 1 版就是源场景的最新版本，里面没有 probe：没有任何版本包含它。
			{ ...PROBE_LEVEL, status: "node_missing", last_version: null },
		]);
		expect(copied.focus_edit).toEqual({
			updated_by: "小明",
			updated_at: "2026-01-01T01:00:00.000Z",
			summary: "复制自「撮合浸泡」",
		});
		// 复制的响应比读场景多一项 `warnings`（第 1 版的警告，#576）；其余和读出来的一样。
		const { warnings, ...copiedView } = copied;
		expect(warnings).toEqual([]);
		expect(await orchestrationView(api, copied.id)).toEqual(copiedView);
		expect(await orchestrationView(api, source)).toEqual(before);
	});

	it("复制出来的列表是独立的：改副本不影响源场景，反过来也一样", async () => {
		const source = await api.orchestrationWith(benchDocument(), "撮合浸泡");
		await putFocusItemsOk(api, source, [LOAD_TPS]);
		const copied = await copy(source, "副本", "小明");

		await putFocusItemsOk(api, copied.id, [LOAD_TPS, PROBE_LEVEL], "小明");
		await putFocusItemsOk(api, source, [LOAD_LATENCY], "小红");
		expect((await orchestrationView(api, source)).focus_items.map((i) => i.chart)).toEqual([
			"延迟",
		]);
		expect((await orchestrationView(api, copied.id)).focus_items.map((i) => i.chart)).toEqual([
			"TPS",
			"level",
		]);
	});

	it("源场景没有关注项时，副本也没有，不记最后修改", async () => {
		const source = await api.orchestrationWith(benchDocument(), "撮合浸泡");
		await putFocusItemsOk(api, source, [LOAD_TPS]);
		await putFocusItemsOk(api, source, []);

		const copied = await copy(source, "副本", "小明");
		expect(copied.focus_items).toEqual([]);
		expect(copied.focus_edit).toBeNull();
	});

	it("联调副本：复制后改成开发版本，关注项按开发版本里 Agent 加载的源码声明的图表判断", async () => {
		agent = await FakeAgent.connect(
			cp.grpcUrl,
			{
				name: "agent-a",
				devPackages: [
					{
						name: "bench",
						source: "/src/bench",
						metadataJson: JSON.stringify({
							name: "bench",
							version: "dev",
							requires_python: ">=3.10",
							nodes: [
								{
									name: "load",
									title: "load",
									entry: "bench:load",
									inputs: { type: "object", properties: {} },
									outputs: { type: "object", properties: {} },
									metrics: [{ name: "tps", unit: "req/s", kind: "gauge" }],
									charts: [{ title: "TPS", type: "area", metrics: ["tps"] }],
								},
							],
						}),
					},
				],
			},
			{ clock: cp.clock },
		);
		const source = await api.orchestrationWith(benchDocument([["load", "load"]]), "撮合浸泡");
		await putFocusItemsOk(api, source, [LOAD_TPS, LOAD_LATENCY], "小红");

		const debugCopy = await copy(source, "撮合浸泡-联调-小明", "小明");
		expect(debugCopy.focus_items.map((i) => [i.chart, i.status])).toEqual([
			["TPS", "ok"],
			["延迟", "ok"],
		]);
		expect(debugCopy.focus_edit).toMatchObject({
			updated_by: "小明",
			summary: "复制自「撮合浸泡」",
		});

		await api.saveVersion(debugCopy.id, benchDocument([["load", "load"]], "dev"), "小明");
		const view = await orchestrationView(api, debugCopy.id);
		expect(view.focus_items.map((i) => [i.chart, i.status])).toEqual([
			["TPS", "ok"],
			["延迟", "chart_missing"],
		]);
		expect(view.focus_edit).toEqual(debugCopy.focus_edit);
	});
});
