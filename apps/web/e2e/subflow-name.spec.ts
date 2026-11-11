import type { Page } from "@playwright/test";
import {
	addMenu,
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

// 子流程名称（#84，SEMANTICS §1.2）：新建子流程入口时填写，检查器里修改，名称为空或重复时警告；
// 没有名称字段的旧版本以节点 ID 作为名称。

const region = (page: Page, name: string) => page.getByRole("region", { name: `子流程 ${name}` });

test("新建子流程入口时必须填写不重复的名称；子流程区域标题显示名称", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	// 旧版本没有名称：以节点 ID 作为名称。
	await expect(region(page, "sub_entry")).toBeVisible();

	await dock(page).getByRole("button", { name: "添加节点" }).click();
	await addMenu(page)
		.getByRole("option", { name: /子流程入口/ })
		.click();
	const name = addMenu(page).getByRole("textbox", { name: "子流程名称" });
	await expect(name).toBeFocused();
	const create = addMenu(page).getByRole("button", { name: "新建子流程" });

	await create.click();
	await expect(addMenu(page)).toContainText("请填写子流程名称");
	await expect(nodeCard(page, "subflow_1")).toHaveCount(0);

	await name.fill("sub_entry");
	await expect(addMenu(page)).toContainText("子流程入口节点 sub_entry 已使用名称「sub_entry」");
	await name.press("Enter");
	await expect(nodeCard(page, "subflow_1")).toHaveCount(0);

	await name.fill("压测监控");
	await name.press("Enter");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(nodeCard(page, "subflow_1")).toBeVisible();
	await expect(nodeCard(page, "subflow_1")).toHaveAttribute("aria-pressed", "true");
	await expect(region(page, "压测监控")).toContainText("压测监控");
	await expect(inspector(page).getByRole("textbox", { name: "子流程名称" })).toHaveValue(
		"压测监控",
	);
	await expect(inspector(page).getByRole("heading", { name: "压测监控" })).toBeVisible();
});

test("检查器修改子流程名称：区域标题跟着变；名称为空或重复时警告，保存后随版本保存", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await expect(page.getByRole("button", { name: "检查通过" })).toBeVisible();

	await nodeCard(page, "sub_entry").click();
	const field = inspector(page).getByRole("textbox", { name: "子流程名称" });
	await expect(field).toHaveValue("sub_entry");
	await field.fill("夜间对账");
	await expect(region(page, "夜间对账")).toBeVisible();
	await expect(region(page, "sub_entry")).toHaveCount(0);

	await field.fill("");
	await expect(inspector(page)).toContainText("子流程入口节点 sub_entry 没有填写名称");
	await expect(page.getByRole("button", { name: "1 条警告" })).toBeVisible();
	await expect(nodeCard(page, "sub_entry")).toContainText("1 警告");

	await field.fill("夜间对账");
	await expect(page.getByRole("button", { name: "检查通过" })).toBeVisible();
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.document.nodes.find((n) => n.id === "sub_entry")).toMatchObject({
		name: "夜间对账",
	});
});

test("两个子流程重名时，两个子流程入口上都有警告", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	const ping = (id: string, x: number, y: number) => ({
		id,
		kind: "package",
		package: "demo-checks",
		node: "ping",
		position: { x, y },
		inputs: { host: "h" },
	});
	const id = await createScenario(controlPlane, "重名", {
		default_agent: "agent-linux",
		nodes: [
			{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
			{ id: "spawn1", kind: "async", position: { x: 252, y: 0 }, params: {} },
			{ id: "spawn2", kind: "async", position: { x: 504, y: 0 }, params: {} },
			{ id: "sub_a", kind: "subflow_entry", name: "监控", position: { x: 408, y: 230 } },
			ping("ping_a", 660, 230),
			{ id: "sub_b", kind: "subflow_entry", name: "监控", position: { x: 660, y: 460 } },
			ping("ping_b", 912, 460),
		],
		edges: [
			{ from: "entry", to: "spawn1", kind: "chain" },
			{ from: "spawn1", to: "spawn2", kind: "chain" },
			{ from: "spawn1", to: "sub_a", kind: "dispatch" },
			{ from: "spawn2", to: "sub_b", kind: "dispatch" },
			{ from: "sub_a", to: "ping_a", kind: "chain" },
			{ from: "sub_b", to: "ping_b", kind: "chain" },
		],
		packages: { "demo-checks": "1.2.0" },
	});
	await page.goto(`/orchestrations/${id}`);
	await expect(nodeCard(page, "ping_b")).toBeVisible();
	await expect(page.getByRole("button", { name: "2 条警告" })).toBeVisible();
	await expect(region(page, "监控")).toHaveCount(2);
	await expect(nodeCard(page, "sub_a")).toContainText("1 警告");
	await nodeCard(page, "sub_b").click();
	await expect(inspector(page)).toContainText(
		"子流程名称「监控」重复（子流程入口节点 sub_a、sub_b）",
	);

	await inspector(page).getByRole("textbox", { name: "子流程名称" }).fill("压测");
	await expect(page.getByRole("button", { name: "检查通过" })).toBeVisible();
});

test("版本对比显示子流程名称的变化：旧版本以节点 ID 作为名称", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	const res = await controlPlane.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({
			base_version: 1,
			document: {
				...editorDocument,
				nodes: editorDocument.nodes.map((n) =>
					n.id === "sub_entry" ? { ...n, name: "夜间对账" } : n,
				),
			},
		}),
	});
	expect(res.status).toBe(201);
	await page.goto(`/orchestrations/${id}/versions`);
	const diff = page.getByRole("region", { name: "差异" });
	await expect(diff).toContainText("sub_entry（子流程入口）");
	await expect(diff).toContainText("名称 sub_entry → 夜间对账");
	await expect(
		page
			.getByRole("region", { name: "版本 1（只读）" })
			.getByRole("region", { name: "子流程 sub_entry" }),
	).toBeVisible();
	await expect(
		page
			.getByRole("region", { name: "版本 2（只读）" })
			.getByRole("region", { name: "子流程 夜间对账" }),
	).toBeVisible();
});
