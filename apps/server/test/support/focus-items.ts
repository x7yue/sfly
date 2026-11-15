import { type OrchestrationView, orchestrationsApi } from "@sfly/schema";
import { expect } from "vitest";
import type { ApiClient } from "./api-client.js";
import { publishPackage } from "./package-archive.js";
import type { TestControlPlane } from "./test-control-plane.js";

/** 关注项测试用的节点包 `bench`：节点类型与它们声明的图表，1.0.0 和 2.0.0 的区别是 `load` 的图表「TPS」改名为「吞吐」。 */
const load = (tpsChart: string) => ({
	outputs: [],
	metrics: [
		{ name: "tps", unit: "req/s", kind: "gauge" as const },
		{ name: "p99", unit: "ms", kind: "gauge" as const },
		{ name: "orders", unit: "", kind: "counter" as const },
	],
	charts: [
		{ title: tpsChart, type: "area" as const, metrics: ["tps"] },
		{ title: "延迟", type: "line" as const, metrics: ["p99"] },
	],
});

const probe = { outputs: [], metrics: [{ name: "level", unit: "", kind: "gauge" as const }] };

/** 八个指标、没有声明图表：控制面为每个指标生成一张默认图表（标题就是指标名 m1 到 m8）。 */
const wide = {
	outputs: [],
	metrics: Array.from({ length: 8 }, (_, i) => ({
		name: `m${i + 1}`,
		unit: "",
		kind: "gauge" as const,
	})),
};

/** 发布 `bench` 1.0.0 和 2.0.0：`load` 声明图表「TPS」（2.0.0 里叫「吞吐」）和「延迟」，没被图表引用的 `orders` 得到默认图表。 */
export async function publishBench(cp: TestControlPlane): Promise<void> {
	await publishPackage(cp, "bench", "1.0.0", { load: load("TPS"), probe, wide });
	await publishPackage(cp, "bench", "2.0.0", { load: load("吞吐"), probe, wide });
}

/** 入口节点加给定的包节点（`[节点 ID, 节点类型]`），依次连成一条链，锁定 `bench` 的 version。 */
export function benchDocument(
	nodes: ReadonlyArray<readonly [id: string, type: string]> = [
		["load", "load"],
		["probe", "probe"],
	],
	version = "1.0.0",
) {
	const ids = ["entry", ...nodes.map(([id]) => id)];
	return {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry" },
			...nodes.map(([id, type]) => ({
				id,
				kind: "package",
				package: "bench",
				node: type,
			})),
		],
		edges: ids.slice(1).map((to, i) => ({ from: ids[i], to, kind: "chain" })),
		packages: { bench: version },
	};
}

/** 请求体里的一个关注项。 */
export interface FocusItemBody {
	node_id: string;
	chart: string;
	title?: string;
}

/** 整份替换场景的关注项。 */
export function putFocusItems(
	api: ApiClient,
	orchestrationId: string,
	items: FocusItemBody[],
	nickname = "tester",
): Promise<Response> {
	return api.patch(`/orchestrations/${orchestrationId}`, { focus_items: items }, nickname);
}

/** 整份替换关注项并断言成功，返回场景视图（按 HTTP 契约解析）。 */
export async function putFocusItemsOk(
	api: ApiClient,
	orchestrationId: string,
	items: FocusItemBody[],
	nickname = "tester",
): Promise<OrchestrationView> {
	const res = await putFocusItems(api, orchestrationId, items, nickname);
	expect(res.status, await res.clone().text()).toBe(200);
	return orchestrationsApi.update.response.parse(await res.json());
}

/** 读取场景视图（按 HTTP 契约解析）。 */
export async function orchestrationView(
	api: ApiClient,
	orchestrationId: string,
): Promise<OrchestrationView> {
	return orchestrationsApi.get.response.parse(
		await api.getJson(`/orchestrations/${orchestrationId}`),
	);
}

/** 场景视图里每个关注项的 `节点:图表`。 */
export const focusKeys = (view: OrchestrationView): string[] =>
	view.focus_items.map((i) => `${i.node_id}:${i.chart}`);
