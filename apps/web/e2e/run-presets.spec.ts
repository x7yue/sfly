import { expect, test } from "./fixtures";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { createScenario, publishPackage } from "./support";

// 运行预设（#322，ADR 0023）：在场景的更多菜单里新建预设，在运行抽屉里选中它，预设参数锁定，触发后运行用预设的值。

test("从场景列表新建运行预设，在运行抽屉里选中它：预设参数锁定，触发后运行使用预设的值", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await page.goto("/orchestrations");

	const card = page.getByRole("article", { name: "巡检" });
	await card.getByRole("button", { name: "更多操作" }).click();
	await page.getByRole("menuitem", { name: "运行预设…" }).click();
	const dialog = page.getByRole("dialog", { name: "运行预设" });
	await expect(dialog).toContainText("还没有运行预设");
	await dialog.getByRole("button", { name: "新建预设" }).click();

	const form = page.getByRole("dialog", { name: "新建运行预设" });
	await form.getByLabel("名称").fill("压测 A 集群");
	await form.getByLabel("说明").fill("A 集群，跑 50 步");
	// 没勾选的参数不能编辑；secret 参数同样可以勾选（#324）。
	await expect(form.getByRole("textbox", { name: /^steps / })).toBeDisabled();
	await expect(form.getByRole("textbox", { name: /^api_token / })).toBeDisabled();
	await expect(form.getByRole("checkbox", { name: "预设 api_token" })).toBeEnabled();

	// 勾选时先填上默认值。
	await form.getByRole("checkbox", { name: "预设 steps" }).check();
	await expect(form.getByRole("textbox", { name: /^steps / })).toHaveValue("3");
	await form.getByRole("textbox", { name: /^steps / }).fill("50");
	// 勾选的参数必须填值。
	await form.getByRole("checkbox", { name: "预设 host" }).check();
	await form.getByRole("button", { name: "保存" }).click();
	const host = form.getByRole("textbox", { name: /^host / });
	await expect(host).toHaveAttribute("aria-invalid", "true");
	await expect(host).toBeFocused();
	await host.fill("10.0.0.8");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();

	const presets = dialog.getByRole("list", { name: "运行预设" });
	await expect(presets.getByRole("listitem")).toHaveCount(1);
	await expect(presets).toContainText("压测 A 集群");
	await expect(presets).toContainText("A 集群，跑 50 步");
	await expect(presets).toContainText("host = 10.0.0.8");
	await expect(presets).toContainText("steps = 50");
	await dialog.getByRole("button", { name: "关闭" }).click();
	await expect(dialog).toBeHidden();

	// 运行抽屉：选中预设后预设参数只读、带说明，其余参数照常填写。
	await card.getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	const select = drawer.getByRole("combobox", { name: "运行预设" });
	await expect(select).toHaveValue("");
	await expect(select.getByRole("option")).toHaveText(["不使用预设", "压测 A 集群"]);
	await select.selectOption({ label: "压测 A 集群" });
	const lockedHost = drawer.getByRole("textbox", { name: /^host / });
	await expect(lockedHost).toHaveValue("10.0.0.8");
	await expect(lockedHost).toHaveAttribute("readonly", "");
	await expect(lockedHost).toHaveAccessibleDescription("由预设 压测 A 集群 固定");
	await expect(drawer.getByRole("textbox", { name: /^steps / })).toHaveValue("50");
	await expect(drawer.getByRole("textbox", { name: /^steps / })).toHaveAttribute("readonly", "");
	await drawer.getByRole("switch", { name: "dry_run" }).click();
	await drawer.getByRole("textbox", { name: /^api_token / }).fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();

	expect((await agent.nextAssign()).inputs).toEqual({ host: "10.0.0.8" });
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");
	const runs = (await (await controlPlane.fetch(`/orchestrations/${id}/runs`)).json()) as {
		runs: Array<{ id: string }>;
	};
	const run = await (await controlPlane.fetch(`/runs/${runs.runs[0]?.id}`)).json();
	expect(run.params).toMatchObject({ host: "10.0.0.8", steps: 50, dry_run: true });
	expect(run.preset).toMatchObject({ name: "压测 A 集群", params: ["host", "steps"] });
});
