import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { failedRun } from "./monitor-failure-scenario";
import { rectOf } from "./monitor-layout-support";
import { metricPackage, openMonitor, runningScenario } from "./monitor-scenario";
import { openOverview } from "./overview-support";
import { createScenario, publishPackage, triggerRun } from "./support";

// 运行监控版面的几处（#595 第 6 到 10 条，从 #586 的审查里挪来的，加上审查之后的两处调整）：1024×768 里图表区的预留、
// 选中节点时图表的定位、顶栏里失败摘要和各链状态放得下就一起显示（界限按实际放不放得下定）、线路里站的格子有上限宽度
// （站少时多出来的宽度留在行尾）。读元素排版后的实际位置，不比像素。

const workspace = (page: Page) => page.getByRole("region", { name: "图表工作区" });
const header = (page: Page) => page.getByRole("banner");

/**
 * 一个元素在图表工作区里露出来的高度：工作区的滚动区域减去吸顶的工具栏（工具栏盖住的那一截看不到）。
 */
const visibleInWorkspace = (el: Locator) =>
	el.evaluate((node) => {
		const box = node.closest('[aria-label="图表工作区"]') as HTMLElement;
		const bar = box.querySelector('[role="toolbar"]') as HTMLElement;
		const r = node.getBoundingClientRect();
		const top = Math.max(box.getBoundingClientRect().top, bar.getBoundingClientRect().bottom);
		return Math.max(
			0,
			Math.min(r.bottom, box.getBoundingClientRect().bottom) - Math.max(r.top, top),
		);
	});

/** 能看清曲线的图表高度：一张图表的绘图区（136px 高）至少露出这么多（和 monitor-narrow 里是同一个数）。 */
const VISIBLE_FIGURE = 120;

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
	{ width: 1024, height: 768 },
]) {
	const size = `${viewport.width}×${viewport.height}`;

	test(`详情：第一张图表露出能看清曲线的高度：窄窗口里工具栏折行、节点摘要折行把图表推下去时，预留的高度跟着加（${size}）`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		await page.setViewportSize(viewport);
		const { runId } = await failedRun(controlPlane, connectAgent, clock, {
			cleanupDone: true,
			metrics: true,
		});
		await openMonitor(page, clock, runId);
		const figure = workspace(page).getByRole("figure").first();
		await expect(figure).toBeVisible();
		const visible = await visibleInWorkspace(figure);
		const toolbar = await rectOf(workspace(page).getByRole("toolbar", { name: "图表工具栏" }));
		expect(
			visible,
			`${size}：第一张图表露出 ${visible}px，工具栏 ${toolbar.height}px，图表工作区 ${(await rectOf(workspace(page))).height}px`,
		).toBeGreaterThanOrEqual(VISIBLE_FIGURE);
	});
}

test("选中节点时，它那一组的第一张图表露出大半：选中靠后的节点（组在工作区下面看不到的地方）也滚到看得见", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	// probe 是子流程里的节点，它那一组排在工作区的最后一个节点组，打开时在底下。
	await openMonitor(page, clock, runId, "probe");
	const ws = workspace(page);
	await expect(ws.locator("[data-group]").first()).toBeVisible();
	await expect(ws.getByText("加载中")).toHaveCount(0);
	const group = ws.locator('[data-group$=":probe"]');
	const chart = group.locator("[data-chart]").first();
	await expect(chart).toBeVisible();
	const height = (await rectOf(chart)).height;
	await expect
		.poll(() => visibleInWorkspace(chart), { message: "选中的节点那一组的第一张图表露出的高度" })
		.toBeGreaterThanOrEqual(height * 0.75);
});

