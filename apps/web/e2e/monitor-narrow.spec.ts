import type { Page } from "@playwright/test";
import { createEditorScenario, dock, openEditor, paneMenu } from "./editor-support";
import { expect, test } from "./fixtures";
import {
	FAILED_NAME,
	FAILED_NODE,
	FAILURE_HEADLINE,
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
/** 底部面板的默认高度下限（`DEFAULT_HEIGHT` 的 clamp 下限）：窗口矮时面板让出高度，也不低于它。 */
const PANEL_DEFAULT_MIN = 160;
/** 能看清曲线的图表高度：一张图表的绘图区（136px）至少露出这么多。 */
const VISIBLE_FIGURE = 120;

const header = (page: Page) => page.getByRole("banner");
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const workspace = (page: Page) => page.getByRole("region", { name: "图表工作区" });
const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });

for (const viewport of VIEWPORTS) {
	const size = `${viewport.width}×${viewport.height}`;

	test.describe(size, () => {
		test.use({ viewport });

		test("详情的竖直分配：失败横幅一行高，图表工作区至少 300px、图表露出能看清曲线的高度，面板不低于 160px，都在窗口里", async ({
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
			// 底部面板不低于默认高度的下限（日志和尝试够用）。
			expect(logs.height, note).toBeGreaterThanOrEqual(PANEL_DEFAULT_MIN);
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
			// 失败节点自己的 ERROR 日志就是失败区域里的那条错误：这里只剩那一行 WARN。
			await expect(rows).toHaveCount(1);
			await expect(rows.first()).toContainText("重试间隔偏长，已放宽到 5s");
			await expect(others).not.toContainText("成功率 97.2% 低于阈值 99%");
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

		test("顶栏：显示失败摘要时各链状态收起，摘要至少 288px（1400 宽以上 320px），不只剩「TimeoutErr…」，顶栏不被撑出屏幕", async ({
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
			await expect(bar.getByRole("list", { name: "各链状态" })).toBeHidden();
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
			// 空白处：工具条左边一点、离窗口底部 130px（菜单有 6 项约 190px 高，往下展开放不下，会贴着窗口底边，
			// 右边缘伸到工具条的最左端上面）。
			const dockBox = await rectOf(dock(page));
			await page.mouse.click(Math.max(40, dockBox.x - 150), viewport.height - 130, {
				button: "right",
			});
			const menu = paneMenu(page);
			await expect(menu).toBeVisible();
			const menuBox = await rectOf(menu);
			expect(
				intersects(menuBox, dockBox),
				`${size}：菜单 ${JSON.stringify(menuBox)}、工具条 ${JSON.stringify(dockBox)}`,
			).toBe(false);
		});

		test("快捷键面板：每一行的名称和按键之间至少隔 12px", async ({ page }) => {
			await page.goto("/");
			await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
			await page.keyboard.press("?");
			const dialog = page.getByRole("dialog", { name: "快捷键" });
			await expect(dialog).toBeVisible();
			const rows = dialog.locator("dl > div");
			const gaps = await rows.evaluateAll((items) =>
				items.map((row) => {
					const label = row.querySelector("dt");
					const keys = row.querySelector("dd");
					if (!label || !keys) throw new Error("这一行没有名称或按键");
					const range = document.createRange();
					range.selectNodeContents(label);
					return {
						text: label.textContent ?? "",
						gap:
							Math.round(
								(keys.getBoundingClientRect().left - range.getBoundingClientRect().right) * 10,
							) / 10,
					};
				}),
			);
			const tight = gaps.filter((g) => g.gap < 12);
			expect(tight, `${size}：名称和按键靠得太近的行`).toEqual([]);
			// 「删除选中的注释框」（Ctrl Shift G，按键最长的一行）也在里面。
			expect(gaps.map((g) => g.text)).toContain("删除选中的注释框");
		});
	});
}
