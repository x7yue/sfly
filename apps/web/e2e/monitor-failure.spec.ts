import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	FAILED_NAME,
	FAILED_NODE,
	FAILURE_HEADLINE,
	FAILURE_MESSAGE,
	failedRun,
	openFailedOverview,
	PRESET_NAME,
} from "./monitor-failure-scenario";
import { openMonitor, runningScenario } from "./monitor-scenario";
import { viewTab } from "./overview-support";
import { driveToRetry, FIRST, namedScenario } from "./run-display-name-scenario";
import { triggerRun } from "./support";

// 失败的运行（#458）：概览首屏的失败区域、链路卡片、顶栏和时间线名称列在两个视口下都完整可读。
// 文字有没有被截断读元素的实际宽度（`scrollWidth` 和 `clientWidth`），不比屏幕像素。

const VIEWPORTS = [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
] as const;

const NODE_LABEL = `${FAILED_NAME}（${FAILED_NODE}）`;

/**
 * 元素里的文字（包括里面的元素）有几处被截断：文字排出来的宽度超过了元素内容区的宽度。读的是排版后的实际宽度：
 * 元素带内边距时 `scrollWidth` 看不出差几个像素的截断（省略号已经出现了）。
 */
const clippedCount = (locator: Locator) =>
	locator.evaluate((root) => {
		const clipped = (el: Element) => {
			const style = getComputedStyle(el);
			const range = document.createRange();
			range.selectNodeContents(el);
			const content =
				el.getBoundingClientRect().width -
				Number.parseFloat(style.paddingLeft) -
				Number.parseFloat(style.paddingRight) -
				Number.parseFloat(style.borderLeftWidth) -
				Number.parseFloat(style.borderRightWidth);
			const clips = style.overflowX !== "visible" || style.textOverflow === "ellipsis";
			// 内容超出一个像素以上才算（亚像素的取整不算）。
			return clips && range.getBoundingClientRect().width > content + 1;
		};
		return [root, ...root.querySelectorAll("*")].filter(clipped).length;
	});

/** 元素里的文字没有被截断。 */
const fits = async (locator: Locator) => (await clippedCount(locator)) === 0;

/** 元素和它里面的每个元素都没有被截断，也没有伸出所在的块。 */
const nothingClipped = clippedCount;

/**
 * 一行（按钮）里从左到右的每一项互不重叠，也没有伸出这一行：返回压在前一项上的项的文字，没有就是空数组。
 * （只量名称有没有被自己的方框截断看不出名称是不是压在后面的标签和耗时上。）
 */
const overlaps = (row: Locator) =>
	row.evaluate((button) => {
		const box = button.getBoundingClientRect();
		let previous = box.left;
		const pressed: string[] = [];
		for (const el of button.children) {
			const { left, right } = el.getBoundingClientRect();
			if (left < previous - 0.5) pressed.push(el.textContent ?? "");
			previous = Math.max(previous, right);
		}
		if (previous > box.right + 0.5) pressed.push("（伸出了这一行）");
		return pressed;
	});

const area = (page: Page) => page.getByRole("region", { name: "失败的节点" });
const header = (page: Page) => page.getByRole("banner");
const chainCard = (page: Page) => page.getByRole("list", { name: "各链进度" });
const tooltips = (page: Page) => page.locator('[data-slot="tooltip-content"]');
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });

