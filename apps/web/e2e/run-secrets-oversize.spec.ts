import type { Page } from "@playwright/test";
import { withSecretLimits } from "../../server/test/support/secret-limits.js";
import { type E2eFixtures, expect, test } from "./fixtures";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { createScenario, publishPackage } from "./support";

// 保密值太多的运行（#657）：运行抽屉的摘要里写明为什么这次运行里的内容全是掩码；正常的运行没有这句话。
// 真实的上限（保密参数所有写法合计 100 多万个字符）在 e2e 里碰不到：控制面和测试在同一个进程里，
// 用测试基建的 `withSecretLimits` 把上限调小，走真实的触发、控制面的读取和前端的显示。

/** 保密参数 `api_token`（8 个字符）所有写法的总长超过它，值集合就太大。 */
const TINY = { automatonChars: 8 };

async function triggerWithSecret({
	page,
	controlPlane,
	connectAgent,
}: {
	page: Page;
	controlPlane: E2eFixtures["controlPlane"];
	connectAgent: E2eFixtures["connectAgent"];
}) {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByLabel("host").fill("10.0.0.8");
	await drawer.getByRole("textbox", { name: /^api_token / }).fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await agent.nextAssign();
	const summary = drawer.getByRole("region", { name: "运行摘要" });
	// 摘要已经画出来了（有状态），再断言有没有这句话，不会在加载之前就当作「没有」。
	await expect(summary.getByTestId("summary-status")).toHaveText("运行中");
	return summary;
}

test("保密参数的值太多：运行摘要里写明原因，没有任何值", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await withSecretLimits(TINY, async () => {
		const summary = await triggerWithSecret({ page, controlPlane, connectAgent });
		const note = summary.getByTestId("secrets-oversize");
		await expect(note).toBeVisible();
		await expect(note).toHaveAttribute("role", "note");
		await expect(note).toContainText("保密参数的值太多或太长");
		await expect(note).toContainText("整段显示为 ******");
		await expect(note).toContainText("缩短或减少保密参数的值之后重新运行");
		await expect(note).not.toContainText("tok-live");
	});
});

test("正常的运行（保密参数的值不多）：运行摘要里没有这句话", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const summary = await triggerWithSecret({ page, controlPlane, connectAgent });
	await expect(summary.getByTestId("secrets-oversize")).toHaveCount(0);
	await expect(summary).not.toContainText("保密参数的值太多或太长");
});
