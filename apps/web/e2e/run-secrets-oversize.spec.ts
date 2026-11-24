import type { Page } from "@playwright/test";
import { type E2eFixtures, expect, test } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing } from "./support";

// 保密值太多的运行（#657）：运行视图（`GET /runs/:id`）带 `secrets_oversize: true` 时，运行抽屉的摘要里写明
// 为什么这次运行里的内容全是掩码；`false` 或没有这个键（绝大多数运行）时不出现。
// 真的让一个运行的保密值大到认不出每一处出现要上百万个字符，e2e 里用路由拦截给运行视图的响应加上这个字段，
// 控制面一侧的条件另有集成测试覆盖（apps/server/test/run-secrets-oversize.test.ts）。

type Oversize = true | false | "absent";

/** 触发一次运行，运行视图的响应里的 `secrets_oversize` 按 `oversize` 改写（"absent" 是去掉这个键），返回运行摘要和拦到的次数。 */
async function summaryWith(
	{
		page,
		controlPlane,
		connectAgent,
	}: {
		page: Page;
		controlPlane: E2eFixtures["controlPlane"];
		connectAgent: E2eFixtures["connectAgent"];
	},
	oversize: Oversize,
) {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	let rewritten = 0;
	await page.route(/\/api\/runs\/[^/?]+(\?.*)?$/, async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		const response = await route.fetch();
		const view = (await response.json()) as Record<string, unknown>;
		if (oversize === "absent") delete view.secrets_oversize;
		else view.secrets_oversize = oversize;
		rewritten += 1;
		return route.fulfill({ response, json: view });
	});

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await agent.nextAssign();
	const summary = drawer.getByRole("region", { name: "运行摘要" });
	// 摘要已经按改写后的响应画出来了（有状态），再断言有没有这句话，不会在加载之前就当作「没有」。
	await expect(summary.getByTestId("summary-status")).toHaveText("运行中");
	expect(rewritten).toBeGreaterThan(0);
	return summary;
}

test("运行视图带 secrets_oversize: true：运行摘要里写明原因，没有任何值", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const summary = await summaryWith({ page, controlPlane, connectAgent }, true);
	const note = summary.getByTestId("secrets-oversize");
	await expect(note).toBeVisible();
	await expect(note).toHaveAttribute("role", "note");
	await expect(note).toContainText("保密参数的值太多或太长");
	await expect(note).toContainText("整段显示为 ******");
	await expect(note).toContainText("缩短或减少保密参数的值之后重新运行");
});

test("运行视图里 secrets_oversize 是 false：运行摘要里没有这句话", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const summary = await summaryWith({ page, controlPlane, connectAgent }, false);
	await expect(summary.getByTestId("secrets-oversize")).toHaveCount(0);
	await expect(summary).not.toContainText("保密参数的值太多或太长");
});

test("运行视图里没有 secrets_oversize 这个键（绝大多数运行）：运行摘要里没有这句话", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const summary = await summaryWith({ page, controlPlane, connectAgent }, "absent");
	await expect(summary.getByTestId("secrets-oversize")).toHaveCount(0);
	await expect(summary).not.toContainText("保密参数的值太多或太长");
});
