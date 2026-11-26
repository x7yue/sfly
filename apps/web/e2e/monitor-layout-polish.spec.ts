import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { failedRun, LONG_FAILURE_MESSAGE } from "./monitor-failure-scenario";
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

// 选中节点时底部面板、图表区、时间线的高度（#655：图表区预留到第一张图表露出 96%，时间线和面板先让）：
// 选的节点是 verify：它那一组的摘要（状态、Agent、总耗时和一行错误）在第一张图表上面，把图表推到离工作区顶端约 218px，
// 只留 300px 时图表的下半截被图表区的下沿截掉。预留的高度因此是图表的上沿加它高度的 96%（368px），面板和时间线让出来：
// 1440×900 里面板 237→190px（在 `PANEL_FLOOR`）、图表区 301→368px、时间线 310→290px，
// 1280×800 里面板仍是 190px、图表区 300→368px、时间线 258→190px。
// 之前（#686）这四条守的是「预留只在窄于 1280 的窗口里加高」：预留误加到 1280 及以上的窗口时三个高度都会变，所以三个高度都断言。
// fetch 那一组的摘要短，第一张图表的上沿加 150px 不到 300px，预留怎么改都不变，守不住这条，所以不用它。
// 以后底部面板的默认高度、时间线的高度有意改了，这几个数跟着改（改之前量一遍，写在 PR 里）。
const HEIGHTS = {
	"1440×900": { panel: 190, workspace: 368, timeline: 290 },
	"1280×800": { panel: 190, workspace: 368, timeline: 190 },
} as const;

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
] as const) {
	const size = `${viewport.width}×${viewport.height}` as keyof typeof HEIGHTS;
	for (const tab of ["logs", "actions"] as const) {
		test(`选中节点时底部面板、图表区、时间线的高度：${HEIGHTS[size].panel} / ${HEIGHTS[size].workspace} / ${HEIGHTS[size].timeline}px（verify 的${tab === "logs" ? "日志" : "动作"}页签，${size}）`, async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			await page.setViewportSize(viewport);
			const { runId } = await runningScenario(controlPlane, connectAgent, clock);
			await openMonitor(page, clock, runId, "verify", tab);
			const panel = page.getByRole("region", { name: "底部面板" });
			await expect(panel).toBeVisible();
			await expect(workspace(page).locator("[data-group]").first()).toBeVisible();
			const timeline = page.getByRole("region", { name: "链路时间线" });
			const want = { ...HEIGHTS[size] };
			// 版面稳定之后（图表工作区和时间线排完）量；允许 1px 的亚像素（差不超过 1px 的当作一样，失败时报出实际量到的数）。
			await expect
				.poll(
					async () => {
						const measured = {
							panel: Math.round((await rectOf(panel)).height),
							workspace: Math.round((await rectOf(workspace(page))).height),
							timeline: Math.round((await rectOf(timeline)).height),
						};
						return {
							panel: Math.abs(measured.panel - want.panel) <= 1 ? want.panel : measured.panel,
							workspace:
								Math.abs(measured.workspace - want.workspace) <= 1
									? want.workspace
									: measured.workspace,
							timeline:
								Math.abs(measured.timeline - want.timeline) <= 1
									? want.timeline
									: measured.timeline,
						};
					},
					{ message: `${size}：面板、图表区、时间线的高度` },
				)
				.toEqual(want);
		});
	}
}

/** 失败摘要最窄的宽度（`SUMMARY_MIN`）：1400 宽以上 320px，1280 到 1399 是 288px。 */
const summaryLeast = (width: number) => (width >= 1400 ? 320 : 288);

/**
 * 顶栏现在的样子：各链状态显示着还是收起了、摘要多宽、顶栏有没有被撑出屏幕，以及放不放得下：
 * `cut` 是失败摘要的全文比它的框宽多出来的宽度（被截成省略号的那一截），`clip` 是各链状态比它的框宽多出来的宽度（被裁掉的那一截），
 * 都是带小数的（`scrollWidth` 和 `clientWidth` 是取了整的，差 1px 分不清是取整还是真的被截）。各链状态收起着时，
 * 强行把它显示出来再量（和显示着时同样的样式，量完立刻还原，同一帧里不会被页面重新渲染）：`slack` 是这时空白占位剩的宽度。
 * 显示着时这两样都不该有；收起着时强行显示会截摘要或裁各链状态（或者剩的宽度不到 1px，差在取整上），才说明收起是对的。
 */
