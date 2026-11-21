import type { Locator, Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import {
	FAILED_NAME,
	FAILED_NODE,
	FAILURE_HEADLINE,
	FAILURE_MESSAGE,
	failedRun,
	LONG_FAILURE_MESSAGE,
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

/**
 * 时间线名称列里「（节点 ID）」有没有显示出来：和名称一行放得下才跟在名称后面，放不下时换到被裁掉的第二行
 * （它的底边落在这一格的下面）。
 */
const idShown = (row: Locator) =>
	row.evaluate((button) => {
		const cell = button.querySelector("[data-truncate-wrap]");
		const id = cell?.lastElementChild;
		if (!cell || !id) throw new Error("这一行没有名称和节点 ID");
		return id.getBoundingClientRect().bottom <= cell.getBoundingClientRect().bottom + 0.5;
	});

/**
 * 时间线名称列里节点类型（「ping」）要么整个显示，要么整个收起：不留半个字、几像素宽的残片
 * （它在名称之后第二个 `data-truncate-wrap` 里，放不下时换到被裁掉的第二行）。
 */
const typeIsWholeOrHidden = (row: Locator) =>
	row.evaluate((button) => {
		const cell = button.querySelectorAll("[data-truncate-wrap]")[1];
		const text = cell?.lastElementChild;
		if (!cell || !text) throw new Error("这一行没有节点类型");
		const box = cell.getBoundingClientRect();
		const word = text.getBoundingClientRect();
		const hidden = word.bottom > box.bottom + 0.5;
		return hidden || word.right <= box.right + 0.5;
	});

const area = (page: Page) => page.getByTestId("failure-area");
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
			// 正常长度的原因完整显示：没有被收起（4 行以内，一个字也没被省略）。
			const reason = failure.getByTestId("failure-reason");
			await expect(reason).not.toHaveAttribute("data-clamped");
			expect(await reason.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

			// 层级：节点名 `text-lg` 比各区块的标题（`text-base`）都大；区域是概览里唯一铺着彩色底的块（别的块的底色都是中性灰）。
			const sizes = await page.evaluate(() => {
				const px = (el: Element) => Number.parseFloat(getComputedStyle(el).fontSize);
				const content = document.querySelector('[role="tabpanel"]');
				const headings = [...(content?.querySelectorAll("h2") ?? [])].filter(
					(h) => !h.closest('[data-testid="failure-area"]'),
				);
				const node = document.querySelector('[data-testid="failure-node"]');
				// 铺着底色的块里，不是中性灰（红、绿、蓝分量不相等）的。底色可能写成 rgb() 或 color(srgb …)。
				const channels = (css: string): [number, number, number] | null => {
					const rgb = /^rgba?\((\d+), (\d+), (\d+)/.exec(css);
					if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
					const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(css);
					return srgb
						? [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255]
						: null;
				};
				const colored = [...(content?.querySelectorAll("section") ?? [])].filter((el) => {
					const c = channels(getComputedStyle(el).backgroundColor);
					return c !== null && (Math.abs(c[0] - c[1]) > 4 || Math.abs(c[1] - c[2]) > 4);
				});
				return {
					node: node ? px(node) : 0,
					headings: headings.map(px),
					colored: colored.map((el) => el.getAttribute("data-testid")),
				};
			});
			expect(sizes.headings.length).toBeGreaterThan(0);
			expect(sizes.node).toBeGreaterThan(Math.max(...sizes.headings));
			expect(sizes.colored).toEqual(["failure-area"]);
		});

		test("失败原因特别长（几千字的单行）：最多显示 4 行，不把链路挤出首屏，展开全文看得到全部", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock, {
				cleanupDone: true,
				message: LONG_FAILURE_MESSAGE,
			});
			await openFailedOverview(page, clock, runId);
			const failure = area(page);
			const reason = failure.getByTestId("failure-reason");

			// 页面里（读屏、页内查找拿到的）仍是全文；看得见的只有 4 行，在末尾省略。
			await expect(reason).toHaveText(LONG_FAILURE_MESSAGE);
			await expect(reason).toHaveAttribute("data-clamped", "true");
			const lines = await reason.evaluate((el) => {
				const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
				return {
					shown: Math.round(el.clientHeight / lineHeight),
					all: Math.round(el.scrollHeight / lineHeight),
				};
			});
			expect(lines.shown).toBe(4);
			expect(lines.all).toBeGreaterThan(4);

			// 整个失败区域仍在首屏里，链路卡片没有被挤出首屏（它的标题和第一行线路看得见）。
			await expect(failure).toBeInViewport({ ratio: 1 });
			const [failureBox, chainBox] = await Promise.all([
				failure.boundingBox(),
				chainCard(page).boundingBox(),
			]);
			expect(chainBox?.y).toBeGreaterThan(failureBox?.y ?? Number.POSITIVE_INFINITY);
			expect(chainBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(viewport.height - 120);

			// 展开全文：被收起的部分看得到，原文一个字不少；再点一次收回去。
			const toggle = failure.getByRole("button", { name: "展开全文" });
			await expect(toggle).toHaveAttribute("aria-expanded", "false");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
			const full = failure.getByTestId("failure-full");
			await expect(full).toBeVisible();
			expect(await full.evaluate((el) => el.textContent)).toBe(LONG_FAILURE_MESSAGE);
			await toggle.click();
			await expect(failure.getByTestId("failure-full")).toHaveCount(0);
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
			const toggle = failure.getByRole("button", { name: "展开全文" });
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

		test("状态同时用颜色和形状表达：强制颜色模式下色底和红色都没有了，描边、形状和文字仍然分辨得出失败", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId } = await failedRun(controlPlane, connectAgent, clock);
			await openFailedOverview(page, clock, runId);
			const failure = area(page);
			const color = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).color);
			/** 底色是不是中性灰（红、绿、蓝分量相等）：作者的红色底换成系统颜色之后是（带透明度的）黑或白。 */
			const neutralBackground = (locator: Locator) =>
				locator.evaluate((el) => {
					const css = getComputedStyle(el).backgroundColor;
					const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(css);
					return m ? m[1] === m[2] && m[2] === m[3] : false;
				});
			const diamond = failure.locator('[data-status-dot="failed"]');
			const node = failure.getByTestId("failure-node");

			// 正常显示：失败区域有自己的红色底，菱形是红色，和文字的颜色不同。
			expect(await neutralBackground(failure)).toBe(false);
			expect(await color(diamond)).not.toBe(await color(node));

			// 强制颜色：作者的颜色被系统颜色换掉，红色底没有了（只剩黑色的淡影），菱形和文字同色：不再靠红色分辨。
			await page.emulateMedia({ forcedColors: "active" });
			await expect.poll(() => neutralBackground(failure)).toBe(true);
			expect(await color(diamond)).toBe(await color(node));

			// 还能分辨：描边在，标题前的八边形和节点前的菱形（`StatusDot` 的 SVG 用 currentColor 画）、文字「运行失败」「失败」都在。
			await expect(failure).toHaveCSS("border-top-style", "solid");
			await expect(failure).toHaveCSS("border-top-width", "1px");
			await expect(failure.locator("svg").first()).toBeVisible();
			await expect(diamond.locator("svg")).toBeVisible();
			await expect(node).toBeVisible();
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
			// 放不下时失败摘要先让位（它被截断也可以），顶栏本身没有被撑出屏幕。
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
			// 名称被截断（有省略号），「（节点 ID）」整个收起；耗时和「×2」完整。
			const clips = row.locator("[data-truncate-clip]");
			expect(await fits(clips.nth(0))).toBe(false);
			expect(await idShown(row)).toBe(false);
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
				const nameClip = row.locator("[data-truncate-clip]").first();
				await expect(nameClip).toHaveText(name);
				await expect(row.locator("[data-truncate-wrap] > span:last-child").first()).toHaveText(
					`（${id}）`,
				);
				expect(await overlaps(row), `${name} 压在别的项上`).toEqual([]);
				expect(await typeIsWholeOrHidden(row), `${name} 的节点类型被挤成残片`).toBe(true);
				// 显示名称优先：名称和「（节点 ID）」一行放得下才一起显示，放不下时「（节点 ID）」整个收起，不留半截。
				// 只有带 always 标签、右边多占一块的那一行，名称才可能放不下。
				const truncated = !(await fits(nameClip));
				if (id !== "cleanup") expect(truncated, `${name} 被截断了`).toBe(false);
				if (truncated) expect(await idShown(row), `${name} 被截断时 ID 还在`).toBe(false);
			}
			// 这一行的 ID 最长，放不下，收起了；名称是完整的。名称完整、ID 收起时，悬停整行也显示完整的名称。
			const longRow = timeline.locator(`[data-node-row="${FAILED_NODE}"] button`);
			expect(await idShown(longRow)).toBe(false);
			expect(await fits(longRow.locator("[data-truncate-clip]").first())).toBe(true);
			await longRow.hover();
			await expect(tooltips(page)).toContainText(NODE_LABEL);
			// 读屏名称仍是完整的「名称（ID） 说明 状态」。
			await expect(longRow).toHaveAccessibleName(
				new RegExp(`^${NODE_LABEL} demo-checks/ping 失败`),
			);
		});

		test("别的节点也失败了：列出来，同一个节点在几个子流程实例里都失败时写明是哪个实例；点一下去它的尝试", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			// 主链的 verify 和子流程里的 probe 都失败（子流程先失败，它是第一个失败的节点）。
			const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
			await agent.fail(tasks.probe as AssignedTask, "TimeoutError: 延迟超过阈值");
			clock.advance(1000);
			await agent.fail(tasks.verify as AssignedTask, "AssertionError: 仍然漏拦");
			await agent.succeed(await agent.nextAssign());
			await openFailedOverview(page, clock, runId);

			const failure = area(page);
			await expect(failure.getByTestId("failure-node")).toContainText("probe");
			await expect(failure).toContainText("另有 1 个节点也失败了");
			// 别的失败节点写明所在的子流程实例；主链上的节点不写。
			const others = failure.getByRole("listitem");
			await expect(others).toHaveCount(1);
			await expect(others.first()).toHaveText("verify");
			await others.first().getByRole("button").click();
			await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
			await expect(panel(page).getByRole("tab", { name: "尝试" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
		});

		test("运行被取消、取消之前已有节点失败：失败区域的标题是「有节点失败」", async ({
			page,
			controlPlane,
			connectAgent,
			clock,
		}) => {
			const { runId, agent, cleanup } = await failedRun(controlPlane, connectAgent, clock, {
				cleanupDone: false,
			});
			const cancel = await controlPlane.fetch(`/runs/${runId}/cancel`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
				body: "{}",
			});
			expect(cancel.ok).toBe(true);
			// 清理节点（always）照常执行（docs/SEMANTICS.md §3.4），它结束后运行才以已取消结束。
			await agent.succeed(cleanup as AssignedTask);
			await openFailedOverview(page, clock, runId);

			await expect(header(page).getByTestId("run-status")).toHaveText("已取消");
			await expect(
				area(page).getByRole("heading", { name: "有节点失败", exact: true }),
			).toBeVisible();
			await expect(area(page).getByTestId("failure-node")).toContainText(FAILED_NAME);
		});
	});
}
