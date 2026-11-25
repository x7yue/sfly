import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { failedRun } from "./monitor-failure-scenario";
import { openMonitor, runningScenario } from "./monitor-scenario";
import { createScenario, publishPackage, triggerRun } from "./support";

// 运行监控详情和概览的几处（#655）：同一个节点的用时两处写的是同一个数，概览链路里节点的状态除了颜色和形状还有文字
// （图例、悬停提示），选中带图表的节点时第一排图表露出来、没有被底部面板盖住（先加载骨架、后出图表时也一样）。

const workspace = (page: Page) => page.getByRole("region", { name: "图表工作区" });
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });

test("节点的用时：时间线的节点行和选中节点的摘要是同一个总耗时，摘要写明排队和执行；「节点耗时 Top 10」也是这个数", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	// fetch：一次尝试，排队 2.0s、执行 4.0s；verify：第 1 次失败 3.0s、第 2 次执行中 5.0s；probe：没有排队，执行中 8.0s。
	for (const [node, total, note] of [
		["fetch", "6.0s", "排队 2.0s · 执行 4.0s"],
		["verify", "8.0s", "共 2 次尝试 · 最近一次执行 5.0s"],
		["probe", "8.0s", null],
	] as const) {
		await openMonitor(page, clock, runId, node, "attempts");
		await expect(panel(page)).toBeVisible();
		const row = page.locator(`[data-node-row="${node}"]`).getByTestId("node-total");
		await expect(row, `${node} 时间线行的总耗时`).toHaveText(total);
		await expect(row).toHaveAttribute("title", new RegExp(`^总耗时 ${total}`));
		const summary = page.getByTestId("node-summary").first();
		await expect(summary.getByText("总耗时")).toBeVisible();
		// 摘要里的总耗时和时间线行是同一个数
		await expect(
			summary.locator("div", { hasText: /^总耗时$/ }).locator("xpath=following-sibling::div[1]"),
			`${node} 摘要的总耗时`,
		).toHaveText(total);
		if (note) {
			await expect(summary.getByTestId("node-timing-note")).toHaveText(note);
		} else {
			await expect(summary.getByTestId("node-timing-note")).toHaveCount(0);
		}
	}
	// 没有选中节点：平台图表「节点耗时 Top 10」里同一个节点的数和时间线行一样（控制面按同样的口径算）。
	await openMonitor(page, clock, runId);
	const top = page.getByRole("figure", { name: "节点耗时 Top 10" });
	await expect(top).toContainText("6.0s");
	await expect(top).toContainText("8.0s");
});

test("概览链路里节点的状态：图例写出每个圆点的意思（只列这次运行里出现过的状态），圆点所在的一行悬停写「名字 · 状态」；图例的行高固定", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}?view=overview`);
	const section = page.getByRole("region", { name: "链路" });
	const legend = section.getByTestId("status-legend");
	await expect(legend).toBeVisible();
	// 这次运行里有：成功（entry、fetch、spawn、sub）、执行中（verify、probe）、待执行（cleanup）。
	await expect(legend.getByRole("listitem")).toHaveText(["成功", "执行中", "待执行"]);
	const kinds = await legend
		.locator("[data-status-dot]")
		.evaluateAll((dots) => dots.map((dot) => dot.getAttribute("data-status-dot")));
	expect(kinds).toEqual(["ok", "running", "pending"]);
	// 圆点还是 aria-hidden、图例是一个有名字的列表。
	await expect(legend).toHaveAccessibleName("状态图例");
	for (const dot of await legend.locator("[data-status-dot]").all()) {
		await expect(dot).toHaveAttribute("aria-hidden", "true");
	}
	// 线路上每个节点：圆点所在的一行悬停写出「名字 · 状态」，读屏的状态文字照旧。
	const lines = page.getByRole("list", { name: "各链进度" }).first();
	for (const [name, status] of [
		["fetch", "成功"],
		["verify", "执行中"],
		["cleanup", "待执行"],
	] as const) {
		const station = lines.locator("li", { has: page.getByText(name, { exact: true }) }).first();
		await expect(station.locator("[title]").first()).toHaveAttribute(
			"title",
			`${name} · ${status}`,
		);
		await expect(station.locator(".sr-only")).toHaveText(`（${status}）`);
	}
	// 行高固定：图例是一行（20px），出现的状态不同的另一次运行里，线路离区块顶端的距离一样（下面的版面不跳）。
	const legendBox = await legend.boundingBox();
	expect(legendBox?.height).toBe(20);
	const offset = (p: Page) =>
		p.evaluate(() => {
			const section = document.querySelector('[aria-labelledby="overview-chains"]') as HTMLElement;
			const lines = section.querySelector('[aria-label="各链进度"]') as HTMLElement;
			return Math.round(lines.getBoundingClientRect().top - section.getBoundingClientRect().top);
		});
	const first = await offset(page);
	const failed = await failedRun(controlPlane, connectAgent, clock, { cleanupDone: true });
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${failed.runId}?view=overview`);
	await expect(page.getByTestId("status-legend")).toBeVisible();
	// 失败的运行里出现的状态不一样（成功、失败、已跳过……）：图例的内容跟着变。
	const labels = await page.getByTestId("status-legend").getByRole("listitem").allTextContents();
	expect(labels).toContain("失败");
	expect(labels).not.toEqual(["成功", "执行中", "待执行"]);
	expect(await offset(page)).toBe(first);
});

