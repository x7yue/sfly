import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 输入的说明（#303）：节点包开发者用 Annotated[类型, Doc("…")] 写，元信息里是输入 schema 的 description。
// 检查器「参数」标签页在每个输入框下面显示它；节点包管理页悬停输入的名字看到它。

const RELEASE_FILE = "要上传的发布包，路径相对于 Agent 的工作目录；目录会先打成 zip 再上传";
const TIMEOUT = "单次请求的超时，单位毫秒";
const MODE = "fast 跳过签名校验，safe 逐个校验";
const TWO_LINES = "第一行：只上传\n第二行：上传并通知";

const documentedNodes = [
	{
		name: "upload",
		title: "上传",
		entry: "demo_checks.upload:run",
		inputs: {
			type: "object",
			properties: {
				release_file: { type: "string", description: RELEASE_FILE },
				request_timeout_ms: { type: "integer", description: TIMEOUT, default: 3000 },
				mode: { enum: ["fast", "safe"], description: MODE },
				steps: { type: "string", description: TWO_LINES },
				retries: { type: "integer", default: 3 },
			},
			required: ["release_file"],
			order: ["release_file", "request_timeout_ms", "mode", "steps", "retries"],
		},
		outputs: { type: "object", properties: { url: {} }, order: ["url"] },
	},
];

const plainNodes = [
	{
		...documentedNodes[0],
		inputs: {
			type: "object",
			properties: { release_file: { type: "string" }, mode: { enum: ["fast", "safe"] } },
			required: ["release_file"],
			order: ["release_file", "mode"],
		},
	},
];

const document = {
	default_agent: "agent-linux",
	nodes: [
		{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
		{
			id: "upload",
			kind: "package",
			package: "demo-checks",
			node: "upload",
			position: { x: 252, y: 0 },
			inputs: { release_file: "a.zip" },
		},
	],
	edges: [{ from: "entry", to: "upload", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
};

async function openUpload(page: Page, controlPlane: TestControlPlane, nodes: unknown[]) {
	await publishPackage(controlPlane, { nodes });
	const id = await createScenario(controlPlane, "上传发布", document);
	await openEditor(page, id, "upload");
	await nodeCard(page, "upload").click();
	return inspector(page);
}

test("检查器「参数」标签页：每个输入框下面显示完整说明，和输入框关联；没有说明的输入照旧", async ({
	page,
	controlPlane,
}) => {
	const panel = await openUpload(page, controlPlane, documentedNodes);

	// 字符串输入是 combobox（可以插入引用），数字输入是 textbox。
	for (const [role, input, description] of [
		["combobox", "release_file", RELEASE_FILE],
		["textbox", "request_timeout_ms", TIMEOUT],
	] as const) {
		const field = panel.getByRole(role, { name: `输入 ${input}` });
		await expect(panel.getByText(description, { exact: true })).toBeVisible();
		await expect(field).toHaveAccessibleDescription(description);
	}
	await expect(panel.getByText(MODE, { exact: true })).toBeVisible();

	// 参数的标签仍然是参数名，说明是帮助文字；有默认值时默认值还在输入框的占位里。
	await expect(panel.locator("label", { hasText: "release_file" })).toContainText("release_file*");
	await expect(panel.getByRole("textbox", { name: "输入 request_timeout_ms" })).toHaveAttribute(
		"placeholder",
		"默认 3000",
	);

	// 没有写说明的输入：下面没有帮助文字。
	await expect(panel.getByRole("textbox", { name: "输入 retries" })).toHaveAccessibleDescription(
		"",
	);
	await expect(panel.getByText("undefined")).toHaveCount(0);
});

test("说明里的换行照样显示成两行", async ({ page, controlPlane }) => {
	const panel = await openUpload(page, controlPlane, documentedNodes);
	const steps = panel.getByRole("combobox", { name: "输入 steps" });
	const help = panel.locator("p", { hasText: "第一行：只上传" });

	await expect(steps).toHaveAccessibleDescription(/第一行：只上传\s+第二行：上传并通知/);
	const lineHeight = await help.evaluate((el) =>
		Number.parseFloat(getComputedStyle(el).lineHeight),
	);
	expect((await help.boundingBox())?.height).toBeGreaterThan(lineHeight * 1.5);
});

test("不带说明的节点包：参数标签页没有帮助文字，节点包管理页悬停输入的名字也没有提示", async ({
	page,
	controlPlane,
}) => {
	const panel = await openUpload(page, controlPlane, plainNodes);
	const field = panel.getByRole("combobox", { name: "输入 release_file" });
	await expect(field).toBeVisible();
	await expect(field).toHaveAccessibleDescription("");

	await page.goto("/packages?name=demo-checks");
	const row = page.getByRole("table", { name: "节点类型" }).getByRole("row", { name: /upload/ });
	await row.getByText("release_file").hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
});

test("节点包管理页：悬停或聚焦输入的名字显示说明，没有说明的输入没有提示，行里的文字不变", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, { nodes: documentedNodes });
	await page.goto("/packages?name=demo-checks");
	const table = page.getByRole("table", { name: "节点类型" });
	const row = table.getByRole("row", { name: /upload/ });
	const tip = page.locator('[data-slot="tooltip-content"]');

	await expect(row.getByRole("cell").nth(1)).toHaveText(
		"release_file* · request_timeout_ms · mode · steps · retries",
	);

	await row.getByText("request_timeout_ms").hover();
	await expect(tip).toHaveText(TIMEOUT);
	await page.mouse.move(5, 5);
	await expect(tip).toHaveCount(0);

	// 必填输入的名字后面带着星号，说明还是整段显示。
	await row.getByText("release_file").hover();
	await expect(tip).toHaveText(RELEASE_FILE);
	await page.mouse.move(5, 5);
	await expect(tip).toHaveCount(0);

	await row.getByText("retries").hover();
	await expect(tip).toHaveCount(0);

	// 键盘也拿得到：Tab 到名字上就显示。
	await row.getByText("mode", { exact: true }).focus();
	await expect(tip).toHaveText(MODE);
});
