import {
	addMenu,
	createEditorScenario,
	dock,
	inspector,
	nodeCard,
	openEditor,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 节点类型的说明（#304）：节点函数的文档字符串写进元信息，「添加节点」菜单和节点包管理页在标题下面显示第一段，
// 检查器「说明」页按纯文本显示全文；没有说明的节点类型照旧。

const FIRST_PARAGRAPH = "请求一个地址并检查状态码。 折行只是写代码时换了一行。";
const DESCRIPTION = [
	"请求一个地址并检查状态码。",
	"折行只是写代码时换了一行。",
	"",
	"失败时重试 3 次，每次间隔 1 秒。",
	"",
	"**不渲染**：星号原样显示。",
].join("\n");

const nodes = [
	{
		name: "http_check",
		title: "HTTP 检查",
		description: DESCRIPTION,
		entry: "demo_checks.http:http_check",
		inputs: {
			type: "object",
			properties: { url: { type: "string" }, expect: { type: "integer", default: 200 } },
			required: ["url"],
		},
		outputs: { type: "object", properties: { status: { type: "integer" } } },
	},
	{
		name: "ping",
		title: "ping",
		entry: "demo_checks.http:ping_host",
		inputs: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
		outputs: { type: "object", properties: { alive: {} } },
	},
];

const GENERIC = "在 Agent 上执行节点包里的函数。";

test("「添加节点」菜单：有说明的节点类型在标题下面显示第一段，没有说明的照旧", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { nodes });
	const id = await createScenario(controlPlane, "日终数据处理", {
		default_agent: "agent-linux",
		nodes: [{ id: "entry", kind: "entry", position: { x: 0, y: 0 } }],
		edges: [],
		packages: { "demo-checks": "1.2.0" },
	});
	await openEditor(page, id, "entry");

	await dock(page).getByRole("button", { name: "添加节点" }).click();
	const menu = addMenu(page);
	const documented = menu.getByRole("option", { name: /HTTP 检查/ });
	await expect(documented).toContainText("HTTP 检查");
	await expect(documented).toContainText(FIRST_PARAGRAPH);
	await expect(documented).not.toContainText("失败时重试");
	await expect(documented).not.toContainText("不渲染");

	// 没有说明的节点类型：只有标题和节点名。
	await expect(menu.getByRole("option", { name: /^ping/ })).toHaveText(/^ping\s*ping$/);
});

test("检查器「说明」页：按纯文本显示节点类型说明的全文，没有说明时仍是通用的那句", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { nodes });
	const id = await createScenario(controlPlane, "日终数据处理", {
		default_agent: "agent-linux",
		nodes: [
			{ id: "entry", kind: "entry", position: { x: 0, y: 0 } },
			{
				id: "fetch",
				kind: "package",
				package: "demo-checks",
				node: "http_check",
				position: { x: 252, y: 0 },
				inputs: { url: "https://example.test/snap" },
			},
			{
				id: "ping",
				kind: "package",
				package: "demo-checks",
				node: "ping",
				position: { x: 504, y: 0 },
				inputs: { host: "h" },
			},
		],
		edges: [
			{ from: "entry", to: "fetch", kind: "chain" },
			{ from: "fetch", to: "ping", kind: "chain" },
		],
		packages: { "demo-checks": "1.2.0" },
	});
	await openEditor(page, id, "ping");
	const panel = inspector(page);

	await nodeCard(page, "fetch").click();
	await panel.getByRole("tab", { name: /说明/ }).click();
	const text = panel.getByText("请求一个地址并检查状态码。");
	// 全文，段落之间的空行保留；Markdown 记号原样显示，不渲染成粗体。
	await expect(text).toBeVisible();
	expect(await text.innerText()).toBe(DESCRIPTION);
	await expect(panel.locator("strong")).toHaveCount(0);
	await expect(panel.getByText(GENERIC)).toHaveCount(0);

	await nodeCard(page, "ping").click();
	await panel.getByRole("tab", { name: /说明/ }).click();
	await expect(panel.getByText(GENERIC)).toBeVisible();
});

test("节点包管理页：节点类型的标题下面显示说明的第一段，没有说明的节点类型照旧", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { nodes });

	await page.goto("/packages?name=demo-checks");
	const table = page
		.getByRole("region", { name: "demo-checks 详情" })
		.getByRole("table", { name: "节点类型" });
	const documented = table.getByRole("row", { name: /http_check/ });
	await expect(documented).toContainText("HTTP 检查");
	await expect(documented).toContainText(FIRST_PARAGRAPH);
	await expect(documented).not.toContainText("失败时重试");

	await expect(table.getByRole("row", { name: /ping/ }).getByRole("cell").first()).toHaveText(
		/^pingping$/,
	);
});

test("不带说明的旧版本节点包：菜单、检查器、节点包管理页都照旧", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await dock(page).getByRole("button", { name: "添加节点" }).click();
	await expect(addMenu(page).getByRole("option", { name: /HTTP 检查/ })).toHaveText(
		/^HTTP 检查\s*http_check$/,
	);
	await page.keyboard.press("Escape");

	await nodeCard(page, "fetch").click();
	await inspector(page).getByRole("tab", { name: /说明/ }).click();
	await expect(inspector(page).getByText(GENERIC)).toBeVisible();

	await page.goto("/packages?name=demo-checks");
	await expect(
		page
			.getByRole("region", { name: "demo-checks 详情" })
			.getByRole("table", { name: "节点类型" })
			.getByRole("row", { name: /http_check/ })
			.getByRole("cell")
			.first(),
	).toHaveText(/^http_checkHTTP 检查$/);
});

test("开发版本（Agent 上报的元信息）的节点类型也在菜单里显示说明", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const metadata = {
		name: "demo-dev",
		version: "dev",
		requires_python: ">=3.10",
		nodes: [
			{
				name: "probe",
				title: "探测",
				description: "探测目标是否可达。\n\n只在联调时用。",
				entry: "demo_dev:probe",
				inputs: { type: "object", properties: {} },
				outputs: { type: "object", properties: {} },
			},
		],
	};
	await connectAgent({
		name: "agent-dev",
		devPackages: [
			{ name: "demo-dev", source: "/home/dev/demo-dev", metadataJson: JSON.stringify(metadata) },
		],
	});
	const id = await createScenario(controlPlane, "联调", {
		default_agent: "agent-dev",
		nodes: [{ id: "entry", kind: "entry", position: { x: 0, y: 0 } }],
		edges: [],
		packages: {},
	});
	await openEditor(page, id, "entry");

	await dock(page).getByRole("button", { name: "添加节点" }).click();
	const option = addMenu(page).getByRole("option", { name: /探测/ });
	await expect(option).toContainText("探测目标是否可达。");
	await expect(option).not.toContainText("只在联调时用");
});
