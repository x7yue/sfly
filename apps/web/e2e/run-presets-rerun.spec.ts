import type { Page } from "@playwright/test";
import { actAs } from "../../server/test/support/credentials.js";
import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { expect, test } from "./fixtures";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import {
	createRunPreset,
	deleteRunPreset,
	saveScenarioVersion,
	updateRunPreset,
} from "./run-presets-support";
import { createScenario, publishPackage } from "./support";

// 「再次运行」带上原来的预设（#329，ADR 0024）：预设可用就选中它，锁定的值取预设现在的值；
// 预设已删除或已失效、或者原来没用预设，抽屉回到不使用预设，浏览器里记住的预设也不顶替。

/** 一个已经结束的运行：触发（可以带预设）、让假 Agent 跑完，返回运行 ID。 */
async function finishedRun(
	cp: TestControlPlane,
	agent: FakeAgent,
	scenarioId: string,
	body: { params: Record<string, unknown>; preset?: string },
): Promise<string> {
	const res = await cp.fetch(`/orchestrations/${scenarioId}/runs`, {
		method: "POST",
		headers: { "content-type": "application/json", ...actAs("tester") },
		body: JSON.stringify(body),
	});
	if (res.status !== 201) throw new Error(`触发运行：HTTP ${res.status} ${await res.text()}`);
	await agent.succeed(await agent.nextAssign());
	return ((await res.json()) as { id: string }).id;
}

const presetSelect = (drawer: ReturnType<Page["locator"]>) =>
	drawer.getByRole("combobox", { name: "运行预设" });
const field = (drawer: ReturnType<Page["locator"]>, name: string) =>
	drawer.getByRole("textbox", { name: new RegExp(`^${name} `) });

/** 在场景列表的运行抽屉里用某个预设触发一次，让浏览器记住它是这个场景最近一次用的预设。 */
async function rememberPresetByRunning(page: Page, agent: FakeAgent, preset: string) {
	await page.goto("/orchestrations");
	await page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "运行", exact: true })
		.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await presetSelect(drawer).selectOption({ label: preset });
	if (await field(drawer, "host").isEditable()) await field(drawer, "host").fill("10.0.0.1");
	await field(drawer, "api_token").fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await agent.nextAssign();
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
}

/** 打开某个运行的「再次运行」抽屉；预检加载完、选择框出现时，默认选中的预设已经定下来。 */
async function openRerun(page: Page, runId: string) {
	await page.goto(`/runs/${runId}`);
	await page.getByRole("banner").getByRole("button", { name: "再次运行" }).click();
	const drawer = page.getByRole("dialog", { name: "再次运行 · 巡检" });
	await expect(presetSelect(drawer)).toBeVisible();
	return drawer;
}

/** 新版本删掉入口参数 host：固定了 host 的预设失效。 */
const WITHOUT_HOST = {
	...PARAM_SCENARIO,
	nodes: PARAM_SCENARIO.nodes.map((n) =>
		n.kind === "entry"
			? { ...n, params: n.params?.filter((p) => p.name !== "host") }
			: { ...n, inputs: { host: "h" } },
	),
};

/**
 * 场景有「压测 A 集群」（固定 host）和「压测 B 集群」（固定 steps，host 删掉以后它还可用），
 * 预设 A 触发过一次，非预设参数 steps 和 dry_run 改过。
 */
