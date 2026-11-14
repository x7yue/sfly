import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { inspector, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { createRunPreset, listRunPresets } from "./run-presets-support";
import { createScenario, publishPackage } from "./support";

// 失效的运行预设（#326，ADR 0023）：画布保存时的警告、运行抽屉里不能选、在管理对话框里修好以后恢复可用。

/** PARAM_SCENARIO 的入口参数换成 `params`（引用 params.host 的包节点不变）。 */
const withParams = (params: Array<Record<string, unknown>>) => ({
	...PARAM_SCENARIO,
	nodes: PARAM_SCENARIO.nodes.map((n) => (n.kind === "entry" ? { ...n, params } : n)),
});
const ENTRY_PARAMS = PARAM_SCENARIO.nodes[0]?.params as Array<Record<string, unknown>>;
const without = (name: string) => ENTRY_PARAMS.filter((p) => p.name !== name);

/** 另存一个场景版本（编辑起点是第 1 版）。 */
async function saveVersion(cp: TestControlPlane, id: string, document: unknown) {
	const res = await cp.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: JSON.stringify({ base_version: 1, document }),
	});
	if (res.status !== 201) throw new Error(`保存场景版本：HTTP ${res.status} ${await res.text()}`);
}

/** 打开场景卡片「更多」菜单里的「运行预设…」。 */
async function openPresets(page: Page, scenario: string) {
	await page
		.getByRole("article", { name: scenario })
		.getByRole("button", { name: "更多操作" })
		.click();
	await page.getByRole("menuitem", { name: "运行预设…" }).click();
	return page.getByRole("dialog", { name: "运行预设" });
}

test("在画布上保存会让运行预设失效的版本：看到失效的预设和原因，版本照常保存", async ({
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
		name: "空跑",
		params: [{ name: "dry_run", value: true }],
	});
	await createRunPreset(controlPlane, id, {
		name: "单机",
		params: [{ name: "host", value: "10.0.0.9" }],
	});
	await page.goto(`/orchestrations/${id}`);

	// 删掉 dry_run，把 steps 改成字符串；host 只是换了默认值，不影响预设。
	await nodeCard(page, "entry").click();
	const panel = inspector(page);
	await panel.getByRole("button", { name: "删除参数 dry_run" }).click();
	await panel
		.getByRole("group", { name: "参数 steps" })
		.getByLabel("参数类型")
		.selectOption("string");
	await page.keyboard.press("Control+s");

	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	await expect(page.getByText("2 个运行预设已失效")).toBeVisible();
	const toast = page.getByRole("listitem").filter({ hasText: "2 个运行预设已失效" });
	await expect(toast).toContainText(
		"运行预设「压测 A 集群」已失效：参数 steps 保存的值不符合现在的类型（string）",
	);
	await expect(toast).toContainText("运行预设「空跑」已失效：参数 dry_run 已不存在");
	await expect(toast).not.toContainText("单机");

	const presets = await listRunPresets(controlPlane, id);
	expect(presets.map((p) => [p.name, p.status])).toEqual([
		["单机", "ok"],
		["压测 A 集群", "invalid"],
		["空跑", "invalid"],
	]);
});

