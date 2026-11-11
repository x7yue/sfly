// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import { headOf, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 「Agent」类型的输入（#197）：节点开发者用 sfly.AgentName 标注的参数在检查器里是 Agent 下拉框，
// 列出已注册的 Agent 及在线状态；也可以用「插入引用」改为引用入口参数。选的不是已注册的 Agent 时字段下有警告。

const inspector = (page: Page) => page.getByRole("complementary", { name: "检查器" });

/** demo-checks 的节点类型：probe 有一个输出，clean 的 source 是「Agent」类型（sfly build 的标记）。 */
const agentNodes = [
	{
		name: "probe",
		title: "探测",
		entry: "demo_checks.http:probe",
		inputs: { type: "object", properties: {} },
		outputs: { type: "object", properties: { host: { type: "string" } } },
	},
	{
		name: "clean",
		title: "清洗",
		entry: "demo_checks.http:clean",
		inputs: {
			type: "object",
			properties: { source: { type: "string", "x-sfly-type": "agent" } },
			required: ["source"],
		},
		outputs: { type: "object", properties: {} },
	},
];

const agentDocument = {
	default_agent: "runner",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			position: { x: 0, y: 0 },
			params: [{ name: "src", type: "string" }],
		},
		{
			id: "probe",
			kind: "package",
			package: "demo-checks",
			node: "probe",
			position: { x: 252, y: 0 },
			inputs: {},
		},
		{
			id: "clean",
			kind: "package",
			package: "demo-checks",
			node: "clean",
			position: { x: 504, y: 0 },
			inputs: { source: "ghost" },
		},
	],
	edges: [
		{ from: "entry", to: "probe", kind: "chain" },
		{ from: "probe", to: "clean", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
};

test("检查器：Agent 类型的参数是带在线状态的 Agent 下拉框，未注册时警告，可以改为引用入口参数", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "runner" });
	const source = await connectAgent({ name: "source-a" });
	await source.disconnect();
	await publishPackage(controlPlane, { nodes: agentNodes });
	const id = await createScenario(controlPlane, "清洗日志", agentDocument);

	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "clean").click();
	const panel = inspector(page);
	const select = panel.getByRole("combobox", { name: "输入 source" });
	const warning = "节点 clean 的输入 source 选择的 Agent ghost 还没有注册过";

	// 已注册的 Agent（含离线的）带在线状态；当前值不是已注册的 Agent 时标出「未注册」，字段下有警告。
	await expect(select).toHaveValue("ghost");
	await expect(select.getByRole("option")).toHaveText([
		"（必填）",
		"runner · 在线",
		"source-a · 离线",
		"ghost（未注册）",
	]);
	await expect(panel.getByText(warning)).toBeVisible();

	// 选一台已注册的 Agent（不在线也可以）：警告消失。
	await select.selectOption("source-a");
	await expect(panel.getByText(warning)).toHaveCount(0);

	// 改为引用：只能选入口参数，选中后显示引用标签；点 × 回到下拉框。
	const list = panel.getByRole("listbox", { name: "可引用的值" });
	await panel.getByRole("button", { name: "在 source 中插入引用" }).click();
	await expect(list.getByRole("group")).toHaveText([/^入口参数/]);
	await list.getByRole("option", { name: /params\.src/ }).click();
	const chip = panel.getByRole("group", { name: "输入 source" });
	await expect(chip).toHaveText("${{ params.src }}");

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.document.nodes.find((n) => n.id === "clean")?.inputs).toEqual({
		source: "${{ params.src }}",
	});

	await chip.getByRole("button", { name: "移除 source 的引用" }).click();
	await expect(select).toBeFocused();
	await expect(select).toHaveValue("");
});
