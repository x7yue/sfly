// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 运行抽屉里的触发前检查显示预检补的三类配置错误（#421）：开发版本没有加载、子流程的参数没有传值、小数接到整数输入。
// 文字要完整显示（不被截断、不丢）；界面的版面不变，复用已有的检查清单和触发失败的提示。

const DEV_MESSAGE =
	"节点 探活（d） 用的是开发版本 demo-dev@dev，但它派发到的 Agent agent-a 没有加载：" +
	"在 agent-a 所在的机器上运行 sfly dev 加载它，或者把这个节点的 Agent 改成已经加载它的 agent-dev";

const devPackage = {
	name: "demo-dev",
	source: "/src/demo-dev",
	metadataJson: JSON.stringify({
		name: "demo-dev",
		version: "dev",
		requires_python: ">=3.10",
		nodes: [
			{
				name: "ping",
				title: "Ping",
				entry: "demo_dev:ping",
				inputs: { type: "object", properties: {}, required: [] },
				outputs: { type: "object", properties: {} },
			},
		],
	}),
};

test("开发版本没有加载：检查清单的节点包版本一行写明节点、Agent 和 sfly dev，不能触发，「前往」选中节点", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await connectAgent({ name: "agent-dev", devPackages: [devPackage] });
	const id = await createScenario(controlPlane, "联调", {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry" },
			{
				id: "d",
				kind: "package",
				package: "demo-dev",
				node: "ping",
				inputs: {},
				display_name: "探活",
			},
		],
		edges: [{ from: "entry", to: "d", kind: "chain" }],
		packages: { "demo-dev": "dev" },
	});

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "联调" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 联调" });
	const checks = drawer.getByRole("list", { name: "触发前检查" });
	await expect(checks).toContainText("节点包版本有 1 个问题");
	const problem = checks.getByText(DEV_MESSAGE);
	await expect(problem).toBeVisible();
	await expect(drawer.getByRole("button", { name: "触发运行" })).toBeDisabled();

	await checks.getByRole("button", { name: "前往 d" }).click();
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${id}\\?node=d$`));
});

test("子流程的参数没有传值：检查清单末尾给提醒，写明节点和参数，不阻止触发", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "汇报", {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "spawn", kind: "async", params: {}, display_name: "派发汇报" },
			{
				id: "sub",
				kind: "subflow_entry",
				name: "汇报",
				params: [{ name: "host", type: "string" }],
			},
			{
				id: "verify",
				kind: "package",
				package: "demo-checks",
				node: "ping",
				inputs: { host: "${{ params.host }}" },
				display_name: "探活",
			},
		],
		edges: [
			{ from: "entry", to: "spawn", kind: "chain" },
			{ from: "sub", to: "verify", kind: "chain" },
			{ from: "spawn", to: "sub", kind: "dispatch" },
		],
		packages: { "demo-checks": "1.2.0" },
	});

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "汇报" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 汇报" });
	const checks = drawer.getByRole("list", { name: "触发前检查" });
	await expect(checks).toContainText("结构与引用检查通过");
	const warning = checks.getByRole("listitem").filter({ hasText: "配置值得留意" });
	await expect(warning).toContainText("有 1 处配置值得留意，不阻止触发");
	await expect(warning).toContainText(
		"节点 派发汇报（spawn） 没有给子流程 汇报（sub） 的参数 host 传值，子流程里的节点 探活（verify） 用到了它，拿到的会是空值（null）：" +
			"在这个节点的参数映射里给 host 传值，或者在子流程入口节点给它设默认值",
	);
	await expect(warning.getByRole("button", { name: "前往 spawn" })).toBeVisible();

	const trigger = drawer.getByRole("button", { name: "触发运行" });
	await expect(trigger).toBeEnabled();
	await trigger.click();
	// 触发成功：抽屉切到运行摘要。子流程里的节点拿到空值，派发时才失败（这正是提醒要提前说的）。
	await expect(drawer.getByRole("region", { name: "运行摘要" })).toBeVisible();
});

test("小数接到整数输入：触发被拒绝，提示写明参数、节点输入和取值来源，改成整数后触发成功", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "探测", {
		default_agent: "agent-a",
		nodes: [
			{
				id: "entry",
				kind: "entry",
				params: [{ name: "expect", type: "number", default: 200 }],
			},
			{
				id: "check",
				kind: "package",
				package: "demo-checks",
				node: "http_check",
				inputs: { url: "http://example.test", expect: "${{ params.expect }}" },
				display_name: "探测",
			},
		],
		edges: [{ from: "entry", to: "check", kind: "chain" }],
		packages: { "demo-checks": "1.2.0" },
	});

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "探测" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 探测" });
	await expect(drawer.getByRole("list", { name: "触发前检查" })).toContainText(
		"结构与引用检查通过",
	);

	await drawer.getByLabel("expect").fill("8.5");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	const alert = drawer.getByRole("alert");
	await expect(alert).toContainText(
		"触发失败：节点 探测（check） 的输入 expect 应为 integer，实际是 8.5（入口参数 expect，触发时给的值）：" +
			"请把 expect 改成 integer 类型的值再触发",
	);

	await drawer.getByLabel("expect").fill("8");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	const task = await agent.nextAssign();
	expect(task.inputs).toMatchObject({ expect: 8 });
});