// 选中节点时底部面板的高度，和图表区预留的改动（#686，只在窄于 1280 的窗口里加高预留）之前一样：1440×900 里 237px、
// 1280×800 里 190px（`PANEL_FLOOR`；这时图表区正好是预留的 300px）。数是在 #686 之前的 `dev`（0214f433）和之后（dd42c6c0）
// 各量了一遍，完全一样（日志、动作、尝试三个页签都是）。预留的高度如果误加到 1280 及以上的窗口，这里的面板会被压矮。
// 以后底部面板的默认高度、时间线的高度有意改了，这几个数跟着改（改之前量一遍，写在 PR 里）。
const PANEL_HEIGHT = { "1440×900": 237, "1280×800": 190 } as const;

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
] as const) {
	const size = `${viewport.width}×${viewport.height}` as keyof typeof PANEL_HEIGHT;
	for (const [node, tab] of [
		["fetch", "logs"],
		["verify", "actions"],
	] as const) {
		test(`选中节点时底部面板的高度和 #686 之前一样：${PANEL_HEIGHT[size]}px（${node} 的${tab === "logs" ? "日志" : "动作"}页签，${size}）`, async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			await page.setViewportSize(viewport);
			const { runId } = await runningScenario(controlPlane, connectAgent, clock);
			await openMonitor(page, clock, runId, node, tab);
			const panel = page.getByRole("region", { name: "底部面板" });
			await expect(panel).toBeVisible();
			await expect(workspace(page).locator("[data-group]").first()).toBeVisible();
			// 版面稳定之后（图表工作区和时间线排完）量；允许 1px 的亚像素。
			let seen = 0;
			await expect
				.poll(
					async () => {
						seen = Math.round((await rectOf(panel)).height);
						return Math.abs(seen - PANEL_HEIGHT[size]) <= 1;
					},
					{ message: `${size}：底部面板 ${seen}px，应是 ${PANEL_HEIGHT[size]}px` },
				)
				.toBe(true);
			// 图表区没有被面板挤到预留的高度以下（300px）。
			expect((await rectOf(workspace(page))).height).toBeGreaterThanOrEqual(299);
		});
	}
}

/** 失败摘要最窄的宽度（`SUMMARY_MIN`）：1400 宽以上 320px，1280 到 1399 是 288px。 */
const summaryLeast = (width: number) => (width >= 1400 ? 320 : 288);

/**
 * 顶栏现在的样子：各链状态显示着还是收起了、摘要多宽、顶栏有没有被撑出屏幕。各链状态收起着时，强行把它显示出来量一下
 * （和 `useChainsFit` 不共用代码）：被裁了才说明收起是对的；显示着时看它有没有被裁。
 */
async function topBarState(page: Page) {
	return header(page).evaluate((bar) => {
		const summary = bar.querySelector('[data-testid="run-failure"]') as HTMLElement | null;
		const chains = bar.querySelector('ul[aria-label="各链状态"]') as HTMLElement | null;
		if (!summary || !chains) throw new Error("顶栏里没有失败摘要或各链状态");
		const shown = chains.getAttribute("aria-hidden") !== "true";
		const clipped = () => chains.scrollWidth - chains.clientWidth > 0.5;
		let wouldClip = clipped();
		if (!shown) {
			// 强行显示（和显示着时同样的样式）：量完立刻还原，同一帧里不会被页面重新渲染。
			const style = chains.style.cssText;
			chains.removeAttribute("aria-hidden");
			chains.style.cssText = "visibility: visible; width: auto; margin-left: 0; flex-shrink: 1000";
			wouldClip = clipped();
			chains.style.cssText = style;
			chains.setAttribute("aria-hidden", "true");
		}
		return {
			shown,
			wouldClip,
			summary: Math.round(summary.getBoundingClientRect().width),
			overflow: bar.scrollWidth - bar.clientWidth,
		};
	});
}

