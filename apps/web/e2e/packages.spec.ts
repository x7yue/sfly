import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	createScenario,
	expectFocusVisible,
	failApi,
	publishPackage,
	scenarioUsing,
} from "./support";

// 节点包管理页（原型 #/packages）：列表 + 详情。

test("列表 + 详情：版本、发布时间、sha256、被锁定的场景数、节点类型的输入与输出", async ({
	page,
	controlPlane,
	clock,
}) => {
	await publishPackage(controlPlane, { version: "1.2.0" });
	clock.advance(3_600_000);
	await publishPackage(controlPlane, {
		version: "1.3.0",
		nodes: [
			{
				name: "http_check",
				title: "HTTP 检查",
				entry: "demo_checks.http:http_check",
				inputs: {
					type: "object",
					properties: { url: { type: "string" }, method: { type: "string" } },
					required: ["url"],
					order: ["url", "method"],
				},
				outputs: {
					type: "object",
					properties: { status: {}, body: {} },
					order: ["status", "body"],
				},
			},
		],
	});
	await publishPackage(controlPlane, { name: "alpha-tools", version: "0.1.0" });
	await createScenario(controlPlane, "a", scenarioUsing("x", "1.2.0"));
	await createScenario(controlPlane, "b", scenarioUsing("x", "1.2.0"));

	await page.goto("/packages");
	const list = page.getByRole("navigation", { name: "节点包" });
	await expect(list.getByRole("link")).toHaveText([
		/alpha-tools\s*0\.1\.0/,
		/demo-checks\s*1\.3\.0/,
	]);
	await expect(list.getByRole("link", { name: /demo-checks/ })).toContainText("2 个场景");

	await list.getByRole("link", { name: /demo-checks/ }).click();
	await expect(page).toHaveURL(/\/packages\?name=demo-checks$/);
	const detail = page.getByRole("region", { name: "demo-checks 详情" });
	await expect(detail).toContainText("1.3.0 最新");
	await expect(detail).toContainText("发布于 01-01 09:00");
	await expect(detail).toContainText("未被锁定");
	await expect(detail.getByRole("table", { name: "节点类型" }).getByRole("row")).toHaveText([
		"节点类型输入输出声明的指标标签键图表",
		"http_checkHTTP 检查url* · methodstatus · body———",
	]);
	const versions = detail.getByRole("table", { name: "版本" }).getByRole("row");
	await expect(versions.nth(1)).toContainText("1.3.0");
	await expect(versions.nth(1)).toContainText("未被锁定");
	await expect(versions.nth(2)).toContainText("01-01 08:00");
	await expect(versions.nth(2)).toContainText("被 2 个场景锁定");

	// 切换到旧版本：详情跟着换，链接可以分享。
	await detail.getByRole("link", { name: "1.2.0" }).click();
	await expect(page).toHaveURL(/\/packages\?name=demo-checks&version=1\.2\.0$/);
	await expect(detail).toContainText("被 2 个场景锁定");
	await expect(detail.getByRole("table", { name: "节点类型" }).getByRole("row")).toHaveText([
		"节点类型输入输出声明的指标标签键图表",
		"http_checkHTTP 检查url* · expectstatus———",
		"pingpinghost*alive———",
	]);
	const sha = await detail.locator("dd").first().textContent();
	expect(sha).toMatch(/^[0-9a-f]{64}$/);

	await page.reload();
	await expect(detail.getByRole("link", { name: "1.2.0" })).toHaveAttribute("aria-current");
});