async function setup(
	controlPlane: TestControlPlane,
	connectAgent: (hello: { name: string; slots: number }) => Promise<FakeAgent>,
) {
	const agent = await connectAgent({ name: "agent-a", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	const presetA = await createRunPreset(controlPlane, scenario, {
		name: "压测 A 集群",
		params: [{ name: "host", value: "10.0.0.8" }],
	});
	await createRunPreset(controlPlane, scenario, {
		name: "压测 B 集群",
		params: [{ name: "steps", value: 7 }],
	});
	const run = await finishedRun(controlPlane, agent, scenario, {
		params: { steps: 9, dry_run: true, api_token: "tok-live" },
		preset: presetA,
	});
	return { agent, scenario, presetA, run };
}

test("对用了预设的运行点「再次运行」：选中同一个预设（优先于记住的预设），非预设参数是上一次的值，预设改了以后锁定的是新值", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { agent, scenario, presetA, run } = await setup(controlPlane, connectAgent);
	await rememberPresetByRunning(page, agent, "压测 B 集群");

	let drawer = await openRerun(page, run);
	await expect(presetSelect(drawer)).toHaveValue(presetA);
	await expect(field(drawer, "host")).toHaveValue("10.0.0.8");
	await expect(field(drawer, "host")).toHaveAttribute("readonly", "");
	await expect(field(drawer, "steps")).toHaveValue("9");
	await expect(field(drawer, "steps")).not.toHaveAttribute("readonly", "");
	await expect(drawer.getByRole("switch", { name: "dry_run" })).toBeChecked();
	await expect(field(drawer, "api_token")).toHaveValue("");
	await expect(drawer.getByText(/已删除|已失效/)).toHaveCount(0);

	// 先修改预设的值，再点「再次运行」：锁定显示的是预设现在的值，不是上次运行用的值。
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
	await updateRunPreset(controlPlane, scenario, presetA, {
		params: [{ name: "host", value: "10.0.0.18" }],
	});
	await page.getByRole("banner").getByRole("button", { name: "再次运行" }).click();
	drawer = page.getByRole("dialog", { name: "再次运行 · 巡检" });
	await expect(presetSelect(drawer)).toHaveValue(presetA);
	await expect(field(drawer, "host")).toHaveValue("10.0.0.18");
	await expect(field(drawer, "steps")).toHaveValue("9");

	// 切回不使用预设：原来锁定的 host 回到默认值（没有默认值），不是上次运行的值。
	await presetSelect(drawer).selectOption({ label: "不使用预设" });
	await expect(field(drawer, "host")).toHaveValue("");
	await expect(field(drawer, "steps")).toHaveValue("9");
	await presetSelect(drawer).selectOption({ label: "压测 A 集群" });
	await expect(field(drawer, "host")).toHaveValue("10.0.0.18");

	// 触发：运行记下同一个预设，预设参数取预设现在的值，其余是填的值。
	await field(drawer, "api_token").fill("tok-again");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await expect(page).not.toHaveURL(new RegExp(`/runs/${run}(\\?|$)`));
	const next = new URL(page.url()).pathname.split("/runs/")[1];
	await expect(
		page.getByRole("banner").getByRole("button", { name: "预设：压测 A 集群" }),
	).toBeVisible();
	const started = await (await controlPlane.fetch(`/runs/${next}`)).json();
	expect(started.preset).toMatchObject({ id: presetA, name: "压测 A 集群", params: ["host"] });
	expect(started.params).toMatchObject({ host: "10.0.0.18", steps: 9, dry_run: true });
});

test("预设被删除以后点「再次运行」：回到不使用预设，全部参数是上一次的值，表单上方写明预设已删除", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { agent, scenario, presetA, run } = await setup(controlPlane, connectAgent);
	await rememberPresetByRunning(page, agent, "压测 B 集群");
	await deleteRunPreset(controlPlane, scenario, presetA);

	const drawer = await openRerun(page, run);
	await expect(presetSelect(drawer)).toHaveValue("");
	await expect(field(drawer, "host")).toHaveValue("10.0.0.8");
	await expect(field(drawer, "host")).not.toHaveAttribute("readonly", "");
	await expect(field(drawer, "steps")).toHaveValue("9");
	await expect(drawer.getByRole("switch", { name: "dry_run" })).toBeChecked();
	await expect(field(drawer, "api_token")).toHaveValue("");

	const notice = drawer.getByText("预设 压测 A 集群 已删除");
	await expect(notice).toBeVisible();
	const above = async (upper: ReturnType<Page["locator"]>, lower: ReturnType<Page["locator"]>) =>
		((await upper.boundingBox())?.y ?? Infinity) < ((await lower.boundingBox())?.y ?? -Infinity);
	expect(await above(notice, presetSelect(drawer))).toBe(true);
	expect(await above(notice, field(drawer, "host"))).toBe(true);
});

