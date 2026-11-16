import type { Locator, Page } from "@playwright/test";
import type { AssignedTask, FakeAgent } from "../../server/test/support/fake-agent.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { dock, edge, inspector, nodeCard } from "./editor-support";
import { type E2eFixtures, expect, test } from "./fixtures";
import { createScenario, publishPackage, triggerRun } from "./support";

// 编排画布运行状态的「跟随执行」（F）和连线的流动：连线只在刚变成执行中时流动两遍，跟随执行只移动镜头。

const ping = (id: string, x: number, y: number) => ({
	id,
	kind: "package",
	package: "demo-checks",
	node: "ping",
	inputs: { host: id },
	position: { x, y },
});

/**
 * 主链 entry → n1 → n2 → spawn → n3，spawn 触发的子流程「监控」mon → watch 在下面一行。
 * n1 和 n2 隔得很远：n2 开始执行时 n1 已经在视野外，镜头必须移动才能框住它。
 */
const FOLLOW_SCENARIO = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } },
		ping("n1", 252, 0),
		ping("n2", 1500, 0),
		{ id: "spawn", kind: "async", params: {}, position: { x: 1752, y: 0 } },
		ping("n3", 2004, 0),
		{ id: "mon", kind: "subflow_entry", name: "监控", params: [], position: { x: 1656, y: 230 } },
		ping("watch", 1908, 230),
	],
	edges: [
		{ from: "entry", to: "n1", kind: "chain" },
		{ from: "n1", to: "n2", kind: "chain" },
		{ from: "n2", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "n3", kind: "chain" },
		{ from: "spawn", to: "mon", kind: "dispatch" },
		{ from: "mon", to: "watch", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
};

/** 触发运行：n1 执行中，之后由测试逐个推进。 */
async function startRun(controlPlane: TestControlPlane, connectAgent: E2eFixtures["connectAgent"]) {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "跟随执行", FOLLOW_SCENARIO);
	const runId = await triggerRun(controlPlane, scenarioId);
	const n1 = await agent.nextAssign();
	return { agent, scenarioId, runId, n1 };
}

/** 收下 n 个新派发的任务，按节点 ID 索引。 */
async function assigns(agent: FakeAgent, n: number) {
	const tasks: Record<string, AssignedTask> = {};
	for (let i = 0; i < n; i++) {
		const task = await agent.nextAssign();
		tasks[task.nodeId] = task;
	}
	return tasks;
}

/** 从 n2 执行中推进到运行结束：n2 之后 n3 与子流程里的 watch 同时执行，全部成功。 */
async function finishRun(agent: FakeAgent, n2: AssignedTask) {
	await agent.succeed(n2);
	const rest = await assigns(agent, 2);
	await agent.succeed(rest.n3 as AssignedTask);
	await agent.succeed(rest.watch as AssignedTask);
}

const openRun = async (page: Page, scenarioId: string, runId: string) => {
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(followButton(page)).toBeVisible();
};

const followButton = (page: Page) => dock(page).getByRole("button", { name: "跟随执行" });

/** 浏览器里记住的跟随执行的选择：1 打开，0 关闭，没选过时没有。 */
const storedFollow = (page: Page) =>
	page.evaluate(() => localStorage.getItem("sfly.canvas.follow"));

/**
 * 这些元素是不是都框在可见区域里（检查器左边、工具条上面），整体水平居中在检查器左边的那一块：
 * 检查器左边的可见区域，左右两侧的边距相同，所以中心在检查器左边缘的一半。
 */
async function framed(page: Page, targets: Locator[]) {
	const [panel, toolbar, ...boxes] = await Promise.all([
		inspector(page).boundingBox(),
		dock(page).boundingBox(),
		...targets.map((t) => t.boundingBox()),
	]);
	if (!panel || !toolbar || boxes.some((b) => b === null)) return false;
	const shown = boxes as NonNullable<(typeof boxes)[number]>[];
	const left = Math.min(...shown.map((b) => b.x));
	const right = Math.max(...shown.map((b) => b.x + b.width));
	const top = Math.min(...shown.map((b) => b.y));
	const bottom = Math.max(...shown.map((b) => b.y + b.height));
	const inside = left >= 0 && right <= panel.x && top >= 0 && bottom <= toolbar.y;
	return inside && Math.abs((left + right) / 2 - panel.x / 2) <= 2;
}