test("节点类型的「标签键」列：列出每个带标签的指标和它的标签键", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane, {
		nodes: [
			{
				name: "proc_mon",
				title: "进程监控",
				entry: "demo_checks.proc:proc_mon",
				inputs: { type: "object", properties: {} },
				outputs: { type: "object", properties: {} },
				metrics: [
					{ name: "cpu", unit: "%", kind: "gauge" },
					{ name: "cpu_by_process", unit: "%", kind: "gauge", labels: ["pid", "name"] },
					{ name: "io_by_disk", unit: "B/s", kind: "counter", labels: ["disk", "direction"] },
				],
				charts: [{ title: "CPU", type: "line", metrics: ["cpu", "cpu_by_process"] }],
				primary_metric: "cpu",
			},
		],
	});
	await page.goto("/packages?name=demo-checks");
	const table = page
		.getByRole("region", { name: "demo-checks 详情" })
		.getByRole("table", { name: "节点类型" });
	await expect(table.getByRole("columnheader")).toHaveText([
		"节点类型",
		"输入",
		"输出",
		"声明的指标",
		"标签键",
		"图表",
	]);
	const cells = table.getByRole("row", { name: /proc_mon/ }).getByRole("cell");
	await expect(cells.nth(4).getByRole("listitem")).toHaveText([
		"cpu_by_process：pid · name",
		"io_by_disk：disk · direction",
	]);
	// 带标签的累计值也默认画折线。
	await expect(cells.nth(5)).toHaveText("2 张 · 主指标 cpuCPU · io_by_disk 默认");
	await expect(cells.nth(5).getByTitle("折线：io_by_disk")).toBeVisible();
});

test("还没有节点包时显示空状态和发布命令，链接到开发文档", async ({ page }) => {
	await page.goto("/packages");
	const empty = page.getByRole("region", { name: "还没有发布节点包" });
	await expect(empty).toContainText("uv run sfly publish");

	await empty.getByRole("link", { name: "从零开始开发节点包" }).click();
	await expect(page).toHaveURL(/\/docs\/quickstart$/);
	await expect(page.getByRole("article", { name: "快速开始" })).toBeVisible();

	await page.goBack();
	await page
		.getByRole("region", { name: "还没有发布节点包" })
		.getByRole("link", { name: "发布节点包" })
		.click();
	await expect(page).toHaveURL(/\/docs\/publish$/);
	await expect(page.getByRole("article", { name: "发布" })).toBeVisible();
});

test("加载失败时显示错误，可以重试", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	const outage = await failApi(page, "/packages");
	await page.goto("/packages");
	await expect(page.getByRole("alert")).toContainText("无法加载节点包");
	await outage.restore();
	await page.getByRole("button", { name: "重试" }).click();
	await expect(page.getByRole("navigation", { name: "节点包" })).toContainText("demo-checks");
});

test("列表页的键盘：J / K 在节点包之间移动，Enter 显示详情；没有搜索框，/ 不起作用", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { name: "alpha-tools", version: "0.1.0" });
	await publishPackage(controlPlane, { version: "1.2.0" });
	await page.goto("/packages");
	const list = page.getByRole("navigation", { name: "节点包" });
	const alpha = list.getByRole("link", { name: /alpha-tools/ });
	const demo = list.getByRole("link", { name: /demo-checks/ });
	await expect(alpha).toBeVisible();

	await page.keyboard.press("/");
	await expect(page.locator("input:focus")).toHaveCount(0);
	await page.keyboard.press("j");
	await expectFocusVisible(alpha);
	await page.keyboard.press("j");
	await expectFocusVisible(demo);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/packages\?name=demo-checks$/);
	await expect(page.getByRole("region", { name: "demo-checks 详情" })).toBeVisible();
	await expectFocusVisible(demo);
	await page.keyboard.press("k");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/packages\?name=alpha-tools$/);
	await expect(page.getByRole("region", { name: "alpha-tools 详情" })).toBeVisible();
});

