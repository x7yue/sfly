import type { Page } from "@playwright/test";
import { createEditorScenario, dock, openEditor, paneMenu } from "./editor-support";
import { expect, test } from "./fixtures";
import {
	FAILED_NAME,
	FAILED_NODE,
	FAILURE_HEADLINE,
	FAILURE_LOCATION,
	failedRun,
	openFailedOverview,
} from "./monitor-failure-scenario";
import { fits, intersects, overlaps, rectOf } from "./monitor-layout-support";
import { openMonitor, runningScenario } from "./monitor-scenario";

// #516：窄而矮的窗口里运行监控各区域怎么分配高度，以及名称被截断、重复的几处。每一条在 1440×900 和 1280×800 两个视口下
// 各有断言；断言读元素排版后的实际位置、宽度和高度（`getBoundingClientRect`），不比屏幕像素。

const VIEWPORTS = [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
] as const;

/** 图表工作区预留的高度（`CHARTS_RESERVED_HEIGHT`）：1280×800 带失败横幅时图表区至少有这么高。 */
const CHARTS_RESERVED = 300;
/** 底部面板的下限（`PANEL_FLOOR`）：窗口矮时面板让出高度，也不低于它。 */
const PANEL_DEFAULT_MIN = 190;
/** 能看清曲线的图表高度：一张图表的绘图区（136px）至少露出这么多。 */
const VISIBLE_FIGURE = 120;
/** 时间线标题行的高度（`TIMELINE_HEADER_HEIGHT`）：时间线区域的高度减去它就是主体的高度。 */
const TIMELINE_HEADER = 40;

const header = (page: Page) => page.getByRole("banner");
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const workspace = (page: Page) => page.getByRole("region", { name: "图表工作区" });
const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });

