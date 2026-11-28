// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import { actAs } from "../../server/test/support/credentials.js";
import { addMenu, headOf, inspector, nodeCard, nodeMenu, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 「运行状态」类型的输入（#452，ADR 0031）：节点开发者用 sfly.RunState 标注的参数，在检查器里只能接 ${{ run.state }}。
// 从添加菜单加这样的节点，输入已经预填好；没接时字段下和保存的警告里写明该填什么，点「接入运行状态」按钮填上。
// 用的是还没有锁定在场景里的已发布节点包：选中节点时才读它的版本元信息（添加菜单的摘要里没有输入 schema）。

const RUN_STATE = { type: "object", "x-sfly-type": "run_state" };

/** reports 的节点类型：run_summary 的 run 是「运行状态」类型的必填输入，note 是普通的可选输入。 */
const reportNodes = [
	{
		name: "run_summary",
		title: "运行汇总",
		entry: "reports:run_summary",
		inputs: {
			type: "object",
			properties: { run: RUN_STATE, note: { type: "string" } },
			required: ["run"],
		},
		outputs: { type: "object", properties: {} },
	},
];

/** 主链 entry → ping（demo-checks）；reports 没有锁定在场景里。 */
const document = {
	default_agent: "runner",
	nodes: [
		{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
		{
			id: "ping",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			position: { x: 300, y: 0 },
			inputs: { host: "h" },
		},
	],
	edges: [{ from: "entry", to: "ping", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
};

/** 在 ping 后面加「运行汇总」；返回检查器。 */
async function addRunSummary(page: Page) {
	await nodeCard(page, "ping").click({ button: "right" });
	await nodeMenu(page).getByRole("menuitem", { name: "在后面添加节点" }).click();
	await addMenu(page)
		.getByRole("option", { name: /运行汇总/ })
		.click();
	await expect(nodeCard(page, "run_summary_1")).toBeVisible();
	await expect(nodeCard(page, "run_summary_1")).toHaveAttribute("aria-pressed", "true");
	return inspector(page);
}

const warning = "节点 run_summary_1 的输入 run 要接这次运行的状态，填 ${{ run.state }}";

test.beforeEach(async ({ controlPlane, connectAgent }) => {
	await connectAgent({ name: "runner" });
	await publishPackage(controlPlane);
	await publishPackage(controlPlane, { name: "reports", version: "1.0.0", nodes: reportNodes });
});

test("从添加菜单加一个有「运行状态」输入的节点：输入已经是 ${{ run.state }}，保存后文档里就是它", async ({
	page,
	controlPlane,
}) => {
	const id = await createScenario(controlPlane, "按结果通知", document);
	await openEditor(page, id, "ping");

	const panel = await addRunSummary(page);
	// 检查器里是引用标签，不是「接入运行状态」按钮；没有警告。
	await expect(panel.getByRole("group", { name: "输入 run" })).toHaveText("${{ run.state }}");
	await expect(panel.getByRole("button", { name: "在 run 中接入运行状态" })).toHaveCount(0);
	await expect(panel.getByText("要接这次运行的状态")).toHaveCount(0);

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	await expect(page.getByText(/条警告/)).toHaveCount(0);
	const head = await headOf(controlPlane, id);
	expect(head.document.nodes.find((n) => n.id === "run_summary_1")).toMatchObject({
		kind: "package",
		package: "reports",
		node: "run_summary",
		inputs: { run: "${{ run.state }}" },
	});
	expect(head.document).toMatchObject({ packages: { "demo-checks": "1.2.0", reports: "1.0.0" } });
});

test("「运行状态」输入没接：字段下和保存的警告写明该填什么；点「接入运行状态」填上，警告消失", async ({
	page,
	controlPlane,
}) => {
	const id = await createScenario(controlPlane, "按结果通知", document);
	await openEditor(page, id, "ping");

	const panel = await addRunSummary(page);
	const chip = panel.getByRole("group", { name: "输入 run" });
	const connect = panel.getByRole("button", { name: "在 run 中接入运行状态" });

	// 点 × 取消接入：回到「接入运行状态」按钮，必填的输入没接，字段下写明该填什么。
	await chip.getByRole("button", { name: "移除 run 的引用" }).click();
	await expect(connect).toBeVisible();
	await expect(connect).toBeFocused();
	await expect(panel.getByText(warning).first()).toBeVisible();

	// 保存时同一条警告：保存成功，提示有一条阻断触发的警告；保存下来的文档里这个输入没有值。
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	await expect(page.getByText("1 条警告，触发运行前需要处理")).toBeVisible();
	const unconnected = await headOf(controlPlane, id);
	expect(unconnected.document.nodes.find((n) => n.id === "run_summary_1")?.inputs).toEqual({});
	// 这份文档触发时被预检拦下，警告里写着该填什么。
	const trigger = await controlPlane.fetch(`/orchestrations/${id}/runs`, {
		method: "POST",
		headers: { "content-type": "application/json", ...actAs("tester") },
		body: JSON.stringify({ params: {} }),
	});
	expect(trigger.status).toBe(400);
	const rejected = (await trigger.json()) as {
		error: { details: Array<{ code: string; message: string }> };
	};
	expect(rejected.error.details).toMatchObject([
		{ code: "input_run_state_missing", message: warning },
	]);

	// 点「接入运行状态」：填上引用标签，警告消失，保存后文档里是 ${{ run.state }}。
	await connect.click();
	await expect(chip).toHaveText("${{ run.state }}");
	await expect(panel.getByText("要接这次运行的状态")).toHaveCount(0);
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 3")).toBeVisible();
	const connected = await headOf(controlPlane, id);
	expect(connected.document.nodes.find((n) => n.id === "run_summary_1")?.inputs).toEqual({
		run: "${{ run.state }}",
	});
});
