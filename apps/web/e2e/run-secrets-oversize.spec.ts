import type { Page } from "@playwright/test";
import { withSecretLimits } from "../../server/test/support/secret-limits.js";
import { type E2eFixtures, expect, test } from "./fixtures";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { createRunPreset } from "./run-presets-support";
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
		await expect(alert).toContainText("参数 api_token（约 1000 个字符）");
		await expect(alert).toContainText("怎么办");
		await expect(alert).not.toContainText("tok-live");
		// 没有运行摘要：运行没有产生
		await expect(drawer.getByRole("region", { name: "运行摘要" })).toHaveCount(0);
	});
});

test("检查清单里 secret 参数太大的一行按当前的选择显示：没选预设是默认值的，选了超限的预设是这个预设的，选了不超限的预设没有；单独一行，不在「不阻止触发」里", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	// api_token 有默认值（超限）；三个预设：把 api_token 固定成超限的值、固定成不超限的值、只固定主机（secret 值和默认值一样）
	const document = {
		...PARAM_SCENARIO,
		nodes: PARAM_SCENARIO.nodes.map((node) =>
			node.kind === "entry"
				? {
						...node,
						params: (node.params as Array<Record<string, unknown>>).map((p) =>
							p.name === "api_token" ? { ...p, required: false, default: "tok-default-value" } : p,
						),
					}
				: node,
		),
	};
	const id = await createScenario(controlPlane, "巡检", document);
	await createRunPreset(controlPlane, id, {
		name: "大预设",
		params: [{ name: "api_token", value: "tok-preset-value" }],
	});
	await createRunPreset(controlPlane, id, {
		name: "小预设",
		params: [{ name: "api_token", value: "ab" }],
	});
	await createRunPreset(controlPlane, id, {
		name: "只有主机",
		params: [{ name: "host", value: "10.0.0.9" }],
	});

	await withSecretLimits(TINY, async () => {
		await page.goto("/orchestrations");
		await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
		const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
		const checks = drawer.getByRole("list", { name: "触发前检查" });
		// 检查清单的一行是 `li[data-state]`（说明列表里的 li 嵌在它里面，不算一行）；Agent 在线，没有别的提醒行
		const row = checks.locator("li[data-state=warn]");
		const select = drawer.getByRole("combobox", { name: "运行预设" });
		await expect(checks).toContainText("结构与引用检查通过");

		// 没选预设：默认值的那一条，写明后果和怎么办；单独一行，不在「不阻止触发」里
		await expect(row).toHaveCount(1);
		await expect(row).toContainText("照默认值触发会被拒绝");
		await expect(row).toContainText("怎么办：缩短这些值");
		await expect(checks).not.toContainText("值得留意，不阻止触发");
		await expect(row).not.toContainText("tok-default-value");
		// 不阻止提交：给 secret 参数一个小的值就能触发
		await expect(drawer.getByRole("button", { name: "触发运行" })).toBeEnabled();

		// 选了超限的预设：这个预设的那一条，默认值的不再显示
		await select.selectOption({ label: "大预设" });
		await expect(row).toHaveCount(1);
		await expect(row).toContainText("用运行预设「大预设」触发会被拒绝");
		await expect(row).not.toContainText("照默认值触发会被拒绝");
		await expect(row).not.toContainText("tok-preset-value");

		// 选了不超限的预设：没有这一行（用的不是默认值）
		await select.selectOption({ label: "小预设" });
		await expect(row).toHaveCount(0);

		// 选了没有改 secret 值的预设：用的还是默认值，默认值的那一条同样适用，标题写明这一点
		await select.selectOption({ label: "只有主机" });
		await expect(row).toHaveCount(1);
		await expect(row).toContainText("用运行预设「只有主机」触发会被拒绝");
		await expect(row).toContainText("它没有改 secret 参数");

		// 不选预设：回到默认值的那一条
		await select.selectOption({ label: "不使用预设" });
		await expect(row).toContainText("照默认值触发会被拒绝");
	});
});