test("预设失效以后点「再次运行」：回到不使用预设，全部参数是上一次的值，提示里写明失效的原因", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { agent, scenario, run } = await setup(controlPlane, connectAgent);
	await rememberPresetByRunning(page, agent, "压测 B 集群");
	await saveScenarioVersion(controlPlane, scenario, WITHOUT_HOST);

	const drawer = await openRerun(page, run);
	await expect(presetSelect(drawer)).toHaveValue("");
	await expect(presetSelect(drawer).getByRole("option", { name: /^压测 A 集群/ })).toBeDisabled();
	await expect(presetSelect(drawer).getByRole("option", { name: "压测 B 集群" })).toBeEnabled();
	await expect(field(drawer, "steps")).toHaveValue("9");
	await expect(field(drawer, "steps")).not.toHaveAttribute("readonly", "");
	await expect(drawer.getByRole("switch", { name: "dry_run" })).toBeChecked();
	await expect(drawer.getByText("预设 压测 A 集群 已失效：参数 host 已不存在")).toBeVisible();
});

test("再次运行的抽屉开着，把选中的预设删掉：回到不使用预设，字段是上一次的值，提示预设已删除", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { scenario, presetA, run } = await setup(controlPlane, connectAgent);
	await updateRunPreset(controlPlane, scenario, presetA, {
		params: [{ name: "host", value: "10.0.0.18" }],
	});

	const drawer = await openRerun(page, run);
	await expect(presetSelect(drawer)).toHaveValue(presetA);
	await expect(field(drawer, "host")).toHaveValue("10.0.0.18");
	await expect(drawer.getByText(/已删除|已失效/)).toHaveCount(0);

	await presetSelect(drawer).selectOption({ label: "管理预设…" });
	const dialog = page.getByRole("dialog", { name: "运行预设" });
	await dialog.getByRole("button", { name: "删除 压测 A 集群" }).click();
	await page.getByRole("button", { name: "删除", exact: true }).click();
	await dialog.getByRole("button", { name: "关闭" }).click();
	await expect(dialog).toBeHidden();

	await expect(presetSelect(drawer)).toHaveValue("");
	await expect(field(drawer, "host")).toHaveValue("10.0.0.8");
	await expect(field(drawer, "host")).not.toHaveAttribute("readonly", "");
	await expect(field(drawer, "steps")).toHaveValue("9");
	await expect(drawer.getByText("预设 压测 A 集群 已删除")).toBeVisible();
});

test("对没用预设的运行点「再次运行」：和以前一样，不使用预设，浏览器里记住的预设不会选中", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { agent, scenario, presetA } = await setup(controlPlane, connectAgent);
	await rememberPresetByRunning(page, agent, "压测 A 集群");
	const plain = await finishedRun(controlPlane, agent, scenario, {
		params: { host: "10.0.0.5", steps: 4, api_token: "tok-live" },
	});

	const drawer = await openRerun(page, plain);
	await expect(presetSelect(drawer)).toHaveValue("");
	await expect(field(drawer, "host")).toHaveValue("10.0.0.5");
	await expect(field(drawer, "host")).not.toHaveAttribute("readonly", "");
	await expect(field(drawer, "steps")).toHaveValue("4");
	await expect(drawer.getByText(/已删除|已失效/)).toHaveCount(0);

	// 直接运行还是照旧选中记住的预设。
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
	await page.goto("/orchestrations");
	await page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "运行", exact: true })
		.click();
	const fresh = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(presetSelect(fresh)).toHaveValue(presetA);
	await expect(field(fresh, "host")).toHaveValue("10.0.0.8");
	await expect(field(fresh, "host")).toHaveAttribute("readonly", "");
});
