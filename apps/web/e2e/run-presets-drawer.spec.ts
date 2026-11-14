import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import {
	createRunPreset,
	deleteRunPreset,
	listRunPresets,
	saveScenarioVersion,
} from "./run-presets-support";
import { createScenario, publishPackage, scenarioUsing } from "./support";

// 运行抽屉里用预设更顺手（#327，ADR 0023）：记住最近一次用的预设、切换预设时保留填写、存为预设、管理预设…。

/** 打开场景卡片的运行抽屉。 */
async function openDrawer(page: Page, scenario = "巡检") {
	await page
		.getByRole("article", { name: scenario })
		.getByRole("button", { name: "运行", exact: true })
		.click();
	return page.getByRole("dialog", { name: `运行 · ${scenario}` });
}

const presetSelect = (drawer: ReturnType<Page["locator"]>) =>
	drawer.getByRole("combobox", { name: "运行预设" });
const field = (drawer: ReturnType<Page["locator"]>, name: string) =>
	drawer.getByRole("textbox", { name: new RegExp(`^${name} `) });

test("触发时用了某个预设，重新打开这个场景的抽屉默认选中它；记住的预设被删除或失效以后回到不使用预设", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await createScenario(controlPlane, "另一个场景", PARAM_SCENARIO);
	const presetA = await createRunPreset(controlPlane, id, {
		name: "压测 A 集群",
		params: [
			{ name: "host", value: "10.0.0.8" },
			{ name: "steps", value: 50 },
		],
	});
	const presetB = await createRunPreset(controlPlane, id, {
		name: "压测 B 集群",
		params: [{ name: "host", value: "10.0.0.9" }],
	});
	await page.goto("/orchestrations");

	// 还没有用过预设：不使用预设。选中预设但没有触发，不算用过。
	let drawer = await openDrawer(page);
	await expect(presetSelect(drawer)).toHaveValue("");
	await presetSelect(drawer).selectOption({ label: "压测 A 集群" });
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
	drawer = await openDrawer(page);
	await expect(presetSelect(drawer)).toHaveValue("");

	// 用预设触发：下次打开默认选中它，预设参数已经锁定。
	await presetSelect(drawer).selectOption({ label: "压测 A 集群" });
	await field(drawer, "api_token").fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	expect((await agent.nextAssign()).inputs).toEqual({ host: "10.0.0.8" });
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();

	drawer = await openDrawer(page);
	await expect(presetSelect(drawer)).toHaveValue(presetA);
	await expect(field(drawer, "host")).toHaveValue("10.0.0.8");
	await expect(field(drawer, "host")).toHaveAttribute("readonly", "");
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();

	// 记在这个场景上：别的场景照常是不使用预设。
	const other = await openDrawer(page, "另一个场景");
	await expect(presetSelect(other)).toHaveValue("");
	await page.keyboard.press("Escape");
	await expect(other).toBeHidden();

	// 记住的预设被删除：回到不使用预设，选择框里也没有它。
	await deleteRunPreset(controlPlane, id, presetA);
	drawer = await openDrawer(page);
	await expect(presetSelect(drawer)).toHaveValue("");
	await expect(presetSelect(drawer).getByRole("option")).toHaveText([
		"不使用预设",
		"压测 B 集群",
		"管理预设…",
	]);
	await expect(field(drawer, "host")).not.toHaveAttribute("readonly", "");

	// 换一个预设触发，记住的就是它；新版本删掉 host 让它失效以后，同样回到不使用预设。
	await presetSelect(drawer).selectOption({ label: "压测 B 集群" });
	await field(drawer, "api_token").fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
	drawer = await openDrawer(page);
	await expect(presetSelect(drawer)).toHaveValue(presetB);
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();

	await saveScenarioVersion(controlPlane, id, {
		...PARAM_SCENARIO,
		nodes: PARAM_SCENARIO.nodes.map((n) =>
			n.kind === "entry"
				? { ...n, params: n.params?.filter((p) => p.name !== "host") }
				: { ...n, inputs: { host: "h" } },
		),
	});
	drawer = await openDrawer(page);
	await expect(presetSelect(drawer)).toHaveValue("");
	await expect(presetSelect(drawer).getByRole("option", { name: /^压测 B 集群/ })).toBeDisabled();
});

