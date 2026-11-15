// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 输出的说明（#311）：节点包开发者在输出 TypedDict 的字段上用 Annotated[类型, Doc("…")] 写，
// 元信息里是输出 schema 的 description。检查器「说明」标签页把输出列成「输出 | 说明」两列，
// 引用补全在每个输出后面写着它的说明，节点包管理页悬停输出的名字看到它。

const STATUS = "HTTP 状态码";
const BODY_FILE = "响应体保存的文件，没有响应体时为空";
const TWO_LINES = "第一行：只保存\n第二行：保存并压缩";

const documentedNodes = [
	{
		name: "fetch",
		title: "抓取",
		entry: "demo_checks.fetch:run",
		inputs: {
			type: "object",
			properties: { url: { type: "string" } },
			required: ["url"],
			order: ["url"],
		},
		outputs: {
			type: "object",
			properties: {
				status: { type: "integer", description: STATUS },
				body_file: { type: "string", description: BODY_FILE },
				report: { type: "string", description: TWO_LINES },
				elapsed: { type: "number" },
			},
		},
	},
	{
		name: "report",
		title: "汇报",
		entry: "demo_checks.report:run",
		inputs: {
			type: "object",
			properties: { message: { type: "string" } },
			order: ["message"],
		},
		outputs: { type: "object", properties: {} },
	},
];

const plainNodes = [
	{
		...documentedNodes[0],
		outputs: {
			type: "object",
			properties: { status: { type: "integer" }, body_file: { type: "string" } },
		},
	},
	documentedNodes[1],
];

