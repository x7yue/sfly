import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { createRunPreset, listRunPresets } from "./run-presets-support";
import { createScenario, publishPackage } from "./support";

// 运行预设的维护（#323，ADR 0023）：在管理对话框里编辑、复制、删除预设；场景归档期间也能编辑。

/** 打开场景卡片「更多」菜单里的「运行预设…」。 */
async function openPresets(page: Page, scenario: string) {
	await page
		.getByRole("article", { name: scenario })
		.getByRole("button", { name: "更多操作" })
		.click();
	await page.getByRole("menuitem", { name: "运行预设…" }).click();
	return page.getByRole("dialog", { name: "运行预设" });
}

test("编辑运行预设：列表写着最后由谁、什么时候修改；改名称、说明、勾选和值之后立即生效，运行抽屉用的是新的预设", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await createRunPreset(
		controlPlane,
		id,
		{
			name: "压测 A 集群",
			description: "A 集群，跑 50 步",
			params: [
				{ name: "host", value: "10.0.0.8" },
				{ name: "steps", value: 50 },
			],
		},
		"小红",
	);
	await page.goto("/orchestrations");

	const dialog = await openPresets(page, "巡检");
	const row = dialog.getByRole("listitem").filter({ hasText: "压测 A 集群" });
	await expect(row).toContainText("最后修改 小红 · 01-01 08:00");
	await row.getByRole("button", { name: "编辑" }).click();

	// 编辑表单带着预设现在的内容：勾选的参数和它们的值，没勾选的参数不能编辑。
	const form = page.getByRole("dialog", { name: "编辑运行预设" });
	await expect(form.getByLabel("名称")).toHaveValue("压测 A 集群");
	await expect(form.getByLabel("说明")).toHaveValue("A 集群，跑 50 步");
	await expect(form.getByRole("checkbox", { name: "预设 host" })).toBeChecked();
	await expect(form.getByRole("textbox", { name: /^host / })).toHaveValue("10.0.0.8");
	await expect(form.getByRole("checkbox", { name: "预设 steps" })).toBeChecked();
	await expect(form.getByRole("textbox", { name: /^steps / })).toHaveValue("50");
	await expect(form.getByRole("checkbox", { name: "预设 dry_run" })).not.toBeChecked();
	await expect(form.getByRole("switch", { name: "dry_run" })).toBeDisabled();

	// 名称和勾选的参数照新建时的规则校验。
	await form.getByLabel("名称").fill("   ");
	await form.getByRole("textbox", { name: /^host / }).fill("");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form.getByLabel("名称")).toHaveAttribute("aria-invalid", "true");
	await expect(form.getByLabel("名称")).toBeFocused();
	await expect(form.getByRole("textbox", { name: /^host / })).toHaveAttribute(
		"aria-invalid",
		"true",
	);

	await form.getByLabel("名称").fill("压测 B 集群");
	await form.getByLabel("说明").fill("");
	await form.getByRole("textbox", { name: /^host / }).fill("10.0.0.9");
	await form.getByRole("checkbox", { name: "预设 steps" }).uncheck();
	await form.getByRole("checkbox", { name: "预设 dry_run" }).check();
	await form.getByRole("switch", { name: "dry_run" }).click();
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();

	// 立即生效：列表里是新的内容，最后修改人是自己。
	const list = dialog.getByRole("list", { name: "运行预设" });
	await expect(list.getByRole("listitem")).toHaveCount(1);
	await expect(list).toContainText("压测 B 集群");
	await expect(list).not.toContainText("压测 A 集群");
	await expect(list).toContainText("host = 10.0.0.9");
	await expect(list).toContainText("dry_run = true");
	await expect(list).not.toContainText("steps");
	await expect(list).toContainText("最后修改 tester · 01-01 08:00");
	await expect(dialog.getByRole("button", { name: "编辑 压测 B 集群" })).toBeFocused();
	expect(await listRunPresets(controlPlane, id)).toMatchObject([
		{ name: "压测 B 集群", description: "", updated_by: "tester" },
	]);
	await dialog.getByRole("button", { name: "关闭" }).click();

	// 运行抽屉：host 和 dry_run 锁定，steps 不再是预设参数，照常填写。
	await page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "运行", exact: true })
		.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("combobox", { name: "运行预设" }).selectOption({ label: "压测 B 集群" });
	await expect(drawer.getByRole("textbox", { name: /^host / })).toHaveValue("10.0.0.9");
	await expect(drawer.getByRole("textbox", { name: /^host / })).toHaveAttribute("readonly", "");
	await expect(drawer.getByRole("textbox", { name: /^steps / })).toHaveValue("3");
	await expect(drawer.getByRole("textbox", { name: /^steps / })).not.toHaveAttribute("readonly");
	await drawer.getByRole("textbox", { name: /^api_token / }).fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();

	expect((await agent.nextAssign()).inputs).toEqual({ host: "10.0.0.9" });
	const runs = (await (await controlPlane.fetch(`/orchestrations/${id}/runs`)).json()) as {
		runs: Array<{ id: string }>;
	};
	const run = await (await controlPlane.fetch(`/runs/${runs.runs[0]?.id}`)).json();
	expect(run.params).toMatchObject({ host: "10.0.0.9", steps: 3, dry_run: true });
	expect(run.preset).toMatchObject({ name: "压测 B 集群", params: ["host", "dry_run"] });
});

