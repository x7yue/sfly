import { addMenu, inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import {
	createFocusScenario,
	focusDocument,
	openMetricsTab,
	saveVersion,
	sceneView,
	selectMetricsTab,
	setFocusItems,
} from "./focus-support";

// 在节点检查器里设关注项（#344 / #348）：每张图表一个「关注」开关，名额，失效的项，没有保存的节点。

const pin = (panel: ReturnType<typeof inspector>, chart: string) =>
	panel.getByRole("button", { name: `把 ${chart} 设为关注项` });
const quota = (panel: ReturnType<typeof inspector>) => panel.locator("output");

test("每张图表一个「关注」开关：打开后名额增加，刷新后还在，场景版本号不变；关闭后回到没有", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	const panel = await openMetricsTab(page, id, "fetch");

	await expect(quota(panel)).toHaveText("本场景的关注项已用 0 / 8");
	const latency = pin(panel, "延迟");
	await expect(latency).toHaveAttribute("aria-pressed", "false");
	await expect(latency).toHaveText("关注");
	await expect(panel.getByRole("button", { name: /设为关注项$/ })).toHaveCount(4);

	await latency.click();
	await expect(latency).toHaveAttribute("aria-pressed", "true");
	await expect(latency).toHaveText("关注");
	await expect(quota(panel)).toHaveText("本场景的关注项已用 1 / 8");
	await expect
		.poll(async () => (await sceneView(controlPlane, id)).focus_items)
		.toEqual([{ node_id: "fetch", chart: "延迟", status: "ok", chart_type: "line" }]);
	expect((await sceneView(controlPlane, id)).head_version).toBe(1);

	// 同一张图表在另一个节点上是另一个关注项；名额是整个场景的。
	await selectMetricsTab(page, "fetch2");
	await expect(pin(panel, "延迟")).toHaveAttribute("aria-pressed", "false");
	await expect(quota(panel)).toHaveText("本场景的关注项已用 1 / 8");

	await page.reload();
	await expect(nodeCard(page, "ping")).toBeVisible();
	await selectMetricsTab(page, "fetch");
	await expect(pin(panel, "延迟")).toHaveAttribute("aria-pressed", "true");
	await expect(quota(panel)).toHaveText("本场景的关注项已用 1 / 8");
	expect((await sceneView(controlPlane, id)).head_version).toBe(1);
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);

	await pin(panel, "延迟").click();
	await expect(pin(panel, "延迟")).toHaveAttribute("aria-pressed", "false");
	await expect(quota(panel)).toHaveText("本场景的关注项已用 0 / 8");
	await expect.poll(async () => (await sceneView(controlPlane, id)).focus_items).toEqual([]);
});

test("第一个写入还没有返回时再点别的开关：按点击的先后依次写入，后点的不会被先发出的覆盖", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	const panel = await openMetricsTab(page, id, "fetch");

	// 第一个写入挂起，等第二个开关也点过了再放行。
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let writes = 0;
	await page.route(`**/api/orchestrations/${id}`, async (route) => {
		if (route.request().method() === "PATCH" && writes++ === 0) await held;
		await route.continue();
	});

	await pin(panel, "吞吐").click();
	await pin(panel, "请求数").click();
	await expect(pin(panel, "请求数")).toHaveAttribute("aria-pressed", "true");
	await expect(quota(panel)).toHaveText("本场景的关注项已用 2 / 8");
	release();
	await expect
		.poll(async () => (await sceneView(controlPlane, id)).focus_items.map((i) => i.chart))
		.toEqual(["吞吐", "请求数"]);
	await expect(pin(panel, "吞吐")).toHaveAttribute("aria-pressed", "true");
});

