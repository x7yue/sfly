import { expect, type Locator, type Page } from "@playwright/test";
import type { OrchestrationView } from "@sfly/schema";
import { actAs } from "../../server/test/support/credentials.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { inspector, nodeCard, openEditor } from "./editor-support";
import { metricPackage } from "./monitor-scenario";
import { createScenario, publishPackage } from "./support";

// 关注项的设置（#344）：端到端测试共用的场景和通过 HTTP API 准备数据的小函数。

const bench = (id: string, node: string) => ({
	id,
	kind: "package",
	package: "demo-checks",
	node,
	inputs: node === "ping" ? { host: "h" } : { url: "https://example.test" },
});

/**
 * 主链 entry → fetch → fetch2 → ping，节点包是带指标声明的 demo-checks@1.2.0（`metricPackage()`）：
 * fetch 和 fetch2 各有四张图表（延迟、吞吐、请求数，加上平台为 errors 生成的默认图表），ping 有两张（level、total）。
 */
export const focusDocument = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", position: { x: 0, y: 0 } },
		{ ...bench("fetch", "http_check"), position: { x: 300, y: 0 } },
		{ ...bench("fetch2", "http_check"), position: { x: 600, y: 0 } },
		{ ...bench("ping", "ping"), position: { x: 900, y: 0 } },
	],
	edges: [
		{ from: "entry", to: "fetch", kind: "chain" },
		{ from: "fetch", to: "fetch2", kind: "chain" },
		{ from: "fetch2", to: "ping", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
};

/** 发布带指标声明的 demo-checks，新建场景「撮合浸泡」并保存 {@link focusDocument}；返回场景 ID。 */
export async function createFocusScenario(cp: TestControlPlane): Promise<string> {
	await publishPackage(cp, metricPackage());
	return createScenario(cp, "撮合浸泡", focusDocument);
}

const json = (method: string, body: unknown, user: string): RequestInit => ({
	method,
	headers: { "content-type": "application/json", ...actAs(user) },
	body: JSON.stringify(body),
});

async function ok(res: Response, what: string): Promise<Response> {
	if (!res.ok) throw new Error(`${what}：HTTP ${res.status} ${await res.text()}`);
	return res;
}

/** 整份替换场景的关注项。 */
export async function setFocusItems(
	cp: TestControlPlane,
	scenarioId: string,
	items: Array<{ node_id: string; chart: string; title?: string }>,
	user = "tester",
): Promise<void> {
	await ok(
		await cp.fetch(`/orchestrations/${scenarioId}`, json("PATCH", { focus_items: items }, user)),
		"设置关注项",
	);
}

/** 以 `base` 为编辑起点保存一个新版本。 */
export async function saveVersion(
	cp: TestControlPlane,
	scenarioId: string,
	base: number,
	document: unknown,
): Promise<void> {
	await ok(
		await cp.fetch(
			`/orchestrations/${scenarioId}/versions`,
			json("POST", { base_version: base, document }, "bob"),
		),
		"保存场景版本",
	);
}

/** 场景视图（含关注项和它们的状态）。 */
export async function sceneView(cp: TestControlPlane, scenarioId: string) {
	const res = await ok(await cp.fetch(`/orchestrations/${scenarioId}`), "读取场景");
	return (await res.json()) as OrchestrationView;
}

/** 打开场景的画布，选中节点，切到检查器的「说明与指标」页；返回检查器。 */
export async function openMetricsTab(page: Page, scenarioId: string, nodeId: string) {
	await openEditor(page, scenarioId, "ping");
	return selectMetricsTab(page, nodeId);
}

/** 选中另一个节点，切到「说明与指标」页。 */
export async function selectMetricsTab(page: Page, nodeId: string) {
	await nodeCard(page, nodeId).click();
	const panel = inspector(page);
	await panel.getByRole("tab", { name: "说明与指标" }).click();
	await expect(panel.getByRole("list", { name: "图表" })).toBeVisible();
	return panel;
}

/** 打开场景的画布，切到场景设置的「关注项」页（不选节点时的检查器）；返回检查器。 */
export async function openFocusList(page: Page, scenarioId: string, lastNode = "ping") {
	await openEditor(page, scenarioId, lastNode);
	const panel = inspector(page);
	const tab = panel.getByRole("tab", { name: "关注项" });
	await tab.click();
	await expect(tab).toHaveAttribute("aria-selected", "true");
	return panel;
}

/** 「关注项」页的列表（没有关注项时没有列表）。 */
export const focusList = (panel: Locator) => panel.getByRole("list", { name: "关注项" });

/** 「关注项」页上每一行的名字（输入框里的文字），按显示顺序。 */
export const focusNames = (panel: Locator) =>
	focusList(panel)
		.getByRole("textbox")
		.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));

/** 控制面上场景的关注项（`节点:图表`），按显示顺序。 */
export async function focusKeysOf(cp: TestControlPlane, scenarioId: string) {
	return (await sceneView(cp, scenarioId)).focus_items.map((i) => `${i.node_id}:${i.chart}`);
}
