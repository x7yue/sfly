import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { expect, test } from "./fixtures";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { createScenario, publishPackage } from "./support";

// 运行预设（#328，ADR 0023）：运行详情（监控页顶栏）和运行记录里显示运行用的预设，显示的是触发时记下的名称。

const JSON_HEADERS = { "content-type": "application/json", "x-sfly-nickname": "tester" };

async function createPreset(
	cp: TestControlPlane,
	scenarioId: string,
	name: string,
	params: Array<{ name: string; value: unknown }>,
): Promise<string> {
	const res = await cp.fetch(`/orchestrations/${scenarioId}/presets`, {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ name, params }),
	});
	if (!res.ok) throw new Error(`新建运行预设：HTTP ${res.status} ${await res.text()}`);
	return ((await res.json()) as { id: string }).id;
}

/** 触发场景的最新版本（入口参数里没有预设固定的必填项 api_token 在这里给）。 */
async function trigger(cp: TestControlPlane, scenarioId: string, preset?: string): Promise<string> {
	const params = { api_token: "tok-live", ...(preset ? {} : { host: "10.0.0.9" }) };
	const res = await cp.fetch(`/orchestrations/${scenarioId}/runs`, {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ params, preset }),
	});
	if (!res.ok) throw new Error(`触发运行：HTTP ${res.status} ${await res.text()}`);
	return ((await res.json()) as { id: string }).id;
}

const PRESET_PARAMS = [
	{ name: "steps", value: 50 },
	{ name: "host", value: "10.0.0.8" },
];

test("运行详情：顶栏显示用的预设，悬停或点击能看到哪些参数来自预设；没用预设的运行没有", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	const preset = await createPreset(controlPlane, scenario, "压测 A 集群", PRESET_PARAMS);
	const withPreset = await trigger(controlPlane, scenario, preset);
	await agent.succeed(await agent.nextAssign());
	const plain = await trigger(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());

	await page.goto(`/runs/${withPreset}`);
	const header = page.getByRole("banner");
	const tag = header.getByRole("button", { name: "预设：压测 A 集群" });
	await expect(tag).toBeVisible();

	// 悬停：预设参数按入口参数的声明顺序列出；Esc、移开之后收起。
	const list = page.getByRole("list", { name: "预设参数" });
	await tag.hover();
	await expect(list.getByRole("listitem")).toHaveText(["host", "steps"]);
	await page.keyboard.press("Escape");
	await page.mouse.move(0, 400);
	await expect(list).toBeHidden();

	// 点击（键盘用户按回车）同样展开。
	await tag.click();
	await expect(list.getByRole("listitem")).toHaveText(["host", "steps"]);
	await page.keyboard.press("Escape");
	await expect(list).toBeHidden();

	await page.goto(`/runs/${plain}`);
	await expect(header.getByTestId("run-status")).toBeVisible();
	await expect(header.getByRole("button", { name: /预设/ })).toHaveCount(0);
	await expect(header).not.toContainText("预设");
});

test("运行记录：用了预设的运行在场景名旁边显示预设名（进行中的卡片和历史表格），没用预设的运行和以前一样", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	const preset = await createPreset(controlPlane, scenario, "压测 A 集群", PRESET_PARAMS);
	const done = await trigger(controlPlane, scenario, preset);
	await agent.succeed(await agent.nextAssign());
	const plain = await trigger(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	const running = await trigger(controlPlane, scenario, preset);
	await agent.nextAssign();

	await page.goto("/runs");
	const table = page.getByRole("table", { name: "历史运行" });
	const scenarioCell = (runId: string) =>
		table
			.getByRole("row", { name: new RegExp(runId.slice(0, 8)) })
			.getByRole("cell")
			.nth(1);
	await expect(scenarioCell(done)).toContainText("巡检");
	await expect(scenarioCell(done)).toContainText("预设：压测 A 集群");
	await expect(scenarioCell(plain)).toHaveText("巡检");

	const card = page.getByRole("article", { name: `运行 ${running.slice(0, 8)}` });
	await expect(card).toContainText("巡检");
	await expect(card).toContainText("预设：压测 A 集群");
});
