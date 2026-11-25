import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { failedRun } from "./monitor-failure-scenario";
import { largeScenario, openMonitor, runningScenario } from "./monitor-scenario";
import { createScenario, publishPackage, triggerRun } from "./support";

// 运行监控详情和概览的几处（#655）：同一个节点的用时两处写的是同一个数，概览链路里节点的状态除了颜色和形状还有文字
// （图例、悬停提示），选中带图表的节点时第一排图表露出来、没有被底部面板盖住（先加载骨架、后出图表时也一样）。

/** 线路上一个节点的站：圆点所在的一行悬停写「名字 · 状态」，旁边的读屏文字是「（状态）」。 */
async function expectStation(page: Page, name: string, status: string) {
	const dots = page.locator(`[title="${name} · ${status}"]`).first();
	await expect(dots, `${name} 的圆点悬停写「${name} · ${status}」`).toBeAttached();
	await expect(dots.locator("xpath=ancestor::li[1]").locator(".sr-only")).toHaveText(
		`（${status}）`,
	);
}

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
	// 没有选中节点：平台图表「节点耗时 Top 10」里同一个节点的数和时间线行一样（控制面按同样的口径算：各次尝试从排队到结束）。
	await openMonitor(page, clock, runId);
	await workspace(page).getByRole("button", { name: "全部展开" }).click();
	const top = workspace(page)
		.getByRole("region", { name: "平台自带图表" })
		.getByRole("figure", { name: "节点耗时 Top 10" });
	await expect(top.locator("li", { hasText: "fetch" })).toContainText("6.0s");
	await expect(top.locator("li", { hasText: "verify" })).toContainText("8.0s");
	await expect(top.locator("li", { hasText: "probe" })).toContainText("8.0s");
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
	for (const [name, status] of [
		["fetch", "成功"],
		["verify", "执行中"],
		["cleanup", "待执行"],
	] as const) {
		await expectStation(page, name, status);
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
	await expectStation(page, "probe", "准备中");
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
	await expectStation(page, "probe", "执行中");
});

/**
 * 选中节点的第一张图表在图表工作区里的位置：它自己的高度、在工作区里露出来的高度、露出来的最下面一点上最上面的元素是不是这张图表
 * （没有被别的东西盖住）；再带上时间线、图表工作区、底部面板的高度，失败时写在消息里。
 * 面板上沿有一条拖动条（`separator`）压着图表最下面的几像素，不算盖住（取点在露出部分的最下面往上 12px）。
 */
const measureFirstChart = (page: Page, node: string) =>
	page.evaluate((nodeId) => {
		const rectOf = (selector: string) =>
			document.querySelector(selector)?.getBoundingClientRect() ?? null;
		const ws = document.querySelector('[aria-label="图表工作区"]') as HTMLElement;
		const group = ws.querySelector(`[data-group$=":${nodeId}"]`);
		const first = group?.querySelector<HTMLElement>("[data-chart]");
		if (!first) return null;
		const wsRect = ws.getBoundingClientRect();
		const panelRect = rectOf('[aria-label="底部面板"]');
		const timelineRect = rectOf('[aria-label="链路时间线"]');
		const r = first.getBoundingClientRect();
		const top = Math.max(r.top, wsRect.top);
		const bottom = Math.min(r.bottom, wsRect.bottom);
		const probeY = Math.max(top + 1, bottom - 12);
		const hit = document.elementFromPoint(r.left + r.width / 2, probeY);
		const round = (n: number) => Math.round(n * 10) / 10;
		return {
			ratio: (bottom - top) / r.height,
			hitIsChart: hit ? first.contains(hit) : false,
			chart: { top: round(r.top), bottom: round(r.bottom), height: round(r.height) },
			workspace: { top: round(wsRect.top), bottom: round(wsRect.bottom) },
			panelTop: panelRect ? round(panelRect.top) : null,
			panelHeight: panelRect ? round(panelRect.height) : null,
			timelineHeight: timelineRect ? round(timelineRect.height) : null,
			hit: hit ? `${hit.tagName}.${String(hit.getAttribute("class")).slice(0, 60)}` : null,
		};
	}, node);

/** 第一张图表露出 `share` 以上、没有被盖住；不满足时消息里是量到的数。 */
async function expectFirstChartShown(page: Page, node: string, share = 0.95) {
	await expect
		.poll(
			async () => {
				const m = await measureFirstChart(page, node);
				if (m === null) return "没有图表";
				return m.ratio >= share && m.hitIsChart ? "ok" : JSON.stringify(m);
			},
			{ message: `${node} 的第一张图表露出 ${share * 100}% 以上`, timeout: 10_000 },
		)
		.toBe("ok");
}

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
	test(`选中带图表的节点：第一张图表露出 95% 以上、面板没有盖在上面（${width}×${height}）`, async ({
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
		await expectFirstChartShown(page, "fetch");
	});
}

test("图表是后加载出来的（运行还在进行）：骨架先排好、面板先长大也不压住图表，加载完第一张图表露出 95% 以上", async ({
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
	// 加载中：图表工作区和面板的位置，面板上沿不能高过工作区的下沿（不重叠）。
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
	await expectFirstChartShown(page, "fetch");
});

// 审查量到的情形（#655）：900 高的窗口，时间线里节点展开了九行以上（大型运行），选中一个节点、底部面板开着「输入输出」、
// 面板是默认高度：节点摘要在图表上面（失败的节点还有错误），图表区只有 300px 时第一张图表的下半截被图表区的下沿截掉。
// 现在图表区预留到第一张图表露出 96%，时间线和底部面板先让；窗口再矮，让到时间线最矮 120px、面板的下限 190px 为止。
test("大型运行（时间线九行以上）选中失败、执行中、重试的节点，面板默认高度：第一张图表整张露出来，时间线和面板先让", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	test.setTimeout(120_000);
	const { runId } = await largeScenario(controlPlane, connectAgent, clock);
	for (const [width, height] of [
		[1440, 900],
		[1280, 800],
		[1536, 864],
	] as const) {
		await page.setViewportSize({ width, height });
		for (const node of ["s08", "m15", "m07"]) {
			await openMonitor(page, clock, runId, node, "io");
			await expect(panel(page)).toBeVisible();
			await expect(workspace(page).locator(`[data-group$=":${node}"]`)).toBeVisible();
			await expectFirstChartShown(page, node, 0.95);
			// 面板不低于它的下限，时间线不低于最矮的主体（加标题行）。
			const m = await measureFirstChart(page, node);
			expect(m?.panelHeight, `${width}×${height} ${node} 底部面板`).toBeGreaterThanOrEqual(190);
			expect(m?.timelineHeight, `${width}×${height} ${node} 时间线`).toBeGreaterThanOrEqual(160);
		}
	}
});