test("顶栏：失败摘要和各链状态放得下就一起显示，放不下各链状态整个收起；界限是量出来的，不是写死的窗口宽度", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1920, height: 1080 });
	// 运行还在进行、已有节点失败：详情里没有失败横幅，失败摘要在顶栏。
	const { runId } = await failedRun(controlPlane, connectAgent, clock, { cleanupDone: false });
	await openMonitor(page, clock, runId);
	const bar = header(page);
	await expect(bar.getByTestId("run-failure")).toBeVisible();
	const chains = bar.getByRole("list", { name: "各链状态" });
	// 宽屏：两样一起显示，每个状态徽标都完整露出（没有被 overflow 裁掉）。
	await expect(chains).toBeVisible();
	const badges = chains.getByRole("listitem");
	expect(await badges.count()).toBeGreaterThan(0);
	const listBox = await rectOf(chains);
	for (const badge of await badges.all()) {
		const box = await rectOf(badge);
		expect(box.x + box.width).toBeLessThanOrEqual(listBox.x + listBox.width + 0.5);
		expect(box.width).toBeGreaterThan(0);
	}
	// 从 1280 到 1920 每隔一段量一遍：显示着的没有被裁，收起着的强行显示出来确实被裁（放不下），摘要不低于最窄宽度，
	// 顶栏不被撑出屏幕；越宽越放得下（显示的宽度是连在一起的一段，不来回跳）。
	const widths = [1280, 1344, 1408, 1472, 1536, 1600, 1664, 1728, 1792, 1856, 1920];
	const shownAt: boolean[] = [];
	for (const width of widths) {
		await page.setViewportSize({ width, height: 1080 });
		let state = await topBarState(page);
		await expect
			.poll(
				async () => {
					state = await topBarState(page);
					if (state.overflow > 0) return `顶栏比窗口宽出 ${state.overflow}px`;
					if (state.summary < summaryLeast(width)) return `摘要只有 ${state.summary}px`;
					if (state.shown && state.wouldClip) return "显示着，但被裁掉了";
					if (!state.shown && !state.wouldClip) return "收起了，但其实放得下";
					return "";
				},
				{ message: `${width}px 宽的窗口` },
			)
			.toBe("");
		shownAt.push(state.shown);
	}
	const firstShown = shownAt.indexOf(true);
	expect(
		firstShown,
		`显示情况（${widths.join("、")}）：${shownAt.join("、")}`,
	).toBeGreaterThanOrEqual(0);
	expect(shownAt.slice(firstShown).every(Boolean), `显示情况：${shownAt.join("、")}`).toBe(true);
	// 最宽的显示着；1280 这一档（顶栏已经很挤）收起着：规则真的在起作用，不是一直显示或一直收起。
	expect(shownAt[0], "1280 宽").toBe(false);
	expect(shownAt[shownAt.length - 1], "1920 宽").toBe(true);
	console.log(
		`各链状态从 ${widths[firstShown]}px 宽起显示（前一档 ${widths[firstShown - 1]}px 收起）`,
	);
});

// 线路里站的格子有上限宽度（`LINE_CELL`，12rem）：站少时不平分整行、多出来的宽度留在行尾，放不下时才平分整行；
// 站名比格子长的列（长节点 ID）取站名的宽度，最宽 18rem 加上两侧留白。
const LINE_CELL_PX = 192;
// 放得下时链名和计数那两列是估的宽度（只往小里估），差几个像素摊到各站的格子上。
const CELL_SLACK = 8;
const NODE_IDS = [
	"entry",
	"fetch_orders",
	"validate_rows",
	"load_warehouse",
	"notify_owner",
	"archive_files",
	"cleanup_temp",
	"report_summary",
	"sync_metrics",
	"close_batch",
];
const LONG_ID = "fetch_exchange_rates_and_normalize_currency_codes_for_all_regions";

/** 一条链：第一个是入口，后面是调用 demo-checks 的 ping 节点。 */
function chainDocument(ids: string[]) {
	return {
		default_agent: "agent-a",
		nodes: ids.map((id, i) =>
			i === 0
				? { id, kind: "entry", params: [] }
				: { id, kind: "package", package: "demo-checks", node: "ping", inputs: { host: "p" } },
		),
		edges: ids.slice(1).map((id, i) => ({ from: ids[i], to: id, kind: "chain" })),
		packages: { "demo-checks": "1.2.0" },
	};
}

