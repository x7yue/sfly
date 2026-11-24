import type { Page } from "@playwright/test";
import { withSecretLimits } from "../../server/test/support/secret-limits.js";
import { type E2eFixtures, expect, test } from "./fixtures";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { createScenario, publishPackage } from "./support";

// 保密值太多的运行（#657）：运行抽屉的摘要里写明为什么这次运行里的内容全是掩码；正常的运行没有这句话。
// 真实的上限（保密参数所有写法合计 100 多万个字符）在 e2e 里碰不到：控制面和测试在同一个进程里，
// 用测试基建的 `withSecretLimits` 把上限调小，走真实的触发、控制面的读取和前端的显示。
// 触发时值集合已经太大会被拒绝（#632，下面第二个用例），所以先触发，再调小上限：和值集合在运行中才变大（子流程创建之后）是同一个状态。

/** 保密参数 `api_token`（8 个字符）所有写法的总长超过它（要超过，不是等于），值集合就太大。 */
const TINY = { automatonChars: 4 };

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
	const assign = await agent.nextAssign();
	const summary = drawer.getByRole("region", { name: "运行摘要" });
	// 摘要已经画出来了（有状态），再断言有没有这句话，不会在加载之前就当作「没有」。
	await expect(summary.getByTestId("summary-status")).toHaveText("运行中");
	return { summary, agent, assign };
}

test("secret 参数的值太多：运行抽屉的摘要和运行监控页都写明原因，没有任何值", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { summary, agent, assign } = await triggerWithSecret({ page, controlPlane, connectAgent });
	await withSecretLimits(TINY, async () => {
		// 任务结束：抽屉收到事件，重新读一份运行视图，这时的值集合已经太大
		await agent.succeed(assign, {});
		const note = summary.getByTestId("secrets-oversize");
		await expect(note).toBeVisible();
		await expect(note).toHaveAttribute("role", "note");
		await expect(note).toContainText("secret 参数的值太多或太长");
		await expect(note).toContainText("整段显示为 ******");
		await expect(note).toContainText("缩短或减少 secret 参数的值之后重新运行");
		await expect(note).not.toContainText("tok-live");

		// 之后从运行记录或通知的链接进来看这次运行的人，在运行监控页也看得到原因（同一句话，概览和详情都有）
		await page
			.getByRole("dialog", { name: "运行 · 巡检" })
			.getByRole("link", { name: "打开运行监控" })
			.click();
		const banner = page.getByTestId("secrets-oversize");
		await expect(banner).toBeVisible();
		await expect(banner).toContainText("secret 参数的值太多或太长");
		await expect(banner).toContainText("整段显示为 ******");
		await expect(banner).not.toContainText("tok-live");
		await page.getByRole("tab", { name: "详情", exact: true }).click();
		await expect(banner).toBeVisible();
	});
});

test("正常的运行（secret 参数的值不多）：运行抽屉的摘要和运行监控页里都没有这句话", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { summary } = await triggerWithSecret({ page, controlPlane, connectAgent });
	await expect(summary.getByTestId("secrets-oversize")).toHaveCount(0);
	await expect(summary).not.toContainText("secret 参数的值太多或太长");
	await page
		.getByRole("dialog", { name: "运行 · 巡检" })
		.getByRole("link", { name: "打开运行监控" })
		.click();
	// 监控页已经画出来了（有顶栏的运行状态），再断言没有，不会在加载之前就当作「没有」
	await expect(page.getByRole("tab", { name: "详情", exact: true })).toBeVisible();
	await expect(page.getByTestId("secrets-oversize")).toHaveCount(0);
});

test("触发时 secret 参数的值已经太多：触发被拒绝，抽屉里写明合计多少、上限多少、怎么办，不产生运行，没有任何值", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);

	await withSecretLimits(TINY, async () => {
		await page.goto("/orchestrations");
		await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
		const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
		await drawer.getByLabel("host").fill("10.0.0.8");
		await drawer.getByRole("textbox", { name: /^api_token / }).fill("tok-live");
		await drawer.getByRole("button", { name: "触发运行" }).click();

		const alert = drawer.getByRole("alert");
		await expect(alert).toContainText("触发失败：这次触发的 secret 参数的值太多或太长");
		await expect(alert).toContainText("超过上限 4 个字符");
		await expect(alert).toContainText("参数 api_token（8 个字符）");
		await expect(alert).toContainText("怎么办");
		await expect(alert).not.toContainText("tok-live");
		// 没有运行摘要：运行没有产生
		await expect(drawer.getByRole("region", { name: "运行摘要" })).toHaveCount(0);
	});
});