test("记住的是最近一次的选择：不使用预设触发以后，下次打开抽屉回到不使用预设", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a", slots: 4 });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	const presetA = await createRunPreset(controlPlane, id, {
		name: "压测 A 集群",
		params: [{ name: "host", value: "10.0.0.8" }],
	});
	await page.goto("/orchestrations");

	let drawer = await openDrawer(page);
	await presetSelect(drawer).selectOption({ label: "压测 A 集群" });
	await field(drawer, "api_token").fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();

	drawer = await openDrawer(page);
	await expect(presetSelect(drawer)).toHaveValue(presetA);

	// 这一次不使用预设：触发成功以后，记住的不再是预设 A。
	await presetSelect(drawer).selectOption({ label: "不使用预设" });
	await field(drawer, "host").fill("10.0.0.9");
	await field(drawer, "api_token").fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();

	drawer = await openDrawer(page);
	await expect(presetSelect(drawer)).toHaveValue("");
	await expect(field(drawer, "host")).not.toHaveAttribute("readonly", "");
});

test("切换预设时，前后都能编辑的字段保留已经填的值，原来锁定的字段解锁后回到默认值，secret 预设参数的打码值不会变成可编辑的内容", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await createRunPreset(controlPlane, id, {
		name: "压测 A 集群",
		params: [
			{ name: "host", value: "10.0.0.8" },
			{ name: "steps", value: 50 },
		],
	});
	await createRunPreset(controlPlane, id, {
		name: "压测 B 集群",
		params: [{ name: "steps", value: 7 }],
	});
	await createRunPreset(controlPlane, id, {
		name: "带密钥",
		params: [
			{ name: "host", value: "10.0.0.7" },
			{ name: "api_token", value: "s3cr3t-value" },
		],
	});
	await page.goto("/orchestrations");

	const drawer = await openDrawer(page);
	const select = presetSelect(drawer);
	const host = field(drawer, "host");
	const steps = field(drawer, "steps");
	const token = field(drawer, "api_token");
	const dryRun = drawer.getByRole("switch", { name: "dry_run" });

	// 先填：host 是预设 A 固定的参数，dry_run 与 api_token 不是。
	await host.fill("typed-host");
	await dryRun.click();
	await token.fill("tok-typed");

	// 选预设 A：它固定 host 与 steps；没固定的 dry_run 与 api_token 还是刚才填的。
	await select.selectOption({ label: "压测 A 集群" });
	await expect(host).toHaveValue("10.0.0.8");
	await expect(host).toHaveAttribute("readonly", "");
	await expect(steps).toHaveValue("50");
	await expect(dryRun).toBeChecked();
	await expect(token).toHaveValue("tok-typed");

	// 切回不使用预设：原来锁定的参数解锁，显示默认值（host 没有默认值，steps 默认 3）；其余保留。
	await select.selectOption({ label: "不使用预设" });
	await expect(host).toHaveValue("");
	await expect(host).not.toHaveAttribute("readonly", "");
	await expect(steps).toHaveValue("3");
	await expect(dryRun).toBeChecked();
	await expect(token).toHaveValue("tok-typed");

	// host 在预设 B 里能编辑：从不使用预设换到 B 保留已填的值，从固定了它的预设 A 换到 B 回到默认值。
	await host.fill("typed-again");
	await select.selectOption({ label: "压测 B 集群" });
	await expect(host).toHaveValue("typed-again");
	await expect(steps).toHaveValue("7");
	await select.selectOption({ label: "压测 A 集群" });
	await expect(host).toHaveValue("10.0.0.8");
	await select.selectOption({ label: "压测 B 集群" });
	await expect(host).toHaveValue("");
	await expect(steps).toHaveValue("7");
	await expect(dryRun).toBeChecked();
	await expect(token).toHaveValue("tok-typed");

	// secret 参数锁定时只显示打码；解锁以后是空的、可以填写，不会把打码的值当成内容。
	await select.selectOption({ label: "带密钥" });
	await expect(token).toHaveValue("******");
	await expect(token).toHaveAttribute("readonly", "");
	await select.selectOption({ label: "不使用预设" });
	await expect(token).toHaveValue("");
	await expect(token).not.toHaveAttribute("readonly", "");
	await token.fill("tok-new");
	await expect(token).toHaveValue("tok-new");
});

