// 切入点 A：节点类型的指标与图表声明——节点包查询 API 返回声明；没被任何图表引用的指标
// 由 API 补上默认图表（gauge 或带标签 → 折线，不带标签的 counter → 数值卡），并标明是默认生成；dev 版本同样处理。
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const orderGen = {
	name: "order_gen",
	title: "下单压测",
	entry: "demo_checks.perf:order_gen",
	inputs: { type: "object", properties: {} },
	outputs: { type: "object", properties: {} },
	metrics: [
		{ name: "tps", unit: "笔/s", kind: "gauge", description: "每秒成交笔数" },
		{ name: "p50", unit: "ms", kind: "gauge" },
		{ name: "p99", unit: "ms", kind: "gauge" },
		{ name: "inflight", unit: "笔", kind: "gauge" },
		{ name: "rejected", unit: "", kind: "counter" },
		{ name: "tps_by_conn", unit: "笔/s", kind: "gauge", labels: ["host", "port"] },
		{ name: "rejected_by_conn", unit: "", kind: "counter", labels: ["host"] },
	],
	charts: [
		{ title: "TPS", type: "area", metrics: ["tps", "tps_by_conn"] },
		{ title: "下单延迟", type: "line", metrics: ["p50", "p99"] },
	],
	primary_metric: "tps",
};

/** API 返回的 order_gen：声明的图表在前，之后是未被引用的指标的默认图表。 */
const orderGenView = {
	...orderGen,
	charts: [
		{ title: "TPS", type: "area", metrics: ["tps", "tps_by_conn"], default: false },
		{ title: "下单延迟", type: "line", metrics: ["p50", "p99"], default: false },
		{ title: "inflight", type: "line", metrics: ["inflight"], default: true },
		{ title: "rejected", type: "stat", metrics: ["rejected"], default: true },
		{ title: "rejected_by_conn", type: "line", metrics: ["rejected_by_conn"], default: true },
	],
};

const withOrderGen = () => {
	const base = packageMetadata();
	return { ...base, nodes: [...(base.nodes as unknown[]), orderGen] };
};

describe("指标与图表声明", () => {
	let cp: TestControlPlane | undefined;
	const agents: FakeAgent[] = [];
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp?.close();
		cp = undefined;
	});

	it("节点包查询 API 返回指标、图表和主指标，并为未被图表引用的指标补上默认图表", async () => {
		cp = await startTestControlPlane();
		const res = await cp.fetch("/packages", publishInit(packageArchive(withOrderGen())));
		expect(res.status).toBe(201);

		const version = (await (await cp.fetch("/packages/demo-checks/versions/1.2.0")).json()) as {
			metadata: { nodes: { name: string }[] };
		};
		expect(version.metadata.nodes.find((n) => n.name === "order_gen")).toEqual(orderGenView);

		const node = await cp.fetch("/packages/demo-checks/versions/1.2.0/nodes/order_gen");
		expect(await node.json()).toEqual(orderGenView);
	});

	it("只声明指标、不声明图表时，每个指标都有一张默认图表", async () => {
		cp = await startTestControlPlane();
		const { charts: _charts, primary_metric: _primary, ...metricsOnly } = orderGen;
		const base = packageMetadata();
		const metadata = { ...base, nodes: [...(base.nodes as unknown[]), metricsOnly] };
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);

		const node = await (
			await cp.fetch("/packages/demo-checks/versions/1.2.0/nodes/order_gen")
		).json();
		expect(node).toEqual({
			...metricsOnly,
			charts: [
				{ title: "tps", type: "line", metrics: ["tps"], default: true },
				{ title: "p50", type: "line", metrics: ["p50"], default: true },
				{ title: "p99", type: "line", metrics: ["p99"], default: true },
				{ title: "inflight", type: "line", metrics: ["inflight"], default: true },
				{ title: "rejected", type: "stat", metrics: ["rejected"], default: true },
				{ title: "tps_by_conn", type: "line", metrics: ["tps_by_conn"], default: true },
				// 带标签的指标不论瞬时值还是累计值，默认图表都是折线。
				{
					title: "rejected_by_conn",
					type: "line",
					metrics: ["rejected_by_conn"],
					default: true,
				},
			],
		});
		// 没有指定主指标时，节点类型没有主指标。
		expect(node).not.toHaveProperty("primary_metric");
	});

	it.each([
		[
			"图表引用了未声明的指标",
			{ charts: [{ title: "延迟", type: "line", metrics: ["p999"] }] },
			"图表 延迟 引用了未声明的指标 p999",
		],
		[
			"指标名重复",
			{ metrics: [...orderGen.metrics, { name: "tps", unit: "", kind: "gauge" }] },
			"指标名 tps 重复",
		],
		["主指标未声明", { primary_metric: "latency" }, "主指标 latency 未声明"],
		[
			"标签键超过 3 个",
			{ metrics: [{ name: "m", unit: "", kind: "gauge", labels: ["a", "b", "c", "d"] }] },
			"labels",
		],
		[
			"标签键重复",
			{ metrics: [{ name: "m", unit: "", kind: "gauge", labels: ["pid", "pid"] }] },
			"指标 m 的标签键 pid 重复",
		],
		[
			"标签键不是标识符",
			{ metrics: [{ name: "m", unit: "", kind: "gauge", labels: ["a-b"] }] },
			"labels",
		],
		["主指标带标签键", { primary_metric: "tps_by_conn" }, "主指标 tps_by_conn 带标签键"],
		[
			"数值卡引用带标签的指标",
			{ charts: [{ title: "连接 TPS", type: "stat", metrics: ["tps_by_conn"] }] },
			"图表 连接 TPS 是 stat，不能引用带标签键的指标 tps_by_conn",
		],
		[
			"柱状图引用带标签的指标",
			{ charts: [{ title: "连接 TPS", type: "bar", metrics: ["tps", "tps_by_conn"] }] },
			"图表 连接 TPS 是 bar，不能引用带标签键的指标 tps_by_conn",
		],
		[
			"超过 50 个指标",
			{
				metrics: Array.from({ length: 51 }, (_, i) => ({ name: `m${i}`, unit: "", kind: "gauge" })),
				charts: [],
				primary_metric: "m0",
			},
			"metrics",
		],
	])("发布时拒绝不合法的声明：%s", async (_label, fields, message) => {
		cp = await startTestControlPlane();
		const base = packageMetadata();
		const metadata = { ...base, nodes: [...(base.nodes as unknown[]), { ...orderGen, ...fields }] };
		const res = await cp.fetch("/packages", publishInit(packageArchive(metadata)));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toContain(message);
	});

	it("Agent 上报的 dev 版本同样带上声明和默认图表", async () => {
		cp = await startTestControlPlane();
		const metadata = {
			...packageMetadata({ name: "demo-dev", version: "dev" }),
			nodes: [orderGen],
		};
		agents.push(
			await FakeAgent.connect(cp.grpcUrl, {
				name: "agent-dev",
				devPackages: [{ name: "demo-dev", source: "/src", metadataJson: JSON.stringify(metadata) }],
			}),
		);
		const { agents: views } = await new ApiClient(cp).getJson<{
			agents: { name: string; dev_packages: { metadata: { nodes: unknown[] } }[] }[];
		}>("/agents");
		const view = views.find((a) => a.name === "agent-dev");
		expect(view?.dev_packages[0]?.metadata.nodes).toEqual([orderGenView]);
	});
});