const region = (page: Page) => page.getByRole("region", { name: "子流程 监控" });

test("跟随执行：打开时镜头框住执行中的节点；执行前沿变化后镜头平移到新的节点，选中的节点不变", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { agent, scenarioId, runId, n1 } = await startRun(controlPlane, connectAgent);
	await openRun(page, scenarioId, runId);
	await expect(nodeCard(page, "n1")).toHaveAttribute("data-run", "running");
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => framed(page, [nodeCard(page, "n1")])).toBe(true);

	await nodeCard(page, "n1").click();
	await expect(nodeCard(page, "n1")).toHaveAttribute("aria-pressed", "true");

	await agent.succeed(n1);
	const afterN1 = await assigns(agent, 1);
	await expect(nodeCard(page, "n2")).toHaveAttribute("data-run", "running");
	await expect.poll(() => framed(page, [nodeCard(page, "n2")]), { timeout: 10_000 }).toBe(true);
	// 只移动了镜头：选中的还是 n1，检查器显示的也是它。
	await expect(nodeCard(page, "n1")).toHaveAttribute("aria-pressed", "true");
	await expect(nodeCard(page, "n2")).toHaveAttribute("aria-pressed", "false");
	await expect(inspector(page).getByTestId("run-summary")).toBeVisible();
	await expect(inspector(page)).toContainText("n1");

	// n2 结束后主链上的 n3 与子流程里的 watch 一起执行：n3 连同子流程区域都框在视野里。
	await agent.succeed(afterN1.n2 as AssignedTask);
	await assigns(agent, 2);
	await expect(nodeCard(page, "n3")).toHaveAttribute("data-run", "running");
	await expect(nodeCard(page, "watch")).toHaveAttribute("data-run", "running");
	await expect
		.poll(() => framed(page, [nodeCard(page, "n3"), region(page)]), { timeout: 10_000 })
		.toBe(true);
	await expect(nodeCard(page, "n1")).toHaveAttribute("aria-pressed", "true");
});

test("拖动画布就停止跟随并播报，按 F 恢复；键盘选到视野外的节点时镜头跟过去并暂停跟随；运行结束后按钮关闭", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { agent, scenarioId, runId, n1 } = await startRun(controlPlane, connectAgent);
	await openRun(page, scenarioId, runId);
	await expect.poll(() => framed(page, [nodeCard(page, "n1")])).toBe(true);
	const announcements = page.getByRole("status").filter({ hasText: "跟随执行" });

	// 拖动画布：停止跟随，读屏收到播报。
	await page.mouse.move(300, 700);
	await page.mouse.down();
	await page.mouse.move(380, 720, { steps: 6 });
	await page.mouse.up();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	await expect(announcements).toHaveText("已停止跟随执行，按 F 恢复");

	// 之后执行推进到 n2，F 恢复：镜头框住 n2。
	await agent.succeed(n1);
	const afterN1 = await assigns(agent, 1);
	await expect(nodeCard(page, "n2")).toHaveAttribute("data-run", "running");
	await page.keyboard.press("f");
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => framed(page, [nodeCard(page, "n2")]), { timeout: 10_000 }).toBe(true);

	// 键盘：方向键选中入口，它在视野外，镜头平移过去并暂停跟随；选中的节点是入口，F 恢复后选中不变。
	await page.locator("[data-canvas-region]").focus();
	await page.keyboard.press("ArrowRight");
	await expect(nodeCard(page, "entry")).toHaveAttribute("aria-pressed", "true");
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	await expect(announcements).toHaveText("镜头已移到选中的节点，已停止跟随执行，按 F 恢复");
	await expect.poll(() => framed(page, [nodeCard(page, "entry")])).toBe(true);
	await page.keyboard.press("f");
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => framed(page, [nodeCard(page, "n2")]), { timeout: 10_000 }).toBe(true);
	await expect(nodeCard(page, "entry")).toHaveAttribute("aria-pressed", "true");

	// 运行结束：跟随自动关闭，按钮不能再按下，F 也不再生效。「仍是 aria-pressed=false」证明不了 F 没生效（结束后本来就是
	// false），所以先用按钮把选择关掉（记在浏览器里：0），结束后按 F：生效的话会把选择改成 1。
	await followButton(page).click();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	expect(await storedFollow(page)).toBe("0");
	await finishRun(agent, afterN1.n2 as AssignedTask);
	await expect(followButton(page)).toBeDisabled();
	await page.keyboard.press("f");
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	expect(await storedFollow(page)).toBe("0");
});