/** 第一行线路（主链）排出来的样子：容器宽、线路宽、各站格子宽、计数离最后一站多远、行尾空着多宽、有没有溢出。 */
async function firstLine(page: Page) {
	const list = page.getByRole("list", { name: "各链进度" }).first();
	await expect(list).toBeVisible();
	return list.evaluate((ul) => {
		const container = ul.parentElement as HTMLElement;
		const row = ul.querySelector(":scope > li") as HTMLElement;
		const stations = [...row.querySelectorAll("ol > li")] as HTMLElement[];
		const count = row.lastElementChild as HTMLElement;
		const last = stations[stations.length - 1] as HTMLElement;
		return {
			container: Math.round(container.getBoundingClientRect().width),
			line: Math.round(ul.getBoundingClientRect().width),
			cells: stations.map((s) => Math.round(s.getBoundingClientRect().width)),
			countGap: Math.round(count.getBoundingClientRect().left - last.getBoundingClientRect().right),
			rowEnd: Math.round(
				container.getBoundingClientRect().right - count.getBoundingClientRect().right,
			),
			overflow: Math.round(ul.scrollWidth - ul.clientWidth),
		};
	});
}

const LINE_CASES: Record<string, string[]> = {
	两站: NODE_IDS.slice(0, 2),
	三站: NODE_IDS.slice(0, 3),
	五站: NODE_IDS.slice(0, 5),
	"很长的链（10 个节点，折叠）": NODE_IDS,
	"两站，其中一个是很长的节点 ID": ["entry", LONG_ID],
};

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
	{ width: 1024, height: 768 },
]) {
	const size = `${viewport.width}×${viewport.height}`;

	for (const [name, ids] of Object.entries(LINE_CASES)) {
		test(`线路：${name}（${size}）：站的格子不超过上限宽度，多出来的宽度留在行尾，放不下时平分整行、不溢出；控制台的运行块和监控的概览一样`, async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			await page.setViewportSize(viewport);
			await connectAgent({
				name: "agent-a",
				slots: 4,
				installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
			});
			await publishPackage(controlPlane, metricPackage());
			const scenarioId = await createScenario(controlPlane, "线路场景", chainDocument(ids));
			const runId = await triggerRun(controlPlane, scenarioId);
			await page.clock.setFixedTime(clock.now());
			// 控制台的运行块。
			await page.goto("/");
			await expect(page.getByRole("region", { name: "正在运行" })).toBeVisible();
			const lines = { 控制台: await firstLine(page) };
			// 监控的概览。
			await openOverview(page, clock, runId);
			Object.assign(lines, { 概览: await firstLine(page) });
			const longId = ids.includes(LONG_ID);
			for (const [where, m] of Object.entries(lines)) {
				const note = `${size} ${where}：${JSON.stringify(m)}`;
				expect(m.overflow, `${note}：溢出`).toBeLessThanOrEqual(0);
				expect(m.line, `${note}：线路比容器宽`).toBeLessThanOrEqual(m.container + 0.5);
				// 计数紧挨着最后一站。
				expect(m.countGap, `${note}：计数离最后一站太远`).toBeLessThanOrEqual(8);
				if (m.rowEnd > 1) {
					// 行尾空着（放得下，多出来的宽度留在行尾）：每一站的格子正好是上限（站名都不长时），再多的宽度不摊给站；
					// 有一个很长的节点 ID 时，它的列取站名的宽度（最宽 18rem 加两侧留白），别的列仍是上限。
					const widest = Math.max(...m.cells);
					const others = longId ? m.cells.filter((c) => c !== widest) : m.cells;
					for (const cell of others) {
						expect(cell, `${note}：行尾空着，站的格子超过了上限`).toBeLessThanOrEqual(
							LINE_CELL_PX + CELL_SLACK,
						);
						expect(cell, `${note}：行尾空着，但站的格子没有取满`).toBeGreaterThanOrEqual(
							LINE_CELL_PX - 1,
						);
					}
					if (longId) expect(widest, `${note}：长 ID 的列`).toBeLessThanOrEqual(288 + 14 + 1);
				} else {
					// 放不下：线路占满容器、按站名的宽度分整行（站名长的列比上限宽、短的窄），没有行尾的空白。
					expect(m.line, `${note}：放不下时线路占满容器`).toBeGreaterThanOrEqual(m.container - 1);
				}
				console.log(`线路 ${name} ${note}`);
			}
		});
	}
}