test("准备中和执行中是同一个圆点：图例合成一项，节点的提示和读屏文字里各写各的", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane, {});
	const scenarioId = await createScenario(controlPlane, "准备中", {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "probe", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "p" } },
		],
		edges: [{ from: "entry", to: "probe", kind: "chain" }],
		packages: { "demo-checks": "1.2.0" },
	});
	const runId = await triggerRun(controlPlane, scenarioId);
	// 已经派发给 Agent、还没开始执行：准备中。
	const task = await agent.nextAssign({ start: false });
	clock.advance(1000);
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}?view=overview`);
	const legend = page.getByTestId("status-legend");
	await expect(legend.getByRole("listitem")).toHaveText(["成功", "准备中"]);
	const lines = page.getByRole("list", { name: "各链进度" }).first();
	const probe = lines.locator("li", { has: page.getByText("probe", { exact: true }) }).first();
	await expect(probe.locator("[title]").first()).toHaveAttribute("title", "probe · 准备中");
	await expect(probe.locator(".sr-only")).toHaveText("（准备中）");
	// 开始执行之后：圆点没变（都是在跑），图例写执行中，提示和读屏文字也变了。
	await agent.started(task);
	await agent.sync();
	clock.advance(1000);
	await page.clock.setFixedTime(clock.now());
	await page.reload();
	await expect(page.getByTestId("status-legend").getByRole("listitem")).toHaveText([
		"成功",
		"执行中",
	]);
	const running = page
		.getByRole("list", { name: "各链进度" })
		.first()
		.locator("li", { has: page.getByText("probe", { exact: true }) })
		.first();
	await expect(running.locator("[title]").first()).toHaveAttribute("title", "probe · 执行中");
});

/**
 * 选中带图表的节点：第一排图表在图表工作区里露出的高度、和底部面板重叠的高度、面板上沿的元素是不是盖在图表上。
 * 面板上沿有一条拖动条（`separator`）压着图表最下面的几像素，不算盖住。
 */
const firstRowOf = (page: Page, node: string) =>
	page.evaluate((nodeId) => {
		const ws = document.querySelector('[aria-label="图表工作区"]') as HTMLElement;
		const bottomPanel = document.querySelector('[aria-label="底部面板"]') as HTMLElement;
		const group = ws.querySelector(`[data-group$=":${nodeId}"]`);
		const figures = [...(group?.querySelectorAll("[data-chart]") ?? [])] as HTMLElement[];
		const first = figures[0];
		if (!first) return null;
		const wsRect = ws.getBoundingClientRect();
		const panelRect = bottomPanel.getBoundingClientRect();
		const r = first.getBoundingClientRect();
		const top = Math.max(r.top, wsRect.top);
		const bottom = Math.min(r.bottom, wsRect.bottom);
		// 图表在工作区里露出来的最下面一点（往上 12px）的位置上，最上面的元素是不是这张图表自己（里面的元素）。
		const probeY = Math.min(bottom - 12, panelRect.top - 12);
		const hit = document.elementFromPoint(r.left + r.width / 2, probeY);
		return {
			height: r.height,
			visible: Math.max(0, bottom - top),
			workspaceHeight: wsRect.height,
			panelTop: panelRect.top,
			hitIsChart: hit ? first.contains(hit) : false,
		};
	}, node);

const CHART_VIEWPORTS = [
	[1280, 720],
	[1280, 800],
	[1366, 768],
	[1440, 900],
	[1600, 700],
	[1536, 864],
	[1920, 1080],
] as const;

for (const [width, height] of CHART_VIEWPORTS) {
	test(`选中带图表的节点：第一排图表露出 95% 以上、面板没有盖在上面（${width}×${height}）`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		await page.setViewportSize({ width, height });
		const { runId } = await runningScenario(controlPlane, connectAgent, clock);
		await openMonitor(page, clock, runId, "fetch", "logs");
		await expect(panel(page)).toBeVisible();
		await expect(workspace(page).locator("[data-group]").first()).toBeVisible();
		await expect(workspace(page).getByText("加载中")).toHaveCount(0);
		let seen: Awaited<ReturnType<typeof firstRowOf>> = null;
		await expect
			.poll(
				async () => {
					seen = await firstRowOf(page, "fetch");
					return seen !== null && seen.visible / seen.height >= 0.95 && seen.hitIsChart;
				},
				{ message: `第一排图表：${JSON.stringify(seen)}` },
			)
			.toBe(true);
	});
}

test("图表是后加载出来的（运行还在进行）：骨架先排好、面板先长大也不压住图表，加载完第一排图表露出 95% 以上", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	// 指标的目录和数据都晚 2 秒才到：先画骨架，后出图表。
	await page.route("**/api/runs/*/metrics**", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		await route.fallback();
	});
	await openMonitor(page, clock, runId, "fetch", "logs");
	await expect(panel(page)).toBeVisible();
	// 加载中：图表工作区和面板的位置，量几个时刻，面板上沿不能高过工作区的下沿（不重叠）。
	const during = await page.evaluate(() => {
		const ws = document.querySelector('[aria-label="图表工作区"]') as HTMLElement;
		const bottomPanel = document.querySelector('[aria-label="底部面板"]') as HTMLElement;
		return {
			workspaceBottom: Math.round(ws.getBoundingClientRect().bottom),
			panelTop: Math.round(bottomPanel.getBoundingClientRect().top),
		};
	});
	expect(during.panelTop).toBeGreaterThanOrEqual(during.workspaceBottom - 1);
	await expect(workspace(page).locator("[data-chart]").first()).toBeVisible({ timeout: 15_000 });
	await expect(workspace(page).getByText("加载中")).toHaveCount(0, { timeout: 15_000 });
	let seen: Awaited<ReturnType<typeof firstRowOf>> = null;
	await expect
		.poll(
			async () => {
				seen = await firstRowOf(page, "fetch");
				return seen !== null && seen.visible / seen.height >= 0.95 && seen.hitIsChart;
			},
			{ message: `加载完之后第一排图表：${JSON.stringify(seen)}` },
		)
		.toBe(true);
});