async function topBarState(page: Page) {
	return header(page).evaluate((bar) => {
		const summary = bar.querySelector('[data-testid="run-failure"]') as HTMLElement | null;
		const chains = bar.querySelector('ul[aria-label="各链状态"]') as HTMLElement | null;
		const spacer = bar.querySelector("[data-fit-spacer]") as HTMLElement | null;
		if (!summary || !chains || !spacer) throw new Error("顶栏里没有失败摘要、各链状态或空白占位");
		const shown = chains.getAttribute("aria-hidden") !== "true";
		const measure = () => {
			const range = document.createRange();
			range.selectNodeContents(summary);
			const style = getComputedStyle(summary);
			const full =
				range.getBoundingClientRect().width +
				Number.parseFloat(style.paddingLeft) +
				Number.parseFloat(style.paddingRight);
			const last = chains.lastElementChild as HTMLElement;
			return {
				cut: Math.max(0, full - summary.getBoundingClientRect().width),
				clip: Math.max(
					0,
					last.getBoundingClientRect().right - chains.getBoundingClientRect().right,
				),
				slack: spacer.getBoundingClientRect().width,
			};
		};
		let at = measure();
		if (!shown) {
			const style = chains.style.cssText;
			chains.removeAttribute("aria-hidden");
			chains.style.cssText = "visibility: visible; width: auto; margin-left: 0; flex-shrink: 1000";
			at = measure();
			chains.style.cssText = style;
			chains.setAttribute("aria-hidden", "true");
		}
		return {
			shown,
			...at,
			summary: Math.round(summary.getBoundingClientRect().width),
			overflow: bar.scrollWidth - bar.clientWidth,
		};
	});
}

/** 摘要被截、各链状态被裁，差不到这么多（px）不算（布局取整的误差）。 */
const FIT_TOLERANCE = 0.5;

/**
 * 把窗口调到这个宽度，量顶栏，返回各链状态是不是显示着；顺便断言这一档里该满足的几条：顶栏不被撑出屏幕、摘要不低于最窄宽度、
 * 显示着的各链状态没有被裁且摘要放得下全文（没有省略号），收起着的强行显示出来确实放不下（各链状态被裁或摘要被截，或者剩下的宽度不到 1px）。
 */
async function shownAtWidth(page: Page, width: number): Promise<boolean> {
	await page.setViewportSize({ width, height: 1080 });
	let state = await topBarState(page);
	await expect
		.poll(
			async () => {
				state = await topBarState(page);
				const numbers = `摘要被截 ${state.cut.toFixed(2)}px、各链状态被裁 ${state.clip.toFixed(2)}px、空白占位 ${state.slack.toFixed(2)}px`;
				if (state.overflow > 0) return `顶栏比窗口宽出 ${state.overflow}px`;
				if (state.summary < summaryLeast(width)) return `摘要只有 ${state.summary}px`;
				if (state.shown && state.clip > FIT_TOLERANCE)
					return `显示着，但各链状态被裁掉了（${numbers}）`;
				if (state.shown && state.cut > FIT_TOLERANCE)
					return `显示着，但摘要被截成了省略号（${numbers}）`;
				if (!state.shown && state.clip <= 0.05 && state.cut <= 0.05 && state.slack >= 1)
					return `收起了，但其实两样都放得下（${numbers}）`;
				return "";
			},
			{ message: `${width}px 宽的窗口` },
		)
		.toBe("");
	return state.shown;
}

/** 每一档量一遍顶栏（逐档的断言见 {@link shownAtWidth}），返回每一档里各链状态是不是显示着。 */
async function sweepTopBar(page: Page, widths: number[]) {
	const shownAt: boolean[] = [];
	for (const width of widths) shownAt.push(await shownAtWidth(page, width));
	return shownAt;
}

const TOP_BAR_WIDTHS = [1280, 1344, 1408, 1472, 1536, 1600, 1664, 1728, 1792, 1856, 1920];

