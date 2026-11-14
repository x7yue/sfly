// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createRunPreset, listRunPresets } from "./run-presets-support";
import { createScenario, publishPackage } from "./support";

// secret 参数作为预设参数（#324，ADR 0023）：新建、编辑时不替换 secret、替换 secret，再用预设触发。

/** 入口参数 host 与 secret 的 api_token；api_token 会传给节点的 url 输入，Agent 收到的就是原值。 */
const SCENARIO = {
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "host", type: "string", required: true },
				{ name: "api_token", type: "string", required: true, secret: true },
			],
		},
		{
			id: "check",
			kind: "package",
			package: "demo-checks",
			node: "http_check",
			inputs: { url: "${{ params.api_token }}" },
		},
	],
	edges: [{ from: "entry", to: "check", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
};

const TOKEN = "tok-live-s3cr3t";

async function openPresets(page: Page) {
	await page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "更多操作" })
		.click();
	await page.getByRole("menuitem", { name: "运行预设…" }).click();
	return page.getByRole("dialog", { name: "运行预设" });
}

/** 打开运行抽屉，选中预设；预设参数都锁定，直接触发。 */
async function triggerWith(page: Page, preset: string) {
	await page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "运行", exact: true })
		.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("combobox", { name: "运行预设" }).selectOption({ label: preset });
	return drawer;
}

test("新建带 secret 参数的预设，编辑时不替换 secret，再用它触发：界面上只有打码，运行用的是原值", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", SCENARIO);
	await page.goto("/orchestrations");

	const dialog = await openPresets(page);
	await dialog.getByRole("button", { name: "新建预设" }).click();
	const form = page.getByRole("dialog", { name: "新建运行预设" });
	await form.getByLabel("名称").fill("生产环境");

	// secret 参数可以勾选了，输入框是密码样式；必须填值。
	const checkbox = form.getByRole("checkbox", { name: "预设 api_token" });
	await expect(checkbox).toBeEnabled();
	await expect(form).not.toContainText("暂不支持");
	await checkbox.check();
	const token = form.getByRole("textbox", { name: /^api_token / });
	await expect(token).toHaveAttribute("type", "password");
	await form.getByRole("checkbox", { name: "预设 host" }).check();
	await form.getByRole("textbox", { name: /^host / }).fill("10.0.0.8");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(token).toHaveAttribute("aria-invalid", "true");
	await token.fill(TOKEN);
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();

	// 列表里 secret 的值是打码的；接口返回的也是。
	const list = dialog.getByRole("list", { name: "运行预设" });
	await expect(list).toContainText("host = 10.0.0.8");
	await expect(list).toContainText("api_token = ******");
	await expect(list).not.toContainText(TOKEN);
	const [saved] = await listRunPresets(controlPlane, id);
	expect(saved?.params).toEqual([
		{ name: "host", secret: false, value: "10.0.0.8" },
		{ name: "api_token", secret: true, value: "******" },
	]);

	// 编辑：secret 参数显示「已填写」，原值不在页面上；不点「替换」就保存，沿用原值。
	await dialog.getByRole("button", { name: "编辑 生产环境" }).click();
	const edit = page.getByRole("dialog", { name: "编辑运行预设" });
	await expect(edit.getByRole("checkbox", { name: "预设 api_token" })).toBeChecked();
	const filled = edit.getByRole("textbox", { name: /^api_token / });
	await expect(filled).toHaveValue("已填写");
	await expect(filled).toHaveAttribute("readonly", "");
	await expect(edit.getByRole("button", { name: "替换 api_token" })).toBeVisible();
	await expect(edit).not.toContainText(TOKEN);
	await edit.getByRole("textbox", { name: /^host / }).fill("10.0.0.9");
	await edit.getByRole("button", { name: "保存" }).click();
	await expect(edit).toBeHidden();
	await expect(list).toContainText("host = 10.0.0.9");
	await expect(list).toContainText("api_token = ******");
	await dialog.getByRole("button", { name: "关闭" }).click();

	// 运行抽屉：secret 参数锁定、显示打码后的值；触发后运行用的是原来的 secret 值。
	const drawer = await triggerWith(page, "生产环境");
	const locked = drawer.getByRole("textbox", { name: /^api_token / });
	await expect(locked).toHaveValue("******");
	await expect(locked).toHaveAttribute("type", "password");
	await expect(locked).toHaveAttribute("readonly", "");
	await expect(locked).toHaveAccessibleDescription("由预设 生产环境 固定");
	await expect(drawer).not.toContainText(TOKEN);
	await drawer.getByRole("button", { name: "触发运行" }).click();

	expect((await agent.nextAssign()).inputs).toEqual({ url: TOKEN });
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");
	const runs = (await (await controlPlane.fetch(`/orchestrations/${id}/runs`)).json()) as {
		runs: Array<{ id: string }>;
	};
	const run = await (await controlPlane.fetch(`/runs/${runs.runs[0]?.id}`)).json();
	expect(run.params).toEqual({ host: "10.0.0.9", api_token: "******" });
	expect(run.preset).toMatchObject({ name: "生产环境", params: ["host", "api_token"] });
});

test("编辑时点「替换」输入新的 secret 值：运行用新值；取消勾选后它不再是预设参数", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", SCENARIO);
	await createRunPreset(controlPlane, id, {
		name: "生产环境",
		params: [
			{ name: "host", value: "10.0.0.8" },
			{ name: "api_token", value: TOKEN },
		],
	});
	await page.goto("/orchestrations");

	const dialog = await openPresets(page);
	await dialog.getByRole("button", { name: "编辑 生产环境" }).click();
	const edit = page.getByRole("dialog", { name: "编辑运行预设" });
	await edit.getByRole("button", { name: "替换 api_token" }).click();
	// 替换：输入框空着，要填新值。
	const token = edit.getByRole("textbox", { name: /^api_token / });
	await expect(token).toHaveValue("");
	await expect(token).toHaveAttribute("type", "password");
	await expect(token).toBeFocused();
	await expect(edit.getByRole("button", { name: "替换 api_token" })).toHaveCount(0);
	await edit.getByRole("button", { name: "保存" }).click();
	await expect(token).toHaveAttribute("aria-invalid", "true");
	await token.fill("tok-replaced");
	await edit.getByRole("button", { name: "保存" }).click();
	await expect(edit).toBeHidden();
	await expect(dialog.getByRole("list", { name: "运行预设" })).toContainText("api_token = ******");
	await dialog.getByRole("button", { name: "关闭" }).click();

	const drawer = await triggerWith(page, "生产环境");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	expect((await agent.nextAssign()).inputs).toEqual({ url: "tok-replaced" });

	// 取消勾选 secret 参数：不再是预设参数，不再带着原值。
	await page.goto("/orchestrations");
	const again = await openPresets(page);
	await again.getByRole("button", { name: "编辑 生产环境" }).click();
	const form = page.getByRole("dialog", { name: "编辑运行预设" });
	await form.getByRole("checkbox", { name: "预设 api_token" }).uncheck();
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();
	expect((await listRunPresets(controlPlane, id))[0]?.params.map((p) => p.name)).toEqual(["host"]);
});