test("选中的包与选中的版本都是中性高亮加左侧白条，悬停时仍是选中的样子", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { version: "1.2.0" });
	await publishPackage(controlPlane, { version: "1.3.0" });
	await page.goto("/packages?name=demo-checks");
	const detail = page.getByRole("region", { name: "demo-checks 详情" });
	const item = page.getByRole("navigation", { name: "节点包" }).getByRole("link", {
		name: /demo-checks/,
	});
	const row = detail.getByRole("table", { name: "版本" }).locator('tr[data-state="selected"]');
	await expect(row).toHaveCount(1);
	const look = (el: Locator) =>
		el.evaluate((node) => {
			const style = getComputedStyle(node);
			return { background: style.backgroundColor, shadow: style.boxShadow };
		});
	const selected = await look(item);
	expect(selected.shadow).not.toBe("none");
	expect(await look(row)).toEqual(selected);
	await row.hover();
	expect(await look(row)).toEqual(selected);
	await item.hover();
	expect(await look(item)).toEqual(selected);
});

test("包列表宽 22%（夹在 220 到 300px 之间）并吸在页面顶部；输入输出折行时分隔点只在行尾，不会落在行首", async ({
	page,
	controlPlane,
}) => {
	const inputs = [
		"ready_file",
		"report_file",
		"seconds",
		"artifacts",
		"release_file",
		"request_timeout_ms",
		"response_body_file",
		"queue_timeout",
		"retry_backoff_ms",
		"max_attempts",
	];
	await publishPackage(controlPlane, {
		nodes: Array.from({ length: 14 }, (_, i) => ({
			name: `wait_cancel_${i}`,
			title: "等待取消",
			entry: `demo_checks.wait:wait_cancel_${i}`,
			inputs: {
				type: "object",
				properties: Object.fromEntries(inputs.map((key) => [key, { type: "string" }])),
				required: ["ready_file", "report_file"],
				order: inputs,
			},
			outputs: { type: "object", properties: { status: {}, body: {} }, order: ["status", "body"] },
		})),
	});
	await publishPackage(controlPlane, { name: "alpha-tools", version: "0.1.0" });

	const listPanel = page
		.getByRole("navigation", { name: "节点包" })
		.locator("xpath=ancestor::section[1]");
	const main = page.locator("#main");
	const widths: number[] = [];
	for (const width of [1280, 1920]) {
		await page.setViewportSize({ width, height: 420 });
		await page.goto("/packages?name=demo-checks");
		await expect(page.getByRole("table", { name: "节点类型" })).toBeVisible();
		widths.push(Math.round((await listPanel.boundingBox())?.width ?? 0));
	}
	expect(widths).toEqual([220, 300]);

	await page.setViewportSize({ width: 1280, height: 420 });
	await page.goto("/packages?name=demo-checks");
	await expect(page.getByRole("table", { name: "节点类型" })).toBeVisible();
	await main.evaluate((el) => el.scrollTo(0, 400));
	expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
	const [mainTop, listTop] = await Promise.all([
		main.evaluate((el) => el.getBoundingClientRect().top),
		listPanel.evaluate((el) => el.getBoundingClientRect().top),
	]);
	expect(Math.round(listTop - mainTop)).toBe(20);

	const lines = await page
		.getByRole("table", { name: "节点类型" })
		.getByRole("row")
		.nth(1)
		.getByRole("cell")
		.nth(1)
		.locator("span.whitespace-nowrap")
		.evaluateAll((items) =>
			items.map((item) => {
				const texts: Text[] = [];
				const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
				const lineOf = (node: Text | undefined, offset: number) => {
					if (!node) return Number.NaN;
					const range = document.createRange();
					range.setStart(node, offset);
					range.setEnd(node, offset + 1);
					return Math.round(range.getBoundingClientRect().top);
				};
				const last = texts.at(-1);
				return {
					first: lineOf(texts[0], 0),
					last: lineOf(last, (last?.length ?? 1) - 1),
					text: item.textContent ?? "",
				};
			}),
		);
	expect(lines.length).toBe(inputs.length);
	expect(new Set(lines.map((l) => l.first)).size).toBeGreaterThan(1);
	expect(lines.every((l) => l.first === l.last)).toBe(true);
	expect(lines.slice(0, -1).every((l) => l.text.endsWith(" ·"))).toBe(true);
});