test("运行抽屉里失效的运行预设能看到但不能选，旁边写明原因；在管理对话框里重新填写类型不对的值以后能选", async ({
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
		name: "单机",
		params: [{ name: "host", value: "10.0.0.9" }],
	});
	await saveVersion(
		controlPlane,
		id,
		withParams(
			ENTRY_PARAMS.map((p) => (p.name === "steps" ? { ...p, type: "string", default: "3" } : p)),
		),
	);
	await page.goto("/orchestrations");

	const card = page.getByRole("article", { name: "巡检" });
	await card.getByRole("button", { name: "运行", exact: true }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	const select = drawer.getByRole("combobox", { name: "运行预设" });
	const invalid = select.getByRole("option", { name: /^压测 A 集群/ });
	await expect(invalid).toBeDisabled();
	await expect(invalid).toHaveText(
		"压测 A 集群 · 已失效：参数 steps 保存的值不符合现在的类型（string）",
	);
	await expect(select.getByRole("option", { name: "单机" })).toBeEnabled();
	await expect(select).toHaveValue("");
	await drawer.getByRole("button", { name: "取消" }).click();

	// 管理对话框：列表标出失效的预设和原因；表单里类型不对的值留空、标为错误，要求重新填写。
	const dialog = await openPresets(page, "巡检");
	const row = dialog.getByRole("listitem").filter({ hasText: "压测 A 集群" });
	await expect(row).toContainText("已失效");
	await expect(row).toContainText("参数 steps 保存的值不符合现在的类型（string）");
	await expect(dialog.getByRole("listitem").filter({ hasText: "单机" })).not.toContainText(
		"已失效",
	);
	await row.getByRole("button", { name: "编辑" }).click();

	const form = page.getByRole("dialog", { name: "编辑运行预设" });
	await expect(form.getByRole("note")).toContainText("这个运行预设已失效");
	const steps = form.getByRole("textbox", { name: /^steps / });
	await expect(steps).toHaveValue("");
	await expect(steps).toHaveAttribute("aria-invalid", "true");
	await expect(form).toContainText("保存的值 50 不符合现在的类型（string），请重新填写");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeVisible();
	await expect(steps).toBeFocused();

	await steps.fill("50");
	await expect(steps).not.toHaveAttribute("aria-invalid", "true");
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();
	await expect(dialog.getByRole("listitem").filter({ hasText: "压测 A 集群" })).not.toContainText(
		"已失效",
	);
	await dialog.getByRole("button", { name: "关闭" }).click();

	// 修好以后能选：预设参数取修好的值。
	await card.getByRole("button", { name: "运行", exact: true }).click();
	await expect(select.getByRole("option", { name: /^压测 A 集群/ })).toBeEnabled();
	await select.selectOption({ label: "压测 A 集群" });
	await expect(drawer.getByRole("textbox", { name: /^steps / })).toHaveValue("50");
	await expect(drawer.getByRole("textbox", { name: /^steps / })).toHaveAttribute("readonly", "");
	expect(await listRunPresets(controlPlane, id)).toMatchObject([
		{ name: "单机", status: "ok" },
		{ name: "压测 A 集群", status: "ok", problems: [] },
	]);
});

test("管理对话框里已不存在的预设参数单独列出，取消勾选之后才能保存", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await createRunPreset(controlPlane, id, {
		name: "压测 A 集群",
		params: [
			{ name: "host", value: "10.0.0.8" },
			{ name: "dry_run", value: true },
			{ name: "steps", value: 50 },
		],
	});
	await saveVersion(controlPlane, id, withParams(without("dry_run")));
	await page.goto("/orchestrations");

	const dialog = await openPresets(page, "巡检");
	const row = dialog.getByRole("listitem").filter({ hasText: "压测 A 集群" });
	await expect(row).toContainText("已失效");
	await expect(row).toContainText("参数 dry_run 已不存在");
	await row.getByRole("button", { name: "编辑" }).click();

	const form = page.getByRole("dialog", { name: "编辑运行预设" });
	const gone = form.getByRole("region", { name: "已不存在的预设参数" });
	await expect(gone).toContainText("dry_run");
	// 已不存在的参数原来是不是 secret 无从判断，值照 secret 打码（#324）。
	await expect(gone).toContainText("= ******");
	await expect(gone).not.toContainText("= true");
	await expect(gone.getByRole("checkbox", { name: "预设 dry_run" })).toBeChecked();
	// 还勾选着就不能保存。
	await form.getByRole("button", { name: "保存" }).click();
	await expect(gone.getByRole("alert")).toContainText(
		"dry_run 已不在入口参数里，取消勾选之后才能保存",
	);
	await expect(form).toBeVisible();

	await gone.getByRole("checkbox", { name: "预设 dry_run" }).uncheck();
	await form.getByRole("button", { name: "保存" }).click();
	await expect(form).toBeHidden();
	await expect(dialog.getByRole("listitem").filter({ hasText: "压测 A 集群" })).not.toContainText(
		"已失效",
	);
	expect(await listRunPresets(controlPlane, id)).toMatchObject([
		{
			name: "压测 A 集群",
			status: "ok",
			params: [
				{ name: "host", value: "10.0.0.8" },
				{ name: "steps", value: 50 },
			],
		},
	]);
});