test("点工具条的缩放按钮也停止跟随并播报，按 F 恢复", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { scenarioId, runId } = await startRun(controlPlane, connectAgent);
	await openRun(page, scenarioId, runId);
	await expect.poll(() => framed(page, [nodeCard(page, "n1")])).toBe(true);

	await dock(page).getByRole("button", { name: "放大" }).click();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByRole("status").filter({ hasText: "跟随执行" })).toHaveText(
		"已停止跟随执行，按 F 恢复",
	);
	await page.keyboard.press("f");
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => framed(page, [nodeCard(page, "n1")])).toBe(true);
});

test("拖动画布、缩放、键盘选到视野外只在当前页面停止跟随：不写进浏览器，刷新后仍跟随；按钮和 F 的切换才记住", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { agent, scenarioId, runId, n1 } = await startRun(controlPlane, connectAgent);
	// n2 在远处执行：入口在视野外，键盘选到它时镜头要平移过去。
	await agent.succeed(n1);
	await assigns(agent, 1);
	await openRun(page, scenarioId, runId);
	await expect.poll(() => framed(page, [nodeCard(page, "n2")])).toBe(true);
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");

	// 拖动画布。
	await page.mouse.move(300, 700);
	await page.mouse.down();
	await page.mouse.move(380, 720, { steps: 6 });
	await page.mouse.up();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	expect(await storedFollow(page)).toBeNull();
	await page.reload();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => framed(page, [nodeCard(page, "n2")])).toBe(true);

	// 工具条的缩放按钮。
	await dock(page).getByRole("button", { name: "放大" }).click();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	expect(await storedFollow(page)).toBeNull();
	await page.reload();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => framed(page, [nodeCard(page, "n2")])).toBe(true);

	// 键盘选到视野外的节点：入口在视野外，镜头平移过去并暂停跟随。
	await page.locator("[data-canvas-region]").focus();
	await page.keyboard.press("ArrowRight");
	await expect(nodeCard(page, "entry")).toHaveAttribute("aria-pressed", "true");
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	expect(await storedFollow(page)).toBeNull();
	await page.reload();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");

	// 停止之后按 F 恢复；按钮和 F 是用户的切换，这时才写进浏览器：F 记成打开，按钮关掉记成关闭，刷新后仍然关着。
	await dock(page).getByRole("button", { name: "放大" }).click();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	await page.keyboard.press("f");
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");
	expect(await storedFollow(page)).toBe("1");
	await followButton(page).click();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	expect(await storedFollow(page)).toBe("0");
	await page.reload();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
});

test("跟随执行第一次默认打开，之后记住这个浏览器里上次的选择，刷新后保持；运行结束自动关闭不改这个选择", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { agent, scenarioId, runId, n1 } = await startRun(controlPlane, connectAgent);
	await openRun(page, scenarioId, runId);
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");

	await followButton(page).click();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	await page.reload();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");

	await page.keyboard.press("f");
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");
	await page.reload();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");

	// 运行结束后自动关闭，再触发一次运行，打开时仍然跟随。
	await agent.succeed(n1);
	await finishRun(agent, (await assigns(agent, 1)).n2 as AssignedTask);
	await expect(followButton(page)).toBeDisabled();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "false");
	const next = await triggerRun(controlPlane, scenarioId);
	await agent.nextAssign();
	await openRun(page, scenarioId, next);
	await expect(followButton(page)).toBeEnabled();
	await expect(followButton(page)).toHaveAttribute("aria-pressed", "true");
});

