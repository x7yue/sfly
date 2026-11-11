import type { Page } from "@playwright/test";
import { nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";
import { stoppingRun } from "./stop-subflow-scenario";
import { createScenario, publishPackage } from "./support";

// 停止子流程节点（#85，SEMANTICS §4.1）：添加节点、按名称选择子流程（只列出合法候选）、校验警告；
// 运行后运行监控页与画布运行状态显示「已停止」，并能看到停止子流程节点在等哪个子流程。

const addMenu = (page: Page) => page.getByRole("dialog", { name: "添加节点" });
const inspector = (page: Page) => page.getByRole("complementary", { name: "检查器" });
const target = (page: Page) => inspector(page).getByRole("combobox", { name: "要停止的子流程" });
const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });

const ping = (id: string) => ({
	id,
	kind: "package",
	package: "demo-checks",
	node: "ping",
	inputs: { host: id },
});

test("添加停止子流程节点：检查器只列出本链在它之前触发的子流程，按名称选择后卡片显示子流程名称；没有选择时警告", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	// early 在触发子流程的 spawn 之前，还没有选择子流程。
	const id = await createScenario(controlPlane, "压测期间监控", {
		default_agent: "agent-linux",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "early", kind: "stop_subflow" },
			{ id: "spawn", kind: "async", params: {} },
			ping("load"),
			{ id: "mon", kind: "subflow_entry", name: "监控", params: [] },
			ping("watch"),
		],
		edges: [
			{ from: "entry", to: "early", kind: "chain" },
			{ from: "early", to: "spawn", kind: "chain" },
			{ from: "spawn", to: "load", kind: "chain" },
			{ from: "spawn", to: "mon", kind: "dispatch" },
			{ from: "mon", to: "watch", kind: "chain" },
		],
		packages: { "demo-checks": "1.2.0" },
	});
	await page.goto(`/orchestrations/${id}`);
	await expect(nodeCard(page, "early")).toContainText("停止子流程");
	await expect(nodeCard(page, "early")).toContainText("未选择子流程");
	await expect(nodeCard(page, "early")).toContainText("1 警告");

	// 校验面板列出新警告。
	await page.getByRole("button", { name: "1 条警告" }).click();
	await expect(inspector(page)).toContainText("停止子流程节点 early 没有选择子流程");

	// early 之前没有触发任何子流程：没有可选的子流程。
	await nodeCard(page, "early").click();
	await expect(target(page).getByRole("option")).toHaveText(["本链在这里之前没有触发子流程"]);
	await expect(inspector(page)).toContainText("停止子流程节点 early 没有选择子流程");

	// 焦点在链尾 load 上按 Tab 添加：接在主链末尾，能选择 spawn 触发的「监控」。
	await nodeCard(page, "load").click();
	await page.keyboard.press("Tab");
	await addMenu(page)
		.getByRole("option", { name: /停止子流程/ })
		.click();
	await expect(nodeCard(page, "stop_subflow_1")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByRole("button", { name: "2 条警告" })).toBeVisible();
	await expect(target(page).getByRole("option")).toHaveText(["选择子流程", "监控"]);
	await target(page).selectOption({ label: "监控" });
	await expect(nodeCard(page, "stop_subflow_1")).toContainText("停止「监控」");
	await expect(page.getByRole("button", { name: "1 条警告" })).toBeVisible();
	// 可以设为 always。
	await inspector(page).getByRole("tab", { name: "执行" }).click();
	await expect(inspector(page).getByRole("switch", { name: "always" })).toBeVisible();
});

test("运行后显示「已停止」：监控页看到子流程名称和停止子流程节点在等哪个子流程，子流程结束后运行成功；画布运行状态一致", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId, finish } = await stoppingRun(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "stop");
	const tl = timeline(page);
	await expect(tl.getByRole("button", { name: /子流程 监控 · / })).toBeVisible();
	await expect(page.getByRole("list", { name: "各链状态" })).toContainText("监控 ·");
	await expect(tl.getByRole("button", { name: "stop 停止子流程「监控」 等待中" })).toBeVisible();

	// 底部面板的尝试里也写着停止的是哪个子流程。
	await page.getByRole("region", { name: "底部面板" }).getByRole("tab", { name: "尝试" }).click();
	await expect(page.getByRole("article", { name: "stop 第 1 次尝试" })).toContainText(
		"停止子流程 监控",
	);

	await finish();
	await expect(page.getByRole("banner").getByTestId("run-status")).toHaveText("成功");

	await expect(tl.getByRole("button", { name: /^watch .* 已停止$/ })).toBeVisible();
	await expect(tl.getByRole("button", { name: /^flush .* 成功$/ })).toBeVisible();
	await expect(tl.getByRole("button", { name: "stop 停止子流程「监控」 成功" })).toBeVisible();

	await page.goto(`/orchestrations/${scenarioId}`);
	await page
		.getByRole("group", { name: "模式" })
		.getByRole("button", { name: /运行状态/ })
		.click();
	await expect(nodeCard(page, "watch")).toHaveAttribute("data-run", "stopped");
	await expect(nodeCard(page, "watch")).toContainText("已停止");
	await expect(nodeCard(page, "stop")).toContainText("停止「监控」");
	await expect(page.getByRole("region", { name: "子流程 监控" })).toContainText("成功");
});