test("满 8 个以后其余开关禁用并写明先移除一项，失效的项也占名额；取消一个后恢复", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, id, [
		...["延迟", "吞吐", "请求数", "errors"].map((chart) => ({ node_id: "fetch", chart })),
		...["延迟", "吞吐"].map((chart) => ({ node_id: "fetch2", chart })),
		...["level", "total"].map((chart) => ({ node_id: "ping", chart })),
	]);
	// 第 2 版去掉了 ping：它的两项失效，仍然占名额。
	await saveVersion(controlPlane, id, 1, {
		...focusDocument,
		nodes: focusDocument.nodes.filter((n) => n.id !== "ping"),
		edges: focusDocument.edges.filter((e) => e.to !== "ping"),
	});
	await expect
		.poll(async () => (await sceneView(controlPlane, id)).focus_items.map((i) => i.status))
		.toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "node_missing", "node_missing"]);

	await openEditor(page, id, "fetch2");
	const panel = await selectMetricsTab(page, "fetch2");
	await expect(quota(panel)).toHaveText(
		"本场景的关注项已用 8 / 8，已满（含 2 项已失效的）：先在场景设置的「关注项」页移除一项",
	);
	await expect(pin(panel, "请求数")).toBeDisabled();
	await expect(pin(panel, "errors")).toBeDisabled();
	// 已经是关注项的开关不禁用：随时可以取消。
	await expect(pin(panel, "延迟")).toBeEnabled();

	await pin(panel, "延迟").click();
	await expect(quota(panel)).toHaveText("本场景的关注项已用 7 / 8");
	await expect(pin(panel, "请求数")).toBeEnabled();
	await pin(panel, "请求数").click();
	await expect(pin(panel, "请求数")).toHaveAttribute("aria-pressed", "true");
	await expect(quota(panel)).toHaveText(
		"本场景的关注项已用 8 / 8，已满（含 2 项已失效的）：先在场景设置的「关注项」页移除一项",
	);
	await expect(pin(panel, "errors")).toBeDisabled();
});

test("还没有保存的节点不能设为关注项，保存成场景版本后可以", async ({ page, controlPlane }) => {
	const id = await createFocusScenario(controlPlane);
	await openEditor(page, id, "ping");
	await page.keyboard.press("/");
	await addMenu(page)
		.getByRole("option", { name: /^HTTP 检查/ })
		.click();
	const added = page.locator('[data-node-id^="http_check"]');
	await expect(added).toHaveCount(1);
	await added.click();
	const panel = inspector(page);
	await panel.getByRole("tab", { name: "说明与指标" }).click();

	await expect(
		panel.getByText("保存成场景版本以后，才能把这个节点的图表设为关注项。"),
	).toBeVisible();
	await expect(pin(panel, "延迟")).toBeDisabled();

	await page.keyboard.press("Control+s");
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
	await expect(pin(panel, "延迟")).toBeEnabled();
	await expect(panel.getByText("保存成场景版本以后，才能把这个节点的图表设为关注项。")).toHaveCount(
		0,
	);
	await pin(panel, "延迟").click();
	await expect(pin(panel, "延迟")).toHaveAttribute("aria-pressed", "true");
	await expect
		.poll(async () => (await sceneView(controlPlane, id)).focus_items.map((i) => i.chart))
		.toEqual(["延迟"]);
});

test("控制面拒绝时通知原因，开关回到原来的样子", async ({ page, controlPlane }) => {
	const id = await createFocusScenario(controlPlane);
	const panel = await openMetricsTab(page, id, "ping");

	// 别人在这个页面打开之后保存了第 2 版，去掉了 ping：页面还显示着它。
	await saveVersion(controlPlane, id, 1, {
		...focusDocument,
		nodes: focusDocument.nodes.filter((n) => n.id !== "ping"),
		edges: focusDocument.edges.filter((e) => e.to !== "ping"),
	});
	await pin(panel, "level").click();
	await expect(page.getByText("无法修改关注项")).toBeVisible();
	await expect(page.getByText(/最新版本里没有节点 ping/)).toBeVisible();
	await expect(pin(panel, "level")).toHaveAttribute("aria-pressed", "false");
	await expect(quota(panel)).toHaveText("本场景的关注项已用 0 / 8");
	expect((await sceneView(controlPlane, id)).focus_items).toEqual([]);
});
