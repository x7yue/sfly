import {
	createEditorScenario,
	dock,
	editorDocument,
	headOf,
	inspector,
	nodeCard,
	openEditor,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 入口参数的说明（#305）：搭场景的人在参数编辑器里给入口参数和子流程入口的参数写一行说明，
// 保存后触发表单、异步任务节点的映射表单显示它；敏感参数的说明照常显示，只有值打码。

const entryParams = [
	{ name: "biz_date", type: "string", required: true },
	{ name: "steps", type: "number", default: 3 },
	{ name: "api_token", type: "string", secret: true, default: "s3cr3t" },
	{ name: "region", type: "string" },
];

const scenario = {
	...editorDocument,
	nodes: editorDocument.nodes.map((node) =>
		node.id === "entry" ? { ...node, params: entryParams } : node,
	),
};

const DRAWER = "运行 · 参数说明";

async function openScenario(
	page: Parameters<typeof openEditor>[0],
	controlPlane: Parameters<typeof publishPackage>[0],
) {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "参数说明", scenario);
	await openEditor(page, id);
	return id;
}

const paramGroup = (panel: ReturnType<typeof inspector>, name: string) =>
	panel.getByRole("group", { name: `参数 ${name}` });

test("在参数编辑器里写说明：撤销、重做；保存后触发表单和映射表单都显示它，说明在默认值前面，敏感参数的值仍然打码", async ({
	page,
	controlPlane,
}) => {
	const id = await openScenario(page, controlPlane);
	const panel = inspector(page);

	await nodeCard(page, "entry").click();
	await paramGroup(panel, "biz_date")
		.getByRole("textbox", { name: "说明" })
		.fill("  业务日期，格式 YYYY-MM-DD  ");
	await paramGroup(panel, "steps")
		.getByRole("textbox", { name: "说明" })
		.fill("每次最多处理的步数");
	const token = paramGroup(panel, "api_token").getByRole("textbox", { name: "说明" });
	await token.fill("访问令牌，向运维申请");
	await expect(page.getByText("有未保存的修改")).toBeVisible();

	// 改动可以撤销、重做（和其他编辑一样走编辑历史）。
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(token).toHaveValue("");
	await dock(page).getByRole("button", { name: "重做" }).click();
	await expect(token).toHaveValue("访问令牌，向运维申请");

	await nodeCard(page, "sub_entry").click();
	await paramGroup(panel, "date").getByRole("textbox", { name: "说明" }).fill("要处理的业务日期");

	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();

	// 保存下来的说明去掉了首尾空白；没写说明的参数没有这个字段。
	const saved = (await headOf(controlPlane, id)).document.nodes;
	expect(saved.find((n) => n.id === "entry")?.params).toEqual([
		{
			name: "biz_date",
			type: "string",
			required: true,
			secret: false,
			description: "业务日期，格式 YYYY-MM-DD",
		},
		{
			name: "steps",
			type: "number",
			default: 3,
			required: false,
			secret: false,
			description: "每次最多处理的步数",
		},
		{
			name: "api_token",
			type: "string",
			secret: true,
			default: "s3cr3t",
			required: false,
			description: "访问令牌，向运维申请",
		},
		{ name: "region", type: "string", required: false, secret: false },
	]);

	// 异步任务节点的映射表单：子流程参数的说明作为帮助文字显示。
	await nodeCard(page, "dispatch").click();
	const mapped = panel.getByRole("combobox", { name: "子流程参数 date" });
	await expect(panel.getByText("要处理的业务日期")).toBeVisible();
	await expect(mapped).toHaveAccessibleDescription("要处理的业务日期");

	// 触发表单：说明作为帮助文字，放在默认值前面；敏感参数的说明照常显示，值打码。
	await page.getByRole("button", { name: "运行", exact: true }).click();
	const drawer = page.getByRole("dialog", { name: DRAWER });
	await expect(drawer.getByRole("list", { name: "触发前检查" })).toBeVisible();
	await expect(drawer.getByLabel("biz_date")).toHaveAccessibleDescription(
		"业务日期，格式 YYYY-MM-DD",
	);
	await expect(drawer.getByLabel("steps")).toHaveAccessibleDescription("每次最多处理的步数 默认 3");
	const apiToken = drawer.getByRole("textbox", { name: /^api_token / });
	await expect(apiToken).toHaveAccessibleDescription("访问令牌，向运维申请 界面和日志中都会打码");
	await expect(apiToken).toHaveAttribute("type", "password");
	await expect(drawer.getByText("访问令牌，向运维申请")).toBeVisible();
	// 没写说明的参数照旧。
	await expect(drawer.getByLabel("region")).toHaveAccessibleDescription("");
});

test("参数说明超过 200 个字符是字段错误：显示在说明输入框下面，阻止保存，改短后消失；emoji 按一个字符计", async ({
	page,
	controlPlane,
}) => {
	await openScenario(page, controlPlane);
	const panel = inspector(page);
	await nodeCard(page, "entry").click();
	const description = paramGroup(panel, "biz_date").getByRole("textbox", { name: "说明" });

	await description.fill("😀".repeat(200));
	await description.blur();
	await expect(description).not.toHaveAttribute("aria-invalid");
	await expect(page.getByText("处字段错误")).toHaveCount(0);

	await description.fill("😀".repeat(201));
	await description.blur();
	await expect(description).toHaveAttribute("aria-invalid", "true");
	await expect(paramGroup(panel, "biz_date")).toContainText("最多 200 个字符");
	await expect(page.getByRole("button", { name: "1 处字段错误" })).toBeVisible();

	await description.fill("😀".repeat(200));
	await expect(description).not.toHaveAttribute("aria-invalid");
	await expect(page.getByText("处字段错误")).toHaveCount(0);
});

test("只有空白的说明等于没写：不算修改，写了内容再改回空白也一样", async ({
	page,
	controlPlane,
}) => {
	await openScenario(page, controlPlane);
	const panel = inspector(page);
	await nodeCard(page, "entry").click();
	const description = paramGroup(panel, "region").getByRole("textbox", { name: "说明" });

	await description.fill("   ");
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
	await expect(page.getByRole("button", { name: /保存/ })).toBeDisabled();

	await description.fill("要写的内容");
	await expect(page.getByText("有未保存的修改")).toBeVisible();
	await description.fill("  ");
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
});

test("没有说明的旧场景照旧显示：参数编辑器的说明框是空的，没有警告和未保存的提示", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "entry").click();
	await expect(
		paramGroup(inspector(page), "biz_date").getByRole("textbox", { name: "说明" }),
	).toHaveValue("");
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
});

test("版本对比列出参数说明的变化", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	const withDescription = {
		...editorDocument,
		nodes: editorDocument.nodes.map((node) =>
			node.id === "entry"
				? {
						...node,
						params: [
							{ name: "biz_date", type: "string", required: true, description: "业务日期" },
							{ name: "api_token", type: "string", secret: true, default: "s3cr3t" },
						],
					}
				: node,
		),
	};
	const res = await controlPlane.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({ base_version: 1, document: withDescription }),
	});
	expect(res.status).toBe(201);

	await page.goto(`/orchestrations/${id}/versions`);
	const changes = page.getByRole("region", { name: "节点" });
	await expect(changes).toContainText("参数 biz_date");
	await expect(changes).toContainText("必填 · 说明「业务日期」");
});