for (const viewport of VIEWPORTS) {
	const size = `${viewport.width}×${viewport.height}`;

	test.describe(size, () => {
		test.use({ viewport });

		test("失败的运行：概览首屏的失败区域写出失败的节点、第几次尝试和完整的原因，是首屏最突出的内容", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await openFailedOverview(page, clock, runId);

			const failure = area(page);
			await expect(failure).toBeVisible();
			// 首屏：整个区域在视口里，不用滚动，在链路上面。
			await expect(failure).toBeInViewport({ ratio: 1 });
			const [failureBox, chainBox] = await Promise.all([
				failure.boundingBox(),
				chainCard(page).boundingBox(),
			]);
			expect(failureBox?.y).toBeLessThan(chainBox?.y ?? 0);

			// 失败的节点、第几次尝试、失败原因的一行（#426 的失败原因一行，不是第一行的空话）。
			await expect(failure.getByRole("heading", { name: "运行失败" })).toBeVisible();
			await expect(failure.getByTestId("failure-node")).toHaveText(`${NODE_LABEL}第 1 次尝试`);
			await expect(failure.getByTestId("failure-reason")).toHaveText(FAILURE_HEADLINE);
			await expect(failure).toContainText("08:00:11 失败");
			// 完整显示：区域里没有任何一处文字被截断；原因一行太长就折行。
			expect(await nothingClipped(failure)).toBe(0);
			expect(await fits(failure.getByTestId("failure-reason"))).toBe(true);
			expect(await fits(failure.getByTestId("failure-node"))).toBe(true);

			// 层级：节点名是内容区里最大的字，比各区块的标题（`text-base`）还大；区域是第一个、也是唯一铺着色底的块。
			const sizes = await page.evaluate(() => {
				const px = (el: Element) => Number.parseFloat(getComputedStyle(el).fontSize);
				const content = document.querySelector('[role="tabpanel"]');
				const headings = [...(content?.querySelectorAll("h2") ?? [])].filter(
					(h) => !h.closest('[data-testid="failure-area"]'),
				);
				const node = document.querySelector('[data-testid="failure-node"]');
				const tinted = [...(content?.querySelectorAll("section") ?? [])].filter(
					(el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)",
				);
				return {
					node: node ? px(node) : 0,
					headings: headings.map(px),
					firstTinted: tinted[0]?.getAttribute("data-testid"),
				};
			});
			expect(sizes.headings.length).toBeGreaterThan(0);
			expect(sizes.node).toBeGreaterThan(Math.max(...sizes.headings));
			expect(sizes.firstTinted).toBe("failure-area");
		});

		test("失败区域：一步去失败节点的尝试和日志；错误信息的全文（含堆栈）展开才看", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await openFailedOverview(page, clock, runId);
			const failure = area(page);

			// 全文默认收着；展开后原样显示，包括堆栈，也包括第一行的异常模块路径。
			const toggle = failure.getByRole("button", { name: "完整的错误信息" });
			await expect(toggle).toHaveAttribute("aria-expanded", "false");
			await expect(failure.getByTestId("failure-full")).toHaveCount(0);
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
			const full = failure.getByTestId("failure-full");
			await expect(full).toBeVisible();
			expect(await full.evaluate((el) => el.textContent)).toBe(FAILURE_MESSAGE.trim());
			await toggle.click();
			await expect(failure.getByTestId("failure-full")).toHaveCount(0);

			// 到这个节点的尝试：切到详情、选中它、打开「尝试」页签。
			await failure.getByRole("button", { name: `在详情里查看 ${NODE_LABEL} 的尝试` }).click();
			await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
			await expect(panel(page).getByRole("tab", { name: "尝试" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await expect(
				panel(page).getByRole("article", { name: `${FAILED_NAME}（${FAILED_NODE}） 第 1 次尝试` }),
			).toContainText("成功率 97.2% 低于阈值 99%");

			// 到它的日志。
			await viewTab(page, "概览").click();
			await area(page)
				.getByRole("button", { name: `在详情里查看 ${NODE_LABEL} 的日志` })
				.click();
			await expect(panel(page).getByRole("tab", { name: "日志" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await expect(panel(page).getByRole("log", { name: "日志" })).toContainText(
				"成功率 97.2% 低于阈值 99%",
			);
		});

		test("运行还在进行、已有节点失败：概览一样有失败区域，标题写明运行还在进行", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock, { cleanupDone: false });
			await openFailedOverview(page, clock, runId);

			await expect(header(page).getByTestId("run-status")).toHaveText("运行中");
			const failure = area(page);
			await expect(
				failure.getByRole("heading", { name: "有节点失败，运行还在进行" }),
			).toBeVisible();
			await expect(failure.getByTestId("failure-node")).toHaveText(`${NODE_LABEL}第 1 次尝试`);
			await expect(failure.getByTestId("failure-reason")).toHaveText(FAILURE_HEADLINE);
			await expect(failure).toBeInViewport({ ratio: 1 });
			expect(await nothingClipped(failure)).toBe(0);
		});

		test("状态同时用颜色和形状表达：强制颜色模式下色底没有了，描边、形状和文字仍然分辨得出失败", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await page.emulateMedia({ forcedColors: "active" });
			await openFailedOverview(page, clock, runId);
			const failure = area(page);

			// 形状：标题前的八边形、节点前的实心菱形（`StatusDot` 的 SVG 用 currentColor 画）。
			const octagon = failure.locator("svg").first();
			await expect(octagon).toBeVisible();
			const diamond = failure.locator('[data-status-dot="failed"] svg');
			await expect(diamond).toBeVisible();
			// 描边还在（强制颜色换了色，不去掉边框），文字写着「失败」。
			await expect(failure).toHaveCSS("border-top-style", "solid");
			await expect(failure).toHaveCSS("border-top-width", "1px");
			await expect(failure.getByTestId("failure-node")).toBeVisible();
			await expect(failure.getByText("08:00:11 失败")).toBeVisible();
			await expect(failure.getByRole("heading", { name: "运行失败" })).toBeVisible();
		});

		test("链路卡片：节点名用上可用的宽度，放不下时截断在名称的末尾、悬停看全名；被跳过的节点单独计数", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await openFailedOverview(page, clock, runId);

			const names = chainCard(page).locator("ol [data-truncate-clip]");
			await expect(names).toHaveText([
				"entry",
				"准备压测环境（prepare）",
				"部署被测服务（deploy）",
				NODE_LABEL,
				"生成压测报告（report）",
				"发布压测结果（publish）",
				"清理压测环境（cleanup）",
			]);
			// 每个名称至少有 120px（以前每站只有约 85px，几乎全被截断），不长的名称整个看得见。
			for (const [i, expected] of [1, 2, 4, 5, 6].entries()) {
				const name = names.nth(expected);
				expect(await fits(name), `第 ${i} 个名称被截断了`).toBe(true);
				expect(await name.evaluate((el) => el.clientWidth)).toBeGreaterThan(120);
			}
			// 太长的那个截断在末尾（省略号），悬停显示全名。
			const long = names.nth(3);
			expect(await fits(long)).toBe(false);
			expect(await long.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
			await long.hover();
			await expect(tooltips(page)).toHaveText(NODE_LABEL);

			// 汇总：被跳过的两个节点不算已完成，单独计数。
			const mainChain = chainCard(page).locator("li").first();
			await expect(mainChain.getByText("4/7", { exact: true })).toBeVisible();
			await expect(mainChain.locator("[data-skipped-count]")).toHaveText("跳过 2");
		});

		test("链路卡片：站名分余量时不挤掉每条链的名称，有子流程的运行里「主链」「子流程 …」都完整", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await runningScenario(controlPlane, connectAgent, clock);
			await openFailedOverview(page, clock, runId);

			const rows = chainCard(page)
				.locator("li")
				.filter({ has: page.locator("ol") });
			const labels = rows.locator("> span:first-child");
			await expect(labels).toHaveCount(2);
			await expect(labels.first()).toContainText("主链");
			await expect(labels.nth(1)).toContainText("子流程");
			for (const label of await labels.all()) expect(await fits(label)).toBe(true);
			// 站名都完整（这里的节点都没有显示名称，站名只是节点 ID）。
			const stations = chainCard(page).locator("ol [data-truncate-clip]");
			expect(await stations.count()).toBe(7);
			for (const station of await stations.all()) expect(await fits(station)).toBe(true);
		});

		test("顶栏：预设名和耗时不被互相挤掉，放不下时先截断失败摘要", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await openFailedOverview(page, clock, runId);
			const bar = header(page);

			// 耗时整个看得见（不和触发人、开始时间一起被截断）。
			const elapsed = bar.getByTestId("run-elapsed");
			await expect(elapsed).toHaveText("耗时 13.0s");
			expect(await fits(elapsed)).toBe(true);
			// 预设名：不止一个省略号（以前只剩 64px），宽的窗口里整个看得见。
			const preset = bar.getByText(`预设：${PRESET_NAME}`);
			expect(await preset.evaluate((el) => el.clientWidth)).toBeGreaterThanOrEqual(112);
			if (viewport.width >= 1440) expect(await fits(preset)).toBe(true);
			// 失败摘要最先让位：它被截断，顶栏本身没有被撑出屏幕。
			const summary = bar.getByTestId("run-failure");
			expect(await fits(summary)).toBe(false);
			expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
			// 视图标签页和右边的按钮都在视口里。
			for (const control of [
				viewTab(page, "详情"),
				bar.getByRole("link", { name: "在画布中打开" }),
				bar.getByRole("button", { name: "再次运行" }),
			]) {
				await expect(control).toBeInViewport({ ratio: 1 });
			}
		});

		test("时间线的名称列：显示名称很长时截断在末尾，不压住后面的重试次数和耗时", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { agent, scenarioId } = await namedScenario(controlPlane, connectAgent, {
				...FIRST,
				verify: "核对结果：对比订单库与支付流水的差异，超过阈值时报警",
			});
			const runId = await triggerRun(controlPlane, scenarioId);
			await driveToRetry(agent, clock, await agent.nextAssign());
			await openMonitor(page, clock, runId);

			const row = page
				.getByRole("region", { name: "链路时间线" })
				.locator('[data-node-row="verify"] > button');
			// 行里从左到右的每一项（状态点、名称、节点类型、×2、耗时）互不重叠，也没有伸出这一行。
			expect(await overlaps(row)).toEqual([]);
			// 名称被截断（有省略号），「（节点 ID）」一个字也不剩；耗时和「×2」完整。
			const clips = row.locator("[data-truncate-clip]");
			expect(await fits(clips.nth(0))).toBe(false);
			expect(await clips.nth(1).evaluate((el) => el.clientWidth)).toBe(0);
			await expect(row.getByText("×2")).toBeVisible();
			await expect(row.getByText(/^\d+(\.\d+)?s$/)).toBeVisible();
			await row.hover();
			await expect(tooltips(page)).toContainText(
				"核对结果：对比订单库与支付流水的差异，超过阈值时报警（verify）",
			);
		});

		test("时间线的名称列：显示名称优先，放不下时先截断节点 ID", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await page.clock.setFixedTime(clock.now());
			await page.goto(`/runs/${runId}?view=detail`);
			const timeline = page.getByRole("region", { name: "链路时间线" });
			await expect(timeline).toBeVisible();

			for (const [id, name] of [
				["prepare", "准备压测环境"],
				["deploy", "部署被测服务"],
				[FAILED_NODE, FAILED_NAME],
				["report", "生成压测报告"],
				["publish", "发布压测结果"],
				["cleanup", "清理压测环境"],
			] as const) {
				const row = timeline.locator(`[data-node-row="${id}"] button`);
				const clips = row.locator("[data-truncate-clip]");
				// 第一段是显示名称，第二段是「（节点 ID）」。
				await expect(clips.nth(0)).toHaveText(name);
				await expect(clips.nth(1)).toHaveText(`（${id}）`);
				expect(await overlaps(row), `${name} 压在别的项上`).toEqual([]);
				// 显示名称优先：它被截断时（只有带 always 标签、右边多占一块的那一行放不下），「（节点 ID）」已经一个字也不剩了。
				const truncated = !(await fits(clips.nth(0)));
				if (id !== "cleanup") expect(truncated, `${name} 被截断了`).toBe(false);
				if (truncated) {
					expect(
						await clips.nth(1).evaluate((el) => el.clientWidth),
						`${name} 被截断时 ID 还在`,
					).toBe(0);
				}
			}
			// 「（节点 ID）」才是被截断的那个（这一行的 ID 最长）；悬停整行显示完整的名称。
			const longRow = timeline.locator(`[data-node-row="${FAILED_NODE}"] button`);
			expect(await fits(longRow.locator("[data-truncate-clip]").nth(1))).toBe(false);
			await longRow.hover();
			await expect(tooltips(page)).toContainText(NODE_LABEL);
			// 读屏名称仍是完整的「名称（ID） 说明 状态」。
			await expect(longRow).toHaveAccessibleName(
				new RegExp(`^${NODE_LABEL} demo-checks/ping 失败`),
			);
		});
	});
}