const document = {
	default_agent: "agent-linux",
	nodes: [
		{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
		{
			id: "fetch",
			kind: "package",
			package: "demo-checks",
			node: "fetch",
			position: { x: 252, y: 0 },
			inputs: { url: "https://example.test/" },
		},
		{
			id: "report",
			kind: "package",
			package: "demo-checks",
			node: "report",
			position: { x: 504, y: 0 },
			inputs: { message: "完成" },
		},
	],
	edges: [
		{ from: "entry", to: "fetch", kind: "chain" },
		{ from: "fetch", to: "report", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
};

async function openScenario(page: Page, controlPlane: TestControlPlane, nodes: unknown[]) {
	await publishPackage(controlPlane, { nodes });
	const id = await createScenario(controlPlane, "抓取并汇报", document);
	await openEditor(page, id, "report");
	return inspector(page);
}

async function openOutputsTab(page: Page, controlPlane: TestControlPlane, nodes: unknown[]) {
	const panel = await openScenario(page, controlPlane, nodes);
	await nodeCard(page, "fetch").click();
	await panel.getByRole("tab", { name: "说明与指标" }).click();
	return panel;
}

test("检查器「说明」标签页：输出列成「输出 | 说明」两列，没有说明的那格留空，说明里的换行照样显示", async ({
	page,
	controlPlane,
}) => {
	const panel = await openOutputsTab(page, controlPlane, documentedNodes);
	const table = panel.getByRole("table", { name: "输出" });

	await expect(table.getByRole("columnheader")).toHaveText(["输出", "说明"]);
	// 输出的先后不是声明的顺序（节点类型存进数据库后键的顺序不保留），按名字找行。
	const row = (name: string) =>
		table.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
	await expect(row("status").getByRole("cell")).toHaveText(["status", STATUS]);
	await expect(row("body_file").getByRole("cell")).toHaveText(["body_file", BODY_FILE]);
	await expect(row("elapsed").getByRole("cell")).toHaveText(["elapsed", ""]);
	await expect(table.getByRole("row")).toHaveCount(5);

	const report = row("report").getByRole("cell").nth(1);
	await expect(report).toHaveText(/第一行：只保存\s+第二行：保存并压缩/);
	const lineHeight = await report.evaluate((el) =>
		Number.parseFloat(getComputedStyle(el).lineHeight),
	);
	expect((await report.boundingBox())?.height).toBeGreaterThan(lineHeight * 1.5);
	await expect(panel.getByText("undefined")).toHaveCount(0);
});

test("检查器「说明」标签页：不带说明的旧节点包照旧显示，说明那一列是空的，没有任何缺失提示", async ({
	page,
	controlPlane,
}) => {
	const panel = await openOutputsTab(page, controlPlane, plainNodes);
	const table = panel.getByRole("table", { name: "输出" });

	await expect(table.getByRole("columnheader")).toHaveText(["输出", "说明"]);
	await expect(table.getByRole("row")).toHaveCount(3);
	for (const name of ["status", "body_file"]) {
		const row = table.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
		await expect(row.getByRole("cell")).toHaveText([name, ""]);
	}
	await expect(panel.getByText(/缺少|没有写说明|未提供说明/)).toHaveCount(0);
});

test("检查器「说明」标签页：没有输出的节点类型写「没有输出」，不画表格", async ({
	page,
	controlPlane,
}) => {
	const panel = await openScenario(page, controlPlane, documentedNodes);
	await nodeCard(page, "report").click();
	await panel.getByRole("tab", { name: "说明与指标" }).click();

	await expect(panel.getByRole("definition").filter({ hasText: "没有输出" })).toBeVisible();
	await expect(panel.getByRole("table", { name: "输出" })).toHaveCount(0);
});

test("引用补全：每个输出选项后面写着它的说明，没有说明的输出只有类型和节点；按说明过滤不生效", async ({
	page,
	controlPlane,
}) => {
	const panel = await openScenario(page, controlPlane, documentedNodes);
	await nodeCard(page, "report").click();
	const message = panel.getByRole("combobox", { name: "输入 message" });
	await message.fill("");
	await page.keyboard.type("$");
	const options = panel
		.getByRole("listbox", { name: "可引用的值" })
		.getByRole("group", { name: "前序节点" })
		.getByRole("option");

	await expect(options).toHaveCount(4);
	await expect(options.filter({ hasText: "nodes.fetch.outputs.status" })).toHaveText(
		new RegExp(`^nodes\\.fetch\\.outputs\\.status\\s*integer · fetch\\s*${STATUS}$`),
	);
	await expect(options.filter({ hasText: "nodes.fetch.outputs.body_file" })).toHaveText(
		new RegExp(`^nodes\\.fetch\\.outputs\\.body_file\\s*string · fetch\\s*${BODY_FILE}$`),
	);
	await expect(options.filter({ hasText: "nodes.fetch.outputs.elapsed" })).toHaveText(
		/^nodes\.fetch\.outputs\.elapsed\s*number · fetch$/,
	);

	// 过滤只看引用的写法：输入说明里的字不会匹配到别的输出。
	await page.keyboard.type("HTTP");
	await expect(options).toHaveCount(0);
	for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
	await page.keyboard.type("status");
	await expect(options).toHaveCount(1);
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(message).toHaveText("${{ nodes.fetch.outputs.status }}");
});

test("引用补全：不带说明的节点包，输出选项照旧只有类型和节点", async ({ page, controlPlane }) => {
	const panel = await openScenario(page, controlPlane, plainNodes);
	await nodeCard(page, "report").click();
	await panel.getByRole("combobox", { name: "输入 message" }).fill("");
	await page.keyboard.type("$");
	const options = panel
		.getByRole("listbox", { name: "可引用的值" })
		.getByRole("group", { name: "前序节点" })
		.getByRole("option");

	await expect(options).toHaveText([
		/^nodes\.fetch\.outputs\.(status\s*integer|body_file\s*string) · fetch$/,
		/^nodes\.fetch\.outputs\.(status\s*integer|body_file\s*string) · fetch$/,
	]);
});

test("节点包管理页：悬停或聚焦输出的名字显示说明，没有说明的输出没有提示，行里的文字不变", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { nodes: documentedNodes });
	await page.goto("/packages?name=demo-checks");
	const row = page.getByRole("table", { name: "节点类型" }).getByRole("row", { name: /fetch/ });
	const outputs = row.getByRole("cell").nth(2);
	const tip = page.locator('[data-slot="tooltip-content"]');

	await expect(outputs).toHaveText(/^(\w+ · ){3}\w+$/);
	await outputs.getByText("status", { exact: true }).hover();
	await expect(tip).toHaveText(STATUS);
	await page.mouse.move(5, 5);
	await expect(tip).toHaveCount(0);

	await outputs.getByText("report", { exact: true }).hover();
	await expect(tip).toHaveText(TWO_LINES);
	await page.mouse.move(5, 5);
	await expect(tip).toHaveCount(0);

	// 没有说明的名字就是文字，和后面的「·」在同一个元素里，不能精确匹配。
	await outputs.getByText("elapsed").hover();
	await expect(tip).toHaveCount(0);

	// 键盘也拿得到：Tab 到名字上就显示。
	await outputs.getByText("body_file", { exact: true }).focus();
	await expect(tip).toHaveText(BODY_FILE);
});

test("节点包管理页：不带说明的节点包，悬停输出的名字没有提示", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane, { nodes: plainNodes });
	await page.goto("/packages?name=demo-checks");
	const row = page.getByRole("table", { name: "节点类型" }).getByRole("row", { name: /fetch/ });

	await row.getByRole("cell").nth(2).getByText("status").hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
});
