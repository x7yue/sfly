import type { Page } from "@playwright/test";
import { publishPackage as publishStub } from "../../server/test/support/package-archive.js";
import { seedRunIo, storedAs } from "../../server/test/support/seed-run-io.js";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";
import { createScenario, publishPackage, triggerRun } from "./support";

// 运行视图里大的输入、输出只给大小（#633）：控制台的「输入输出」页签写「约 N KB」和「加载」，点了才取全文；
// 加载中、加载失败（可以重试）、加载之后各有自己的样子；运行还在变（事件流推来新的视图）时已经加载的全文不丢。
// 「停止子流程」节点停止的子流程不读运行视图里的输入：合计用完之后再短的输入也只给大小，这一行仍然写得出来。

const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });
const nodeButton = (page: Page, id: string) =>
	timeline(page).locator(`[data-node-row="${id}"] button`);

const BIG = "B".repeat(40_000);

/** 记录页面发出的取全文请求（`GET /api/tasks/:id/io`）。 */
function watchIoRequests(page: Page): string[] {
	const urls: string[] = [];
	page.on("request", (request) => {
		if (/\/api\/tasks\/[^/]+\/io$/.test(new URL(request.url()).pathname)) urls.push(request.url());
	});
	return urls;
}

test("输入输出：大的输出只写大小，点「加载」才取全文；加载后留着，切到别的节点再回来不重新请求", async ({
	page,
	controlPlane,
	clock,
}) => {
	await publishStub(controlPlane, "stub", "1.0.0", { echo: ["text"] });
	const { run } = await seedRunIo(controlPlane, [
		{
			id: "a",
			attempts: [{ inputs: { url: "https://example.test/a" }, outputs: { text: BIG } }],
		},
		{ id: "b", attempts: [{ outputs: { ok: true } }] },
	]);
	const requests = watchIoRequests(page);

	await openMonitor(page, clock, run, "a", "io");

	const io = panel(page).getByRole("tabpanel");
	// 小的输入照常显示；大的输出只写大小（40012 个字节向上取整到 40 KB），没有发取全文的请求。
	await expect(io).toContainText('"url": "https://example.test/a"');
	await expect(io.getByTestId("io-omitted")).toContainText("没有随运行一起返回（约 40 KB）");
	await expect(io).not.toContainText("BBBBBBBB");
	expect(requests).toEqual([]);

	await io.getByRole("button", { name: "加载" }).click();

	await expect(io).toContainText('"text": "BBBBBBBB');
	await expect(io.getByTestId("io-omitted")).toHaveCount(0);
	expect(requests).toHaveLength(1);
	// 切到别的节点再回来：已经加载的在查询缓存里，不再请求。
	await nodeButton(page, "b").click();
	await expect(io).toContainText('"ok": true');
	await nodeButton(page, "a").click();
	await expect(io).toContainText('"text": "BBBBBBBB');
	expect(requests).toHaveLength(1);
});