test("连线：已经在执行的连线是静止的实线，刚变成执行中的那一段青色虚线流动两遍后变回实线", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const { agent, scenarioId, runId, n1 } = await startRun(controlPlane, connectAgent);
	await page.addInitScript(() => {
		const events: { type: string; name: string; edge: string }[] = [];
		(window as unknown as { edgeAnimations: typeof events }).edgeAnimations = events;
		for (const type of ["animationstart", "animationiteration", "animationend"]) {
			document.addEventListener(
				type,
				(event) => {
					const target = event.target as Element | null;
					const edge = target?.getAttribute?.("data-edge");
					if (edge) events.push({ type, name: (event as AnimationEvent).animationName, edge });
				},
				true,
			);
		}
	});
	const recorded = (id: string) =>
		page.evaluate(
			(wanted) =>
				(
					window as unknown as { edgeAnimations: { type: string; name: string; edge: string }[] }
				).edgeAnimations
					.filter((e) => e.edge === wanted && e.name === "edge-enter")
					.map((e) => e.type),
			id,
		);

	await openRun(page, scenarioId, runId);
	await expect(edge(page, "chain:entry->n1")).toHaveAttribute("data-run", "live");
	await expect(edge(page, "chain:entry->n1")).toHaveCSS("animation-name", "none");
	await expect(edge(page, "chain:entry->n1")).toHaveCSS("stroke-dasharray", "none");

	await agent.succeed(n1);
	await assigns(agent, 1);
	await expect(edge(page, "chain:n1->n2")).toHaveAttribute("data-run", "live");
	await expect(edge(page, "chain:n1->n2")).toHaveCSS("animation-name", "edge-enter");
	await expect(edge(page, "chain:n1->n2")).toHaveCSS("animation-iteration-count", "2");
	await expect
		.poll(() => recorded("chain:n1->n2"), { timeout: 10_000 })
		.toEqual(["animationstart", "animationiteration", "animationend"]);
	await expect(edge(page, "chain:n1->n2")).toHaveCSS("stroke-dasharray", "none");
	// 页面打开时就在执行的那一段，从头到尾没有流动过。
	expect(await recorded("chain:entry->n1")).toEqual([]);
});

test("减少动效时连线不流动", async ({ page, controlPlane, connectAgent }) => {
	const { agent, scenarioId, runId, n1 } = await startRun(controlPlane, connectAgent);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await openRun(page, scenarioId, runId);
	await expect(edge(page, "chain:entry->n1")).toHaveAttribute("data-run", "live");

	await agent.succeed(n1);
	await assigns(agent, 1);
	await expect(edge(page, "chain:n1->n2")).toHaveAttribute("data-run", "live");
	await expect(edge(page, "chain:n1->n2")).toHaveCSS("animation-name", "none");
	await expect(edge(page, "chain:n1->n2")).toHaveCSS("stroke-dasharray", "none");
	expect(await edge(page, "chain:n1->n2").evaluate((el) => el.getAnimations().length)).toBe(0);
});

test("快捷键面板列出编排画布的「跟随执行」F", async ({ page, controlPlane, connectAgent }) => {
	const { scenarioId, runId } = await startRun(controlPlane, connectAgent);
	await openRun(page, scenarioId, runId);
	await page.keyboard.press("?");
	const panel = page.getByRole("dialog", { name: "快捷键" });
	await expect(panel).toBeVisible();
	const row = panel
		.getByRole("region", { name: "编排画布" })
		.locator("dl > div")
		.filter({ has: page.getByRole("term").filter({ hasText: /^跟随执行$/ }) });
	await expect(row).toHaveText("跟随执行F");
});