test("用「存为预设」保存抽屉里填的值：填了值的参数默认勾上，secret 参数要重新输入，保存后在选择框里能选到新预设", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await page.goto("/orchestrations");

	const drawer = await openDrawer(page);
	await expect(presetSelect(drawer).getByRole("option")).toHaveText(["不使用预设", "管理预设…"]);
	await field(drawer, "host").fill("10.0.0.8");
	await field(drawer, "steps").fill("50");
	await field(drawer, "api_token").fill("tok-typed");
	await drawer.getByRole("button", { name: "存为预设" }).click();

	// 管理对话框直接打开新建表单：填了值的参数勾上并带着值，没动过、还是默认值的 dry_run 也有值，同样勾上；secret 参数勾上但要重新输入。
	const form = page.getByRole("dialog", { name: "新建运行预设" });
	await expect(form.getByRole("checkbox", { name: "预设 host" })).toBeChecked();
	await expect(field(form, "host")).toHaveValue("10.0.0.8");
	await expect(form.getByRole("checkbox", { name: "预设 steps" })).toBeChecked();
	await expect(field(form, "steps")).toHaveValue("50");
	await expect(form.getByRole("checkbox", { name: "预设 dry_run" })).toBeChecked();
	await expect(form.getByRole("switch", { name: "dry_run" })).not.toBeChecked();
	await expect(form.getByRole("checkbox", { name: "预设 api_token" })).toBeChecked();
	await expect(field(form, "api_token")).toHaveValue("");

	await form.getByLabel("名称").fill("压测 A 集群");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(field(form, "api_token")).toHaveAttribute("aria-invalid", "true");
	await expect(field(form, "api_token")).toBeFocused();
	await field(form, "api_token").fill("tok-again");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();

	const dialog = page.getByRole("dialog", { name: "运行预设" });
	await expect(dialog.getByRole("listitem")).toHaveCount(1);
	await expect(dialog).toContainText("压测 A 集群");
	await dialog.getByRole("button", { name: "关闭" }).click();
	await expect(dialog).toBeHidden();

	// 抽屉还开着，选择框里能选到新预设：预设参数锁定，secret 只显示打码。
	await expect(presetSelect(drawer).getByRole("option")).toHaveText([
		"不使用预设",
		"压测 A 集群",
		"管理预设…",
	]);
	await presetSelect(drawer).selectOption({ label: "压测 A 集群" });
	await expect(field(drawer, "host")).toHaveValue("10.0.0.8");
	await expect(field(drawer, "steps")).toHaveValue("50");
	await expect(field(drawer, "api_token")).toHaveValue("******");
	await expect(drawer.getByRole("button", { name: "存为预设" })).toBeHidden();

	const [saved] = await listRunPresets(controlPlane, id);
	expect(saved?.params.map((p) => [p.name, p.value])).toEqual([
		["host", "10.0.0.8"],
		["steps", 50],
		["dry_run", false],
		["api_token", "******"],
	]);
	// 保存预设只是保存，没有触发运行。
	const runs = await (await controlPlane.fetch(`/orchestrations/${id}/runs`)).json();
	expect(runs.runs).toEqual([]);
});

test("从「管理预设…」新建预设，关掉对话框以后抽屉里的选择框马上能看到它；没有预设的场景也能进来", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await createScenario(controlPlane, "没有参数", scenarioUsing("agent-a"));
	await page.goto("/orchestrations");

	// 入口节点没有声明参数的场景不能有预设，抽屉里不显示预设。
	const noParams = await openDrawer(page, "没有参数");
	await expect(noParams.getByText("入口节点没有声明参数")).toBeVisible();
	await expect(presetSelect(noParams)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(noParams).toBeHidden();

	const drawer = await openDrawer(page);
	const select = presetSelect(drawer);
	await expect(select.getByRole("option")).toHaveText(["不使用预设", "管理预设…"]);
	await select.selectOption({ label: "管理预设…" });

	// Esc 只关掉管理对话框，抽屉还在，焦点回到选择框，选中项没有变成「管理预设…」。
	const dialog = page.getByRole("dialog", { name: "运行预设" });
	await expect(dialog).toContainText("还没有运行预设");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(drawer).toBeVisible();
	await expect(select).toBeFocused();
	await expect(select).toHaveValue("");

	await select.selectOption({ label: "管理预设…" });
	await dialog.getByRole("button", { name: "新建预设" }).click();
	const form = page.getByRole("dialog", { name: "新建运行预设" });
	await form.getByLabel("名称").fill("压测 A 集群");
	await form.getByRole("checkbox", { name: "预设 host" }).check();
	await field(form, "host").fill("10.0.0.8");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();
	await expect(dialog).toContainText("压测 A 集群");
	await dialog.getByRole("button", { name: "关闭" }).click();
	await expect(dialog).toBeHidden();

	await expect(drawer).toBeVisible();
	await expect(select).toHaveValue("");
	await expect(select.getByRole("option")).toHaveText(["不使用预设", "压测 A 集群", "管理预设…"]);
	await select.selectOption({ label: "压测 A 集群" });
	await expect(field(drawer, "host")).toHaveValue("10.0.0.8");
});
