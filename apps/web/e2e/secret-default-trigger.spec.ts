// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// secret 参数有默认值时，从界面（运行抽屉、预设表单）触发（#467）：控制台读不到默认值，表单里不预填；
// 没有动过的 secret 参数不放进触发的参数，由控制面按默认值填入，节点收到的是默认值，布尔参数也一样；
// 动过的（填了新值、选了开或关）才传。

const SECRET = "test-secret-value";
const PIN = 7345921;

const ECHO_NODE = {
	name: "echo_all",
	title: "回显",
	entry: "demo_checks.http:echo_all",
	inputs: {
		type: "object",
		properties: {
			token: { type: "string" },
			pin: { type: "number" },
			flag: { type: "boolean" },
			region: { type: "string" },
		},
		required: ["token", "pin", "flag", "region"],
	},
	outputs: { type: "object", properties: {} },
};

/** 入口参数：secret 的字符串、数字、布尔（都有默认值）和一个普通参数；每个都原样传给节点。 */
const SCENARIO = {
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "api_token", type: "string", secret: true, default: SECRET },
				{ name: "pin", type: "number", secret: true, default: PIN },
				{ name: "flag", type: "boolean", secret: true, default: true },
				{ name: "region", type: "string", default: "cn-east" },
			],
		},
		{
			id: "echo",
			kind: "package",
			package: "demo-checks",
			node: "echo_all",
			inputs: {
				token: "${{ params.api_token }}",
				pin: "${{ params.pin }}",
				flag: "${{ params.flag }}",
				region: "${{ params.region }}",
			},
		},
	],
	edges: [{ from: "entry", to: "echo", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
};

async function openDrawer(page: Page) {
	await page.goto("/orchestrations");
	await page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "运行", exact: true })
		.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(drawer.getByRole("list", { name: "触发前检查" })).toBeVisible();
	return drawer;
}

test("从运行抽屉触发，不动 secret 参数：表单里没有默认值，节点收到的是默认值（字符串、数字、布尔都一样）", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane, { nodes: [ECHO_NODE] });
	await createScenario(controlPlane, "巡检", SCENARIO);
	const drawer = await openDrawer(page);

	const token = drawer.getByRole("textbox", { name: /^api_token / });
	const pin = drawer.getByRole("textbox", { name: /^pin / });
	const flag = drawer.getByRole("combobox", { name: /^flag / });
	await expect(token).toHaveValue("");
	await expect(token).toHaveAttribute("placeholder", "已设置默认值，留空使用");
	await expect(pin).toHaveValue("");
	// 布尔：下拉里「使用默认值」是选中的，和「选了关」分开。
	await expect(flag).toHaveValue("");
	await expect(flag.locator("option:checked")).toHaveText("使用默认值");
	await expect(drawer).not.toContainText(SECRET);
	await expect(drawer).not.toContainText(String(PIN));

	await drawer.getByRole("button", { name: "触发运行" }).click();
	expect((await agent.nextAssign()).inputs).toEqual({
		token: SECRET,
		pin: PIN,
		flag: true,
		region: "cn-east",
	});
});

test("从运行抽屉触发，动过的 secret 参数才传：选「false」传 false，填了新值传新值，其余仍用默认值", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane, { nodes: [ECHO_NODE] });
	await createScenario(controlPlane, "巡检", SCENARIO);
	const drawer = await openDrawer(page);

	await drawer.getByRole("combobox", { name: /^flag / }).selectOption("false");
	await drawer.getByRole("textbox", { name: /^api_token / }).fill("test-secret-typed");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	expect((await agent.nextAssign()).inputs).toEqual({
		token: "test-secret-typed",
		pin: PIN,
		flag: false,
		region: "cn-east",
	});
});

test("运行预设的表单：勾选 secret 的布尔参数要选 true 或 false（没有「使用默认值」），选了才能保存", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane, { nodes: [ECHO_NODE] });
	await createScenario(controlPlane, "巡检", SCENARIO);
	await page.goto("/orchestrations");
	await page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "更多操作" })
		.click();
	await page.getByRole("menuitem", { name: "运行预设…" }).click();
	const dialog = page.getByRole("dialog", { name: "运行预设" });
	await dialog.getByRole("button", { name: "新建预设" }).click();
	const form = page.getByRole("dialog", { name: "新建运行预设" });
	await form.getByLabel("名称").fill("开关关掉");
	await form.getByRole("checkbox", { name: "预设 flag" }).check();
	const flag = form.getByRole("combobox", { name: /^flag / });
	await expect(flag).toHaveValue("");
	await expect(flag.locator("option:checked")).toHaveText("请选择");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(flag).toHaveAttribute("aria-invalid", "true");
	await flag.selectOption("false");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();
	await dialog.getByRole("button", { name: "关闭", exact: true }).click();

	// 用预设触发：预设固定的 flag 是 false，其余 secret 参数没动，用默认值。
	await page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "运行", exact: true })
		.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(drawer.getByRole("list", { name: "触发前检查" })).toBeVisible();
	await drawer.getByRole("combobox", { name: "运行预设" }).selectOption({ label: "开关关掉" });
	await drawer.getByRole("button", { name: "触发运行" }).click();
	expect((await agent.nextAssign()).inputs).toEqual({
		token: SECRET,
		pin: PIN,
		flag: false,
		region: "cn-east",
	});
});