test("输入输出：加载中显示「加载中…」，失败写原因并可以重试", async ({
	page,
	controlPlane,
	clock,
}) => {
	await publishStub(controlPlane, "stub", "1.0.0", { echo: ["text"] });
	const { run } = await seedRunIo(controlPlane, [
		{ id: "a", attempts: [{ outputs: { text: BIG } }] },
	]);
	let calls = 0;
	let failing = true;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/tasks/*/io", async (route) => {
		calls++;
		// 第一个请求等放行；失败期间每个请求都回 500（5xx 前端自动再试两次，间隔 1 秒），不再失败之后照常。
		if (calls === 1) await gate;
		if (failing) {
			await route.fulfill({
				status: 500,
				contentType: "application/json",
				body: JSON.stringify({ error: { code: "internal", message: "数据库忙" } }),
			});
		} else {
			await route.continue();
		}
	});
	await openMonitor(page, clock, run, "a", "io");
	const io = panel(page).getByRole("tabpanel");

	await io.getByRole("button", { name: "加载" }).click();
	await expect(io.getByRole("button", { name: "加载中…" })).toBeDisabled();
	release();

	await expect(io.getByRole("alert")).toContainText("无法加载：");
	await expect(io.getByRole("button", { name: "重试" })).toBeVisible();
	failing = false;
	await io.getByRole("button", { name: "重试" }).click();
	await expect(io).toContainText('"text": "BBBBBBBB');
	await expect(io.getByRole("alert")).toHaveCount(0);
});

test("输入输出：运行还在变时已经加载的全文不丢（事件流推来新的运行视图）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane);
	const ping = (id: string) => ({
		id,
		kind: "package",
		package: "demo-checks",
		node: "ping",
		inputs: { host: id },
	});
	const scenario = await createScenario(controlPlane, "大输出", {
		default_agent: "agent-a",
		nodes: [{ id: "entry", kind: "entry", params: [] }, ping("a"), ping("b")],
		edges: [
			{ from: "entry", to: "a", kind: "chain" },
			{ from: "a", to: "b", kind: "chain" },
		],
		packages: { "demo-checks": "1.2.0" },
	});
	const runId = await triggerRun(controlPlane, scenario);
	const first = await agent.nextAssign();
	await agent.succeed(first, { alive: true, text: BIG });
	const second = await agent.nextAssign({ start: false });
	await openMonitor(page, clock, runId, "a", "io");
	const io = panel(page).getByRole("tabpanel");
	await io.getByRole("button", { name: "加载" }).click();
	await expect(io).toContainText('"text": "BBBBBBBB');

	// 第二个节点开始、结束：事件流推来新的运行视图（a 的输出在视图里仍然只有大小）。
	await agent.started(second);
	await agent.succeed(second, { alive: true });
	await nodeButton(page, "b").click();
	await expect(io).toContainText('"alive": true');
	await nodeButton(page, "a").click();

	await expect(io).toContainText('"text": "BBBBBBBB');
	await expect(io.getByTestId("io-omitted")).toHaveCount(0);
});

test("「停止子流程」节点：合计用完之后它的输入也只给大小，「停止」那一行仍然写得出来（目标取自运行绑定的版本，不读视图里的输入）", async ({
	page,
	controlPlane,
	clock,
}) => {
	await publishStub(controlPlane, "stub", "1.0.0", { echo: ["text"] });
	const output = storedAs(16 * 1024);
	// 前 40 个节点各有 16 KiB 的输出：内联的合计（1 MiB）在第 32 个节点附近用完；之后是停止子流程的节点，它的输入很短。
	const { run } = await seedRunIo(controlPlane, [
		...Array.from({ length: 40 }, (_, i) => ({
			id: `n${i + 1}`,
			attempts: [{ outputs: output }],
		})),
		{ id: "stop", stopSubflow: "sub", attempts: [{ inputs: { subflow: "sub" }, outputs: {} }] },
	]);
	const view = (await (await controlPlane.fetch(`/runs/${run}`)).json()) as {
		chains: Array<{
			nodes: Array<{
				node_id: string;
				attempts: Array<{ inputs: unknown; inputs_omitted_bytes: number | null }>;
			}>;
		}>;
	};
	const stop = view.chains[0]?.nodes.find((n) => n.node_id === "stop");
	// 前提：视图里这个节点的输入已经被省略了（合计用完）。
	expect(stop?.attempts[0]?.inputs).toBeNull();
	expect(stop?.attempts[0]?.inputs_omitted_bytes).toBe(1024);

	await openMonitor(page, clock, run, "stop", "attempts");

	await expect(panel(page).locator("dt", { hasText: "停止" })).toBeVisible();
});

/** 一个节点 a：输入是 40 000 个字符的字面量（运行视图里输入只给大小），输出由 Agent 上报时决定。 */
async function bigInputRun(controlPlane: Parameters<typeof publishPackage>[0]) {
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "大输入", {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "a", kind: "package", package: "demo-checks", node: "ping", inputs: { host: BIG } },
		],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { "demo-checks": "1.2.0" },
	});
	return triggerRun(controlPlane, scenario);
}

test("输入输出：执行中加载过全文，这次尝试结束、输出也很大：输出一栏是「约 N KB / 加载」，点了取得到（不是「没有输出。」）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 2,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const runId = await bigInputRun(controlPlane);
	const task = await agent.nextAssign();
	await openMonitor(page, clock, runId, "a", "io");
	const io = panel(page).getByRole("tabpanel");
	// 执行中：输入被省略（输入在派发时写下），输出还没有。
	await expect(io.getByTestId("io-omitted")).toContainText("约 40 KB");
	await expect(io).toContainText("节点尚未结束。");
	await io.getByRole("button", { name: "加载" }).click();
	await expect(io).toContainText('"host": "BBBBBBBB');

	// 这次尝试结束、输出也很大：取到的全文是执行中取的（输出那时是 null），不能当作输出为空。
	await agent.succeed(task, { alive: true, text: BIG });

	await expect(io.getByTestId("io-omitted")).toContainText("约 40 KB");
	await expect(io).not.toContainText("没有输出。");
	await io.getByRole("button", { name: "加载" }).click();
	await expect(io).toContainText('"text": "BBBBBBBB');
	await expect(io.getByTestId("io-omitted")).toHaveCount(0);
});

test("输入输出：用键盘按「加载」，焦点留在这一栏里：加载中还在按钮上，加载完在内容上，不落到页面上", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 2,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const runId = await bigInputRun(controlPlane);
	const task = await agent.nextAssign();
	await agent.succeed(task, { alive: true });
	// 取全文的请求扣住，看加载中的样子。
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/tasks/*/io", async (route) => {
		await gate;
		await route.continue();
	});
	await openMonitor(page, clock, runId, "a", "io");
	const io = panel(page).getByRole("tabpanel");
	await io.getByRole("button", { name: "加载" }).focus();

	await page.keyboard.press("Enter");

	// 加载中：按钮写「加载中…」、不能再按，焦点还在它上面（用 disabled 的话焦点会掉到页面上）。
	const loading = io.getByRole("button", { name: "加载中…" });
	await expect(loading).toBeVisible();
	await expect(loading).toBeFocused();
	release();
	await expect(io).toContainText('"host": "BBBBBBBB');
	// 加载完：焦点在这一栏里（加载出来的内容上），不在 body 上：键盘用户不必从页面开头重新 Tab 过来。
	await expect.poll(() => io.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});