for (const viewport of VIEWPORTS) {
	const size = `${viewport.width}×${viewport.height}`;

	test.describe(size, () => {
		test.use({ viewport });

		test("详情的竖直分配：失败横幅一行高，图表工作区至少 300px、图表露出能看清曲线的高度，面板不低于 190px，时间线只在窗口矮时让，都在窗口里", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock, {
				cleanupDone: true,
				metrics: true,
			});
			await openMonitor(page, clock, runId);
			await expect(workspace(page)).toBeVisible();
			// 图表工作区里第一张图表（失败节点的那一组，节点摘要在它上面）。
			const figure = workspace(page).getByRole("figure").first();
			await expect(figure).toBeVisible();
			await expect(panel(page).getByRole("tab", { name: "日志" })).toBeVisible();

			const banner = await rectOf(page.locator('[data-slot="banner"]'));
			const charts = await rectOf(workspace(page));
			const logs = await rectOf(panel(page));
			const plot = await rectOf(figure);
			const bar = await rectOf(header(page));
			const line = await rectOf(timeline(page));
			const note = `${size}：顶栏 ${bar.height}、横幅 ${banner.height}、时间线 ${line.height}、图表区 ${charts.height}、面板 ${logs.height}、第一张图表露出 ${Math.min(plot.y + plot.height, charts.y + charts.height) - Math.max(plot.y, charts.y)}`;
			console.log(`LAYOUT516 ${note}`);

			// 失败横幅只占一行（标题和说明排在一行，高度由按钮和内边距决定；原来两行是 59px）。
			expect(banner.height, note).toBeLessThanOrEqual(44);
			// 图表工作区至少 300px。
			expect(charts.height, note).toBeGreaterThanOrEqual(CHARTS_RESERVED);
			// 第一张图表（绘图区 136px 高）在工作区里露出的高度：够看清曲线。
			const visible =
				Math.min(plot.y + plot.height, charts.y + charts.height) - Math.max(plot.y, charts.y);
			expect(visible, note).toBeGreaterThanOrEqual(VISIBLE_FIGURE);
			// 底部面板不低于下限（日志、尝试和动作表的第一行够用）。
			expect(logs.height, note).toBeGreaterThanOrEqual(PANEL_DEFAULT_MIN);
			// 时间线主体：窗口高（900）时上限是视口的 30%，这个运行的 8 行放得下（主体按内容的高度，没有滚动，也不低于 30%
			// 以下很多）；窗口矮（800）时才受剩下的高度限制——窗口减顶栏、横幅、时间线标题行、图表预留的 300px 和面板的
			// 190px 之后剩下的（175px）。矮窗口里时间线正好是这个高度，不挤掉面板和图表。
			const body = line.height - TIMELINE_HEADER;
			if (viewport.height >= 900) {
				expect(body, note).toBeLessThanOrEqual(viewport.height * 0.3 + 3);
				const scrolls = await page
					.locator("#timeline-body")
					.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
				expect(scrolls, `${note}：时间线主体要滚动（8 行没有放下）`).toBe(false);
			} else {
				const left =
					viewport.height -
					bar.height -
					banner.height -
					TIMELINE_HEADER -
					CHARTS_RESERVED -
					PANEL_DEFAULT_MIN;
				expect(body, note).toBeGreaterThanOrEqual(left - 3);
				expect(body, note).toBeLessThanOrEqual(left + 3);
			}
			// 各区域首尾相接、正好排满窗口：没有溢出窗口，也没有空白。
			expect(Math.abs(logs.y + logs.height - viewport.height), note).toBeLessThanOrEqual(1);
			expect(
				await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
				note,
			).toBe(true);
		});

		test("概览的「其他警告与错误」：失败区域已经写了的那条 ERROR 不再列一遍；节点名不被截成几个字", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock, {
				cleanupDone: true,
				warn: "重试间隔偏长，已放宽到 5s",
			});
			await openFailedOverview(page, clock, runId);
			const others = page.getByRole("region", { name: "其他警告与错误" });
			const rows = others.getByRole("button");
			// 失败节点自己的 ERROR 日志就是失败区域里的那条错误：这里只剩那一行 WARN。真的执行器还会在堆栈之前写一行 ERROR
			// 「出错位置：…」（场景里也写了），它不在失败原因的全文里，失败区域把同一个位置写在失败原因下面：也不再列一遍。
			await expect(rows).toHaveCount(1);
			await expect(rows.first()).toContainText("重试间隔偏长，已放宽到 5s");
			await expect(others).not.toContainText("成功率 97.2% 低于阈值 99%");
			await expect(others).not.toContainText("出错位置");
			await expect(page.getByTestId("failure-location")).toHaveText(
				`出错位置：${FAILURE_LOCATION}`,
			);
			// 失败区域里仍写着这条错误。
			await expect(page.getByTestId("failure-reason")).toHaveText(FAILURE_HEADLINE);
			// 节点名（「显示名称（节点 ID）」）整个看得见。
			const name = rows.first().locator("span").nth(2);
			await expect(name).toHaveText(`${FAILED_NAME}（${FAILED_NODE}）`);
			expect(await fits(name), `${size}：节点名被截断`).toBe(true);
		});

		test("底部「尝试」卡片：显示名称优先，放不下时先收起节点 ID，不把名称截成几个字", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await openMonitor(page, clock, runId, FAILED_NODE, "attempts");
			const card = panel(page).getByRole("article", {
				name: `${FAILED_NAME}（${FAILED_NODE}） 第 1 次尝试`,
			});
			await expect(card).toBeVisible();
			const head = card.locator("header");
			// 名称整个看得见；节点 ID 放得下才跟在后面。
			const nameText = head.locator("[data-truncate-clip]").first();
			await expect(nameText).toHaveText(FAILED_NAME);
			expect(await fits(nameText), `${size}：显示名称被截断`).toBe(true);
			// 头部里的各项互不压住、没有伸出卡片。
			expect(await overlaps(head)).toEqual([]);
		});

		test("链路卡片：失败节点的站名用上别的站让出的宽度，整个看得见", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await openFailedOverview(page, clock, runId);
			const names = page.getByRole("list", { name: "各链进度" }).locator("ol [data-truncate-clip]");
			await expect(names).toHaveCount(7);
			// 7 站的名称（包括 `显示名称（节点 ID）` 最长的失败节点）都整个看得见。
			const failed = names.nth(3);
			await expect(failed).toHaveText(`${FAILED_NAME}（${FAILED_NODE}）`);
			expect(await fits(failed), `${size}：失败节点的站名被截断`).toBe(true);
			for (const name of await names.all()) expect(await fits(name)).toBe(true);
		});

		test("时间线的名称列：总是执行的清理行，显示名称不被 always 标签挤成几个字", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await openMonitor(page, clock, runId);
			const row = page.locator('[data-node-row="cleanup"]').locator("button").first();
			await expect(row.getByText("always")).toBeVisible();
			const name = row.locator("[data-truncate-clip]").first();
			await expect(name).toHaveText("清理压测环境");
			expect(await fits(name), `${size}：清理行的显示名称被截断`).toBe(true);
			expect(await overlaps(row)).toEqual([]);
		});

		test("图表卡片的尝试下拉：「第 2 次尝试（最新）」整个看得见", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await runningScenario(controlPlane, connectAgent, clock);
			await openMonitor(page, clock, runId);
			const select = workspace(page).getByRole("combobox", { name: /的尝试$/ });
			await expect(select.first()).toBeVisible();
			await expect(select.first().locator("option:checked")).toHaveText("第 2 次尝试（最新）");
			// 选中项的文字宽度放得进下拉框（去掉左右内边距）。
			const { text, room } = await select.first().evaluate((el) => {
				const s = el as HTMLSelectElement;
				const style = getComputedStyle(s);
				const context = document.createElement("canvas").getContext("2d");
				if (!context) throw new Error("没有 canvas");
				context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
				return {
					text: context.measureText(s.selectedOptions[0]?.textContent ?? "").width,
					room:
						s.clientWidth -
						Number.parseFloat(style.paddingLeft) -
						Number.parseFloat(style.paddingRight),
				};
			});
			expect(text, `${size}：文字 ${text}px，放文字的宽度 ${room}px`).toBeLessThanOrEqual(room);
		});

		test("顶栏：显示失败摘要时各链状态放不下就收起（放得下完整显示，不裁掉半个徽标），摘要至少 288px（1400 宽以上 320px），不只剩「TimeoutErr…」，顶栏不被撑出屏幕", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			// 运行还在进行、已有节点失败：详情里没有失败横幅，失败摘要在顶栏。
			const { runId } = await failedRun(controlPlane, connectAgent, clock, { cleanupDone: false });
			await openMonitor(page, clock, runId);
			const bar = header(page);
			const summary = bar.getByTestId("run-failure");
			await expect(summary).toBeVisible();
			// 各链状态放得下才显示（界限按实际放不放得下定，整体的验证在 monitor-layout-polish）：显示着的完整露出。
			const chains = bar.getByRole("list", { name: "各链状态" });
			if (await chains.isVisible()) {
				const clipped = await chains.evaluate((el) => el.scrollWidth - el.clientWidth);
				expect(clipped, `${size}：各链状态被裁掉了 ${clipped}px`).toBeLessThanOrEqual(0.5);
			}
			const width = (await rectOf(summary)).width;
			const least = viewport.width >= 1400 ? 320 : 288;
			expect(width, `${size}：摘要 ${width}px`).toBeGreaterThanOrEqual(least);
			const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
			expect(
				overflow,
				`${size}：顶栏比窗口宽出 ${overflow}px，摘要 ${width}px`,
			).toBeLessThanOrEqual(0);
			// 耗时、状态、视图标签页和按钮不让位。
			await expect(bar.getByTestId("run-elapsed")).toBeVisible();
			expect(await fits(bar.getByTestId("run-elapsed"))).toBe(true);
			for (const control of [
				bar.getByRole("link", { name: "在画布中打开" }),
				bar.getByRole("button", { name: "取消运行" }),
			]) {
				await expect(control).toBeInViewport({ ratio: 1 });
			}
		});

		test("画布空白处的右键菜单靠近窗口底部往下展开时，不盖住底部工具条", async ({
			page,
			controlPlane,
		}) => {
			const id = await createEditorScenario(controlPlane);
			await openEditor(page, id);
			const dockBox = await rectOf(dock(page));
			/** 这几个点里第一个真的是画布空白处（不是节点卡片、子流程区域）的。 */
			const blankAmong = (points: { x: number; y: number }[]) =>
				page.evaluate(
					(candidates) =>
						candidates.find(({ x, y }) =>
							document.elementFromPoint(x, y)?.classList.contains("react-flow__pane"),
						),
					points,
				);
			const left = [150, 120, 180].map((dx) => dockBox.x - dx);
			// 先在高处打开一次，量出菜单有多高（6 项）。
			const high = await blankAmong(
				left.flatMap((x) => [100, 140, 180, 220].map((y) => ({ x, y }))),
			);
			if (!high) throw new Error(`${size}：高处找不到画布空白处`);
			await page.mouse.click(high.x, high.y, { button: "right" });
			await expect(paneMenu(page)).toBeVisible();
			const tall = (await rectOf(paneMenu(page))).height;
			await page.keyboard.press("Escape");
			await expect(paneMenu(page)).toBeHidden();
			// 再点在工具条左边一点、菜单的底边落在工具条那一条高度里的地方：往下展开放得下窗口，但右边缘伸到工具条的最左端上面。
			const top = dockBox.y + 20 - tall;
			const blank = await blankAmong(
				left.flatMap((x) => [0, -10, 10, -20, 5].map((dy) => ({ x, y: top + dy }))),
			);
			if (!blank) throw new Error(`${size}：工具条左边找不到画布空白处`);
			await page.mouse.click(blank.x, blank.y, { button: "right" });
			const menu = paneMenu(page);
			await expect(menu).toBeVisible();
			const menuBox = await rectOf(menu);
			expect(
				intersects(menuBox, dockBox),
				`${size}：点在 ${JSON.stringify(blank)}，菜单 ${JSON.stringify(menuBox)}、工具条 ${JSON.stringify(dockBox)}`,
			).toBe(false);
		});

		test("快捷键面板：每一行的名称不折行、和按键之间至少隔 12px，每一行一样高；1440×900 整个面板放得下，放不下时刚打开就有「还能往下滚」的提示，滚到底最后一行完整露出", async ({
			page,
		}) => {
			await page.goto("/");
			await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
			await page.keyboard.press("?");
			const dialog = page.getByRole("dialog", { name: "快捷键" });
			await expect(dialog).toBeVisible();
			const rows = dialog.locator("dl > div");
			const measured = await rows.evaluateAll((items) =>
				items.map((row) => {
					const label = row.querySelector("dt");
					const keys = row.querySelector("dd");
					if (!label || !keys) throw new Error("这一行没有名称或按键");
					const range = document.createRange();
					range.selectNodeContents(label);
					const box = row.getBoundingClientRect();
					return {
						text: label.textContent ?? "",
						// 名称占几行（折行的名称有不止一个矩形）。
						lines: range.getClientRects().length,
						height: Math.round(box.height * 10) / 10,
						gap:
							Math.round(
								(keys.getBoundingClientRect().left - range.getBoundingClientRect().right) * 10,
							) / 10,
						// 按键伸出这一行（压到下一列）。
						overflow: Math.round((keys.getBoundingClientRect().right - box.right) * 10) / 10,
					};
				}),
			);
			expect(
				measured.filter((m) => m.lines !== 1).map((m) => m.text),
				`${size}：折成几行的名称`,
			).toEqual([]);
			// 12px 的间距（`gap-3`）；排版的亚像素误差允许 0.5px。
			expect(
				measured.filter((m) => m.gap < 11.5).map((m) => `${m.text}（${m.gap}px）`),
				`${size}：名称和按键靠得太近的行`,
			).toEqual([]);
			expect(
				measured.filter((m) => m.overflow > 0.5).map((m) => m.text),
				`${size}：按键伸出这一行的行`,
			).toEqual([]);
			// 每一行一样高：没有哪一行因为折行比别的高。
			const heights = new Set(measured.map((m) => m.height));
			expect([...heights], `${size}：各行高度`).toHaveLength(1);
			// 「删除选中的注释框」（Ctrl Shift G，按键最长的一行）也在里面。
			expect(measured.map((m) => m.text)).toContain("删除选中的注释框");
			// 整个面板在窗口里（宽度跟着内容走，也不伸出窗口）。
			const box = await rectOf(dialog);
			expect(box.x, size).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width, size).toBeLessThanOrEqual(viewport.width);
			// 窗口宽到 1100px 起排四列、1300px 起排五列：1440×900 五列、整个面板放得下（四列还差 43px）；1280×800 四列、放不下。
			const columns = await dialog
				.locator("dl")
				.first()
				.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
			expect(columns, `${size}：列数`).toBe(viewport.width >= 1300 ? 5 : 4);
			// 刚打开时（还没滚过）：放得下就没有滚动；放不下时底边渐隐、提示还能往下滚，不让一行被滚动区的底边从文字中间切开。
			const area = dialog.locator("div.overflow-y-auto");
			const overflow = await area.evaluate((el) => el.scrollHeight - el.clientHeight);
			if (viewport.height >= 900) {
				expect(overflow, `${size}：面板里的内容放得下，不用滚`).toBeLessThanOrEqual(1);
				await expect(area).not.toHaveAttribute("data-more-below", "");
			} else {
				expect(overflow, `${size}：面板里的内容要滚`).toBeGreaterThan(1);
				await expect(area).toHaveAttribute("data-more-below", "");
				await expect(area).toHaveCSS("mask-image", /linear-gradient/);
			}
			// 滚到底：最后一行完整露出（不被滚动区的底边切在文字中间），不再渐隐。
			await area.evaluate((el) => {
				el.scrollTop = el.scrollHeight;
			});
			await expect(area).not.toHaveAttribute("data-more-below", "");
			await expect(area).toHaveCSS("mask-image", "none");
			const last = await rectOf(rows.last());
			const areaBox = await rectOf(area);
			expect(
				last.y + last.height,
				`${size}：最后一行 ${JSON.stringify(last)}、滚动区 ${JSON.stringify(areaBox)}`,
			).toBeLessThanOrEqual(areaBox.y + areaBox.height + 1);
		});
	});
}
