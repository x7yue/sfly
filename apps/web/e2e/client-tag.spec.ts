import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing } from "./support";

// 记录「经哪个 AI 编程助手」（规格 #238）：运行抽屉、运行记录、版本列表在触发人、版本作者旁边显示「经 Claude Code」。
// 命令行带 `x-sfly-client` 请求头，浏览器的请求不带，所以人在浏览器里的操作不显示。

const CLAUDE_CODE = "sfly-cli/0.5.0 agent/claude-code";

const JSON_HEADERS = { "content-type": "application/json" };

/** 像命令行那样写入：带昵称，client 不为空时再带 `x-sfly-client`。 */
async function send(
	cp: TestControlPlane,
	path: string,
	body: unknown,
	nickname: string,
	client?: string,
) {
	const res = await cp.fetch(path, {
		method: "POST",
		headers: {
			...JSON_HEADERS,
			"x-sfly-nickname": encodeURIComponent(nickname),
			...(client ? { "x-sfly-client": client } : {}),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
	return (await res.json()) as { id: string };
}

const triggerAs = (cp: TestControlPlane, scenario: string, client?: string) =>
	send(cp, `/orchestrations/${scenario}/runs`, { params: {} }, "tester", client).then((r) => r.id);

test("运行记录：经 AI 编程助手触发的运行，卡片、历史表格和运行详情页都显示「经 Claude Code」；浏览器里触发的不显示", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));

	const viaDone = await triggerAs(controlPlane, scenario, CLAUDE_CODE);
	await agent.succeed(await agent.nextAssign());
	const byHandDone = await triggerAs(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	const viaRunning = await triggerAs(controlPlane, scenario, "sfly-cli/0.5.0 agent/codex");
	const byHandRunning = await triggerAs(controlPlane, scenario);

	await page.goto("/runs");
	const card = (id: string) => page.getByRole("article", { name: `运行 ${id.slice(0, 8)}` });
	await expect(card(viaRunning)).toContainText("tester 经 Codex 触发");
	await expect(card(byHandRunning)).toContainText("tester 触发");
	await expect(card(byHandRunning)).not.toContainText("经");

	const table = page.getByRole("table", { name: "历史运行" });
	const triggeredBy = (id: string) =>
		table
			.getByRole("row", { name: new RegExp(id.slice(0, 8)) })
			.getByRole("cell")
			.nth(5);
	await expect(triggeredBy(viaDone)).toHaveText("tester 经 Claude Code");
	await expect(triggeredBy(byHandDone)).toHaveText("tester");

	await page.goto(`/runs/${viaDone}`);
	await expect(page.getByRole("banner")).toContainText("tester 经 Claude Code 触发");
	await page.goto(`/runs/${byHandDone}`);
	await expect(page.getByRole("banner")).toContainText("tester 触发");
	await expect(page.getByRole("banner")).not.toContainText("经");
});

/** 让浏览器发出的触发运行请求带上 `x-sfly-client`（模拟经 AI 编程助手发起的触发）；返回的 restore() 之后恢复。 */
async function triggerAsAssistant(page: Page, client: string) {
	const handler = (route: import("@playwright/test").Route) => {
		const request = route.request();
		return request.method() === "POST"
			? route.continue({ headers: { ...request.headers(), "x-sfly-client": client } })
			: route.continue();
	};
	await page.route("**/api/orchestrations/*/runs", handler);
	return { restore: () => page.unroute("**/api/orchestrations/*/runs", handler) };
}

test("运行抽屉：触发请求带 x-sfly-client 时摘要显示「经 Claude Code」；人在浏览器里触发的不显示", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
	await page.goto("/orchestrations");
	const open = async () => {
		await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
		const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
		await expect(drawer.getByRole("list", { name: "触发前检查" })).toContainText(
			"结构与引用检查通过",
		);
		await drawer.getByRole("button", { name: "触发运行" }).click();
		await agent.nextAssign();
		return drawer.getByRole("region", { name: "运行摘要" });
	};

	const assistant = await triggerAsAssistant(page, CLAUDE_CODE);
	const viaSummary = await open();
	await expect(viaSummary).toContainText("tester 经 Claude Code 触发");
	await assistant.restore();
	await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).first().click();
	await expect(page.getByRole("dialog")).toHaveCount(0);

	const summary = await open();
	await expect(summary).toContainText("tester 触发");
	await expect(summary).not.toContainText("经");
});

test("版本列表：经 AI 编程助手保存的版本在作者旁边显示「经 …」，已知的助手显示名称，其他名称原样显示；浏览器里保存的不显示", async ({
	page,
	controlPlane,
}) => {
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
	const save = (base: number, nickname: string, client?: string) =>
		send(
			controlPlane,
			`/orchestrations/${scenario}/versions`,
			{ base_version: base, document: scenarioUsing("agent") },
			nickname,
			client,
		);
	await save(1, "bob", CLAUDE_CODE);
	await save(2, "carol", "sfly-cli/0.5.0 agent/codex");
	await save(3, "dave", "sfly-cli/0.5.0 agent/my-assistant");
	await save(4, "erin");

	await page.goto(`/orchestrations/${scenario}/versions`);
	const row = (n: number) =>
		page
			.getByRole("list", { name: "版本" })
			.getByRole("listitem")
			.filter({ has: page.getByText(`v${n}`, { exact: true }) });
	await expect(row(1)).toContainText("tester ·");
	await expect(row(1)).not.toContainText("经");
	await expect(row(2)).toContainText("bob 经 Claude Code ·");
	await expect(row(3)).toContainText("carol 经 Codex ·");
	await expect(row(4)).toContainText("dave 经 my-assistant ·");
	await expect(row(5)).toContainText("erin ·");
	await expect(row(5)).not.toContainText("经");

	// 默认并排对比最新的两个版本（4 与 5）：每一侧的标题和列表里的行各出现一次。
	await expect(page.getByText(/^dave 经 my-assistant · /)).toHaveCount(2);
	await expect(page.getByText(/^erin · /)).toHaveCount(2);
});