test("复制运行预设：取一个新名称，值一起复制，名称重复时留在表单里提示；删除之前要确认", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await createRunPreset(controlPlane, id, {
		name: "压测 A 集群",
		description: "A 集群",
		params: [
			{ name: "host", value: "10.0.0.8" },
			{ name: "dry_run", value: true },
		],
	});
	await page.goto("/orchestrations");

	const dialog = await openPresets(page, "巡检");
	const list = dialog.getByRole("list", { name: "运行预设" });
	await dialog.getByRole("button", { name: "复制 压测 A 集群" }).click();

	const copy = page.getByRole("dialog", { name: "复制运行预设" });
	await expect(copy.getByLabel("名称")).toHaveValue("压测 A 集群 副本");
	// 名称已被占用：错误写在表单里，不离开。
	await copy.getByLabel("名称").fill("压测 A 集群");
	await copy.getByRole("button", { name: "复制" }).click();
	await expect(copy.getByRole("alert")).toContainText("名称不能重复");
	await expect(copy).toBeVisible();
	// 名称为空：先在表单里提示。
	await copy.getByLabel("名称").fill("  ");
	await copy.getByRole("button", { name: "复制" }).click();
	await expect(copy.getByLabel("名称")).toHaveAttribute("aria-invalid", "true");

	await copy.getByLabel("名称").fill("压测 B 集群");
	await copy.getByRole("button", { name: "复制" }).click();
	await expect(copy).toBeHidden();
	await expect(list.getByRole("listitem")).toHaveCount(2);
	const copied = list.getByRole("listitem").filter({ hasText: "压测 B 集群" });
	await expect(copied).toContainText("A 集群");
	await expect(copied).toContainText("host = 10.0.0.8");
	await expect(copied).toContainText("dry_run = true");
	// 焦点回到打开复制表单的按钮。
	await expect(dialog.getByRole("button", { name: "复制 压测 A 集群" })).toBeFocused();

	// 删除要先确认；放弃之后预设还在。
	await dialog.getByRole("button", { name: "删除 压测 B 集群" }).click();
	const confirm = page.getByRole("dialog", { name: "删除运行预设「压测 B 集群」？" });
	await expect(confirm).toContainText("已有运行上记下的预设名不受影响");
	await confirm.getByRole("button", { name: "取消" }).click();
	await expect(list.getByRole("listitem")).toHaveCount(2);
	await expect(dialog.getByRole("button", { name: "删除 压测 B 集群" })).toBeFocused();

	await dialog.getByRole("button", { name: "删除 压测 B 集群" }).click();
	await confirm.getByRole("button", { name: "删除" }).click();
	await expect(confirm).toBeHidden();
	await expect(list.getByRole("listitem")).toHaveCount(1);
	await expect(list).not.toContainText("压测 B 集群");
	expect((await listRunPresets(controlPlane, id)).map((p) => p.name)).toEqual(["压测 A 集群"]);

	// 删到没有为止：回到「还没有运行预设」。
	await dialog.getByRole("button", { name: "删除 压测 A 集群" }).click();
	await page.getByRole("button", { name: "删除", exact: true }).click();
	await expect(dialog).toContainText("还没有运行预设");
	await expect(dialog.getByRole("button", { name: "新建预设" })).toBeFocused();
});

test("场景归档期间也能编辑运行预设：已归档的卡片有「更多操作」，里面是「运行预设…」", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "旧场景", PARAM_SCENARIO);
	await createRunPreset(controlPlane, id, {
		name: "压测 A 集群",
		params: [{ name: "host", value: "10.0.0.8" }],
	});
	const archived = await controlPlane.fetch(`/orchestrations/${id}/archive`, {
		method: "POST",
		headers: { "x-sfly-nickname": "tester" },
	});
	expect(archived.ok).toBe(true);

	await page.goto("/orchestrations?archived=true");
	const card = page.getByRole("article", { name: "旧场景" });
	// 已归档的场景不能运行，其余操作仍然只有「恢复」和「查看运行记录」，加上预设。
	await expect(card.getByRole("button", { name: "运行", exact: true })).toHaveCount(0);
	await card.getByRole("button", { name: "更多操作" }).click();
	await expect(page.getByRole("menuitem")).toHaveText(["运行预设…"]);
	await page.getByRole("menuitem", { name: "运行预设…" }).click();

	const dialog = page.getByRole("dialog", { name: "运行预设" });
	await expect(dialog).toContainText("场景已归档");
	const row = dialog.getByRole("listitem").filter({ hasText: "压测 A 集群" });
	await expect(row).toContainText("host = 10.0.0.8");
	await row.getByRole("button", { name: "编辑" }).click();
	const form = page.getByRole("dialog", { name: "编辑运行预设" });
	await form.getByLabel("说明").fill("归档期间改的");
	await form.getByRole("textbox", { name: /^host / }).fill("10.0.0.9");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();
	await expect(dialog).toContainText("归档期间改的");
	await expect(dialog).toContainText("host = 10.0.0.9");
	expect(await listRunPresets(controlPlane, id)).toMatchObject([
		{ name: "压测 A 集群", description: "归档期间改的" },
	]);

	// 也能新建；关闭之后焦点回到「更多操作」。
	await dialog.getByRole("button", { name: "新建预设" }).click();
	await page
		.getByRole("dialog", { name: "新建运行预设" })
		.getByRole("button", { name: "取消" })
		.click();
	await dialog.getByRole("button", { name: "关闭" }).click();
	await expect(card.getByRole("button", { name: "更多操作" })).toBeFocused();
});