test("顶栏：失败摘要放得下全文、各链状态也放得下才一起显示，放不下各链状态整个收起；界限是量出来的，不是写死的窗口宽度", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	// 要量上百个宽度（扫一遍、反着扫一遍、界限附近两个方向各走一遍），一个宽度几百毫秒。
	test.slow();
	await page.setViewportSize({ width: 1920, height: 1080 });
	// 运行还在进行、已有节点失败：详情里没有失败横幅，失败摘要在顶栏。
	const { runId } = await failedRun(controlPlane, connectAgent, clock, {
		cleanupDone: false,
		message: "TimeoutError: 延迟超过阈值",
	});
	await openMonitor(page, clock, runId);
	const bar = header(page);
	await expect(bar.getByTestId("run-failure")).toBeVisible();
	const chains = bar.getByRole("list", { name: "各链状态" });
	// 宽屏：两样一起显示，每个状态徽标都完整露出（没有被 overflow 裁掉），摘要是全文、没有省略号。
	await expect(chains).toBeVisible();
	const badges = chains.getByRole("listitem");
	expect(await badges.count()).toBeGreaterThan(0);
	const listBox = await rectOf(chains);
	for (const badge of await badges.all()) {
		const box = await rectOf(badge);
		expect(box.x + box.width).toBeLessThanOrEqual(listBox.x + listBox.width + 0.5);
		expect(box.width).toBeGreaterThan(0);
	}
	// 每一档：显示着的各链状态没有被裁、摘要放得下全文；收起着的强行显示出来，各链状态被裁或者摘要被截（确实放不下）；
	// 摘要不低于最窄宽度，顶栏不被撑出屏幕；越宽越放得下（显示的宽度是连在一起的一段，不来回跳）。
	const shownAt = await sweepTopBar(page, TOP_BAR_WIDTHS);
	const firstShown = shownAt.indexOf(true);
	expect(
		firstShown,
		`显示情况（${TOP_BAR_WIDTHS.join("、")}）：${shownAt.join("、")}`,
	).toBeGreaterThanOrEqual(0);
	expect(shownAt.slice(firstShown).every(Boolean), `显示情况：${shownAt.join("、")}`).toBe(true);
	// 最宽的显示着；最窄的一档（顶栏已经很挤）收起着：规则真的在起作用，不是一直显示或一直收起。
	expect(shownAt[0], "1280 宽").toBe(false);
	expect(shownAt[shownAt.length - 1], "1920 宽").toBe(true);
	// 从宽往窄再量一遍：每一档的结果和从窄往宽时一样（显示还是收起只看这时的宽度，不看是从哪边过来的，不来回跳）。
	const reversed = (await sweepTopBar(page, [...TOP_BAR_WIDTHS].reverse())).reverse();
	expect(reversed, "从宽往窄的显示情况").toEqual(shownAt);
	// 界限精确到 1px，而且显示还是收起只看这时的宽度、不看是从哪边走过来的：把窗口先放到最窄（各链状态收起）或最宽（显示），
	// 再跳到界限附近的每一个宽度（界限往窄 16px 到往宽 4px），逐个量。从窄的一边走过来，显示的时机早了（放不下就显示、
	// 显示之后各链状态被裁或摘要被截）、晚了都会在这里露出来；两边走到的界限最多差 1px（取整）。
	// 每一个宽度上的断言（显示着的不被裁不被截、收起着的确实放不下）见 {@link shownAtWidth}。
	let lo = TOP_BAR_WIDTHS[firstShown - 1] as number;
	let hi = TOP_BAR_WIDTHS[firstShown] as number;
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (await shownAtWidth(page, mid)) hi = mid;
		else lo = mid;
	}
	const near: number[] = [];
	for (let width = hi - 16; width <= hi + 4; width++) near.push(width);
	const fromNarrow: boolean[] = [];
	const fromWide: boolean[] = [];
	for (const width of near) {
		await shownAtWidth(page, TOP_BAR_WIDTHS[0] as number);
		fromNarrow.push(await shownAtWidth(page, width));
		await shownAtWidth(page, TOP_BAR_WIDTHS[TOP_BAR_WIDTHS.length - 1] as number);
		fromWide.push(await shownAtWidth(page, width));
	}
	const first = (shown: boolean[]) => near[shown.indexOf(true)] as number;
	const settled = (shown: boolean[]) => shown.slice(shown.indexOf(true)).every(Boolean);
	const detail = `从窄走过来：${first(fromNarrow)}px 起显示；从宽走过来：${first(fromWide)}px 起显示`;
	expect(settled(fromNarrow) && settled(fromWide), `显示的宽度不是连在一起的一段：${detail}`).toBe(
		true,
	);
	expect(Math.abs(first(fromNarrow) - first(fromWide)), detail).toBeLessThanOrEqual(1);
	console.log(`各链状态：${detail}`);
});

test("顶栏：失败摘要单独也放不下全文时，各链状态收起，摘要拿全部剩下的宽度；窗口再宽也不为了各链状态截摘要", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1920, height: 1080 });
	// 病态的失败原因（几千字的单行）：摘要永远放不下全文。
	const { runId } = await failedRun(controlPlane, connectAgent, clock, {
		cleanupDone: false,
		message: LONG_FAILURE_MESSAGE,
	});
	await openMonitor(page, clock, runId);
	await expect(header(page).getByTestId("run-failure")).toBeVisible();
	const shownAt = await sweepTopBar(page, TOP_BAR_WIDTHS);
	expect(shownAt, `显示情况：${shownAt.join("、")}`).toEqual(TOP_BAR_WIDTHS.map(() => false));
	// 收起之后各链状态不占宽度（摘要才拿得到）：宽屏里摘要比最窄宽度宽得多。
	const state = await topBarState(page);
	expect(state.summary).toBeGreaterThan(summaryLeast(1920) + 200);
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
		const label = row.firstElementChild as HTMLElement;
		return {
			label: Math.round(label.getBoundingClientRect().width),
			count: Math.round(count.getBoundingClientRect().width),
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
				// 放不放得下：每一站取上限、加上链名和计数，容器放得下（留 24px 的余量，免得界限上的取整）就必须是「放得下」的样子
				// （行尾空着），放不下就必须占满容器；界限附近两种都可以。线路的宽度规则被改坏（比如一律占满容器）时，
				// 下面按实际排出来的样子做的断言都还成立，只有这一条抓得到。
				const room = m.cells.length * LINE_CELL_PX + m.label + m.count;
				if (m.container >= room + 24) {
					expect(m.rowEnd, `${note}：容器放得下（要 ${room}px），行尾应当空着`).toBeGreaterThan(1);
				}
				if (m.container <= room - 24) {
					expect(
						m.rowEnd,
						`${note}：容器放不下（要 ${room}px），线路应当占满容器`,
					).toBeLessThanOrEqual(1);
				}
				if (m.rowEnd > 1) {
					// 放得下（行尾空着）：除最后一站外，每一站的格子正好是上限（再多的宽度不摊给站）；最后一站取它站名的宽度，
					// 计数紧跟在后面（上面的 `countGap`），多出来的宽度只留在计数之后：最后一站也是上限那么宽的话，
					// 末站的名字后面先空一百多像素才是计数，看起来像少了一站。最后一站的站名很长（节点 ID）时取站名的宽度，最宽 18rem 加两侧留白。
					const rest = m.cells.slice(0, -1);
					const last = m.cells[m.cells.length - 1] as number;
					for (const cell of rest) {
						expect(cell, `${note}：行尾空着，站的格子超过了上限`).toBeLessThanOrEqual(
							LINE_CELL_PX + CELL_SLACK,
						);
						expect(cell, `${note}：行尾空着，但站的格子没有取满`).toBeGreaterThanOrEqual(
							LINE_CELL_PX - 1,
						);
					}
					if (longId) expect(last, `${note}：最后一站（长 ID）`).toBeLessThanOrEqual(288 + 14 + 1);
					else expect(last, `${note}：最后一站应取站名的宽度，不是上限`).toBeLessThan(LINE_CELL_PX);
				} else {
					// 放不下：线路占满容器、按站名的宽度分整行（站名长的列比上限宽、短的窄），没有行尾的空白。
					expect(m.line, `${note}：放不下时线路占满容器`).toBeGreaterThanOrEqual(m.container - 1);
				}
				console.log(`线路 ${name} ${note}`);
			}
		});
	}
}
