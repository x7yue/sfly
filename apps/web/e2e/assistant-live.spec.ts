import type { Page } from "@playwright/test";
import type { SessionView } from "@sfly/schema";
import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import { FakeAssistant } from "../../server/test/support/fake-assistant.js";
import { deleteSession } from "../../server/test/support/sessions.js";
import { eventAt } from "./assistant-support";
import { test as base, expect } from "./fixtures";

// 助手页和会话页对着真的控制面加假助手服务（#541 的 `FakeAssistant`，按协议的表回应）：开始一个会话 → 跳到会话页 → 依次看到这句话、
// 逐字出现的助手的话、一个工具行、「这一轮完成」；刷新页面时间线和刷新前一样；在做时点「停止」，助手服务收到中止，
// 时间线出现「已停止」；同一个项目另一个会话在做时新会话排队、轮到它时自动开始；在做时说话是插话（等待送达、已送到）；停止途中
// 说的话排在这一轮后面；结束会话；排队中点停止是移出队列；会话被删后回到列表（#544）。

const WORKBENCH = "workbench-a";
const USAGE = { input: 10, output: 5, cache_read: 0, cache_write: 0 };

const test = base.extend<{ assistant: FakeAssistant; workbench: FakeAgent }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright 要求 fixture 的第一个参数是解构模式
	assistant: async ({}, use) => {
		const assistant = await FakeAssistant.start();
		try {
			await use(assistant);
		} finally {
			await assistant.close();
		}
	},
	controlPlaneOptions: async ({ assistant }, use) => {
		await use({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			// 停止慢一点的用例（假助手服务的 `stopSettleMs`）里控制面要等得住。
			sessionStopGraceMs: 10_000,
		});
	},
	// 工作台：一台在线的 Agent，上报了能力端口；控制面和助手服务都连上了才算准备好。
	workbench: async ({ connectAgent, controlPlane, assistant }, use) => {
		void controlPlane;
		const agent = await connectAgent({
			name: WORKBENCH,
			peer: { port: 7001, publicAddress: "10.0.0.5" },
		});
		await assistant.connected();
		await use(agent);
	},
});

const timeline = (page: Page) => page.getByRole("list", { name: "会话的时间线" });
const toolRows = (page: Page) => page.getByTestId("tool-row");

/** 在助手页写一句话、点「开始」，等到会话页打开；返回会话 ID。 */
async function startSession(page: Page, text: string): Promise<string> {
	await page.goto("/sessions");
	await expect(page.getByTestId("readiness")).toHaveAttribute("data-ready", "true");
	await page.getByRole("textbox", { name: "要做什么？" }).fill(text);
	await page.getByRole("button", { name: "开始" }).click();
	await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
	return new URL(page.url()).pathname.split("/").pop() as string;
}

/**
 * 等到页面的事件流订阅上了：不持久的事件（思考、文字增量）订阅之前推的就丢了，所以反复推「思考中」，
 * 直到页面上看到它——之后推的增量一定收得到。
 */
async function streamReady(page: Page, assistant: FakeAssistant, id: string) {
	await expect
		.poll(async () => {
			assistant.emit(id, 1, { type: "thinking" }, eventAt());
			return page.getByTestId("thinking").count();
		})
		.toBe(1);
}

test("工作台不在线：就绪状态写明是哪一台工作台不在线，「开始」不可用（真的控制面）", async ({
	page,
}) => {
	// 控制面配置了助手，但工作台的 Agent 没有上线。
	await page.goto("/sessions");
	const readiness = page.getByTestId("readiness");
	await expect(readiness).toHaveAttribute("data-ready", "false");
	await expect(readiness).toContainText(`工作台 ${WORKBENCH} 不在线`);
	await page.getByRole("textbox", { name: "要做什么？" }).fill("做点事");
	await expect(page.getByRole("button", { name: "开始" })).toBeDisabled();
});

test("就绪：可以用 · 工作台在线；输入一句话 → 会话页依次是这句话、逐字出现的话、工具行、「这一轮完成」；刷新后一样", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	await page.goto("/sessions");
	await expect(page.getByTestId("readiness")).toHaveText(`可以用 · 工作台 ${WORKBENCH} 在线`);

	const id = await startSession(page, "给 http_check 加一个超时参数");
	// 这句话（控制面收到时产生）；助手服务收到了这一轮。
	await expect(timeline(page).getByTestId("user-message")).toHaveText(
		"tester：给 http_check 加一个超时参数",
	);
	await expect.poll(() => assistant.prompts.length).toBe(1);
	expect(assistant.prompts[0]?.sessionId).toBe(id);
	await expect(page.getByTestId("session-status")).toHaveText("在做");

	await streamReady(page, assistant, id);
	assistant.emit(id, 1, { type: "assistant_delta", text: "我先看" }, eventAt());
	const said = page.getByTestId("assistant-message");
	await expect(said).toHaveText("我先看");
	assistant.emit(id, 1, { type: "assistant_delta", text: "一下现有的" }, eventAt());
	await expect(said).toHaveText("我先看一下现有的");
	assistant.emit(
		id,
		1,
		{ type: "assistant_message", text: "我先看一下现有的节点。", usage: USAGE },
		eventAt(),
	);
	await expect(said).toHaveText("我先看一下现有的节点。");

	assistant.emit(
		id,
		1,
		{ type: "tool_call", call_id: "call_1", tool: "command", title: "sfly package list" },
		eventAt(),
	);
	const row = toolRows(page).first();
	await expect(row).toContainText("$ sfly package list");
	await expect(row).toHaveAttribute("data-state", "running");
	assistant.emit(
		id,
		1,
		{
			type: "tool_result",
			call_id: "call_1",
			is_error: false,
			text: "http_check 0.3.0\n",
			truncated: false,
			exit_code: 0,
			duration_ms: 420,
		},
		eventAt(),
	);
	await expect(row).toContainText("退出码 0 · 用时 420ms");
	await row.getByRole("button").click();
	await expect(page.getByTestId("tool-result")).toHaveText("http_check 0.3.0");
	await row.getByRole("button").click();

	assistant.emit(
		id,
		1,
		{
			type: "turn_end",
			turn: 1,
			outcome: "completed",
			reason: "助手已完成",
			steps: 1,
			model_calls: 2,
			duration_ms: 84_000,
			usage: USAGE,
		},
		eventAt(),
	);
	await expect(page.getByTestId("turn-end")).toHaveText("这一轮完成 · 1 步 · 用时 1m 24s");
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	await expect(page.getByRole("textbox", { name: "接着说" })).toBeEnabled();

	// 刷新：时间线和刷新前一样（读回的是控制面存下的持久事件）。
	const before = await timeline(page).innerText();
	await page.reload();
	await expect(page.getByTestId("turn-end")).toHaveText("这一轮完成 · 1 步 · 用时 1m 24s");
	expect(await timeline(page).innerText()).toBe(before);
	await expect(toolRows(page)).toHaveCount(1);
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
});

test("在做时点「停止」：助手服务收到中止，时间线出现「已停止」，会话回到空闲", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	const id = await startSession(page, "跑一个很久的命令");
	await streamReady(page, assistant, id);
	assistant.emit(
		id,
		1,
		{ type: "tool_call", call_id: "c", tool: "command", title: "sleep 600" },
		eventAt(),
	);
	await expect(toolRows(page).first()).toHaveAttribute("data-state", "running");

	await page.getByRole("button", { name: "停止" }).click();
	await expect.poll(() => assistant.aborts).toEqual([id]);
	// 这一轮的 turn_end 由助手服务的事件带回来。
	assistant.emit(
		id,
		1,
		{
			type: "turn_end",
			turn: 1,
			outcome: "stopped",
			reason: "用户停止",
			steps: 1,
			model_calls: 1,
			duration_ms: 3000,
			usage: USAGE,
		},
		eventAt(),
	);
	await expect(page.getByTestId("turn-end")).toHaveText("已停止");
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
	await expect(toolRows(page).first()).toHaveAttribute("data-state", "abandoned");
});

test("一轮到了上限、最后一次工具调用只有调用没有结果：这一行写「已中止」，不转圈，也没有空的结果", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	const id = await startSession(page, "跑一个很长的命令");
	await streamReady(page, assistant, id);
	assistant.emit(
		id,
		1,
		{ type: "tool_call", call_id: "c1", tool: "command", title: "sleep 600" },
		eventAt(),
	);
	const row = toolRows(page).first();
	await expect(row).toHaveAttribute("data-state", "running");
	// 助手服务直接发这一轮的结局（到了用时上限），没有这个调用的结果。
	assistant.emit(
		id,
		1,
		{
			type: "turn_end",
			turn: 1,
			outcome: "limit",
			reason: "到了上限",
			steps: 1,
			model_calls: 3,
			duration_ms: 1_200_000,
			usage: USAGE,
			limit_kind: "duration",
		},
		eventAt(),
	);
	await expect(page.getByTestId("turn-end")).toContainText("到了上限");
	await expect(row).toHaveAttribute("data-state", "abandoned");
	await expect(row).toContainText("已中止");
	await expect(row).not.toContainText("在做");
	// 没有结果：可以展开看完整的命令，没有空的结果块。
	await row.getByRole("button").click();
	await expect(row.getByTestId("tool-command")).toHaveText("$ sleep 600");
	await expect(row.getByTestId("tool-result")).toHaveCount(0);
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	// 刷新（历史重放）后还是一样。
	await page.reload();
	await expect(toolRows(page).first()).toHaveAttribute("data-state", "abandoned");
	await expect(toolRows(page).first()).toContainText("已中止");
});

const completed = (turn: number) =>
	({
		type: "turn_end",
		turn,
		outcome: "completed",
		reason: "助手已完成",
		steps: 0,
		model_calls: 1,
		duration_ms: 1000,
		usage: USAGE,
	}) as const;

const statusText = (page: Page) => page.getByTestId("session-status");
const composer = (page: Page) => page.getByRole("textbox", { name: "接着说" });

test("同一个项目另一个会话在做时开始：新会话排队，会话页写排在第 1 位、在等谁，列表里也写；第一个这一轮做完后第二个自动开始，页面跟着变", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	const first = await startSession(page, "第一个会话");
	// 另一个会话照常开始（不再被拒绝）：跳到它的会话页，它在排队。
	const second = await startSession(page, "第二个会话的话");
	await expect(statusText(page)).toHaveText("排队中 · 排在第 1 位");
	await expect(composer(page)).toBeDisabled();
	const note = page.getByTestId("composer-blocked");
	await expect(note).toContainText("排在第 1 位：第一个会话（tester）正在做");
	await expect(note.getByRole("link", { name: "第一个会话" })).toHaveAttribute(
		"href",
		`/sessions/${first}`,
	);
	// 助手服务只收到第一个会话的那一句；排着的话在时间线上，没有交给它。
	expect(assistant.prompts.map((p) => p.sessionId)).toEqual([first]);
	await expect(timeline(page).getByTestId("user-message")).toHaveText("tester：第二个会话的话");
	// 刷新：状态和排位取自会话视图，一样。
	await page.reload();
	await expect(statusText(page)).toHaveText("排队中 · 排在第 1 位");
	await expect(page.getByTestId("composer-blocked")).toContainText("第一个会话（tester）正在做");
	// 列表：在做的和排队的在前，排队的写排在第几位。
	await page.goto("/sessions");
	const rows = page.getByTestId("list-status");
	await expect(rows).toHaveText(["在做", "排队中 · 排在第 1 位"]);
	// 第一个会话的这一轮做完：第二个自动开始。回到它的页面，看到它在做。
	assistant.emit(first, 1, completed(1), eventAt());
	await expect.poll(() => assistant.prompts.map((p) => p.sessionId)).toEqual([first, second]);
	await page.goto(`/sessions/${second}`);
	await expect(statusText(page)).toHaveText("在做");
	await expect(composer(page)).toBeEnabled();
	await expect(page.getByTestId("composer-blocked")).toHaveCount(0);
});

test("在做时说话是插话：时间线标「插话」、等待送达；助手服务收到 steer；送到之后变已送到；这一轮结束后刷新还是已送到", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	const id = await startSession(page, "做第一件事");
	await expect(statusText(page)).toHaveText("在做");
	await composer(page).fill("先别改测试");
	await page.getByRole("button", { name: "发送插话" }).click();
	await expect.poll(() => assistant.steers.length).toBe(1);
	expect(assistant.steers[0]).toMatchObject({
		sessionId: id,
		body: { turn: 1, text: "先别改测试" },
	});
	const said = timeline(page).getByTestId("user-message").filter({ hasText: "先别改测试" });
	await expect(said).toHaveAttribute("data-role", "steer");
	await expect(said.getByTestId("message-role")).toHaveText("插话");
	// 助手服务先发含这句话的 steer_queue、再回 202：页面上是等待送达。
	await expect(said.getByTestId("message-delivery")).toHaveText("等待送达");
	assistant.deliverSteers(id);
	await expect(said.getByTestId("message-delivery")).toHaveText("已送到");
	// 这一轮结束后刷新：steer_queue 不持久，读历史得到的是同一个结果。
	assistant.emit(id, 1, completed(1), eventAt());
	await expect(statusText(page)).toHaveText("空闲");
	await page.reload();
	await expect(
		timeline(page)
			.getByTestId("user-message")
			.filter({ hasText: "先别改测试" })
			.getByTestId("message-delivery"),
	).toHaveText("已送到");
});

test("停止途中说的话：不是插话，标「排在这一轮后面」，输入框不可用；这一轮停下之后自动开始它（第 2 轮），助手服务收到的是这句话", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	const id = await startSession(page, "做第一件事");
	assistant.stopSettleMs = 1_500; // 助手服务停一轮要一会儿：这期间说的话排在这一轮后面
	await page.getByRole("button", { name: "停止" }).click();
	await expect.poll(() => assistant.aborts).toEqual([id]);
	await composer(page).fill("停下来之后的话");
	await page.getByRole("button", { name: "发送插话" }).click();
	const said = timeline(page).getByTestId("user-message").filter({ hasText: "停下来之后的话" });
	await expect(said).toHaveAttribute("data-role", "behind");
	await expect(said.getByTestId("message-role")).toHaveText("排在这一轮后面");
	await expect(composer(page)).toBeDisabled();
	await expect(page.getByTestId("composer-blocked")).toContainText("这一轮正在停止");
	// 助手服务没有收到过这句话的插话：它排在后面，不是插话。
	expect(assistant.steers).toHaveLength(0);
	// 这一轮停下来（助手服务带回结局）：控制面开始排着的话。
	await expect.poll(() => assistant.prompts.length, { timeout: 10_000 }).toBe(2);
	expect(assistant.prompts[1]?.body).toMatchObject({ turn: 2, text: "停下来之后的话" });
	await expect(said).toHaveAttribute("data-role", "turn");
	await expect(statusText(page)).toHaveText("在做");
	await expect(composer(page)).toBeEnabled();
});

test("停止途中说了话、再点一次停止（按钮写「撤掉排着的话」）：撤掉那句话，这一轮停完之后会话回到空闲，没有第 2 轮", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	const id = await startSession(page, "做第一件事");
	assistant.stopSettleMs = 1_500;
	await page.getByRole("button", { name: "停止" }).click();
	await expect.poll(() => assistant.aborts).toEqual([id]);
	await composer(page).fill("说错了的话");
	await page.getByRole("button", { name: "发送插话" }).click();
	const said = timeline(page).getByTestId("user-message").filter({ hasText: "说错了的话" });
	await expect(said).toHaveAttribute("data-role", "behind");
	await page.getByRole("button", { name: "撤掉排着的话" }).click();
	await expect(said).toHaveAttribute("data-role", "cancelled");
	await expect(page.getByTestId("notice")).toHaveText("这句话排队时被取消了，没有交给助手");
	// 这一轮停完：会话空闲，助手服务没有收到第 2 轮。
	await expect(statusText(page)).toHaveText("空闲", { timeout: 10_000 });
	expect(assistant.prompts).toHaveLength(1);
	await expect(composer(page)).toBeEnabled();
});

test("排队中点「停止」是移出队列：会话回到空闲，时间线上有「这句话排队时被取消了」，在做的那个会话不受影响", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	const first = await startSession(page, "第一个会话");
	await startSession(page, "第二个会话的话");
	await expect(statusText(page)).toHaveText("排队中 · 排在第 1 位");
	await page.getByRole("button", { name: "停止" }).click();
	await expect(statusText(page)).toHaveText("空闲");
	await expect(page.getByTestId("notice")).toHaveText("这句话排队时被取消了，没有交给助手");
	await expect(
		timeline(page).getByTestId("user-message").filter({ hasText: "第二个会话的话" }),
	).toHaveAttribute("data-role", "cancelled");
	await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
	// 在做的那个会话照常在做。
	expect(assistant.prompts.map((p) => p.sessionId)).toEqual([first]);
	await page.goto(`/sessions/${first}`);
	await expect(statusText(page)).toHaveText("在做");
});

test("结束会话：确认之后助手服务收到 end，会话页写会话已结束（谁）、没有输入框和按钮；刷新、列表里一样", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	const id = await startSession(page, "做第一件事");
	await page.getByRole("button", { name: "结束会话" }).click();
	const dialog = page.getByRole("dialog", { name: "结束这个会话？" });
	await expect(dialog).toContainText("结束之后不能再说话");
	await dialog.getByRole("button", { name: "结束会话" }).click();
	// 在做的一轮先停止（助手服务带回结局），再写 session_ended，之后才发 end。
	await expect(statusText(page)).toHaveText("已结束");
	await expect(page.getByTestId("session-ended")).toHaveText("会话已结束（tester）");
	await expect.poll(() => assistant.ends).toEqual([id]);
	await expect(composer(page)).toHaveCount(0);
	await expect(page.getByRole("button", { name: "结束会话" })).toHaveCount(0);
	await page.reload();
	await expect(statusText(page)).toHaveText("已结束");
	await expect(page.getByTestId("session-ended")).toHaveText("会话已结束（tester）");
	await page.goto("/sessions");
	await expect(page.getByTestId("list-status")).toHaveText("已结束");
});

test("会话已经没有了：结束时控制面回 404，回到列表，写一句", async ({
	page,
	controlPlane,
	workbench,
}) => {
	void workbench;
	const id = await startSession(page, "做第一件事");
	await deleteSession(controlPlane.database.url, id);
	await page.getByRole("button", { name: "结束会话" }).click();
	await page
		.getByRole("dialog", { name: "结束这个会话？" })
		.getByRole("button", { name: "结束会话" })
		.click();
	await expect(page).toHaveURL(/\/sessions\/?$/);
	await expect(
		page.locator("[data-sonner-toast]").filter({ hasText: "这个会话已经没有了" }),
	).toBeVisible();
});

test("接着说：一轮结束后发一句，助手服务收到第 2 轮；会话页和列表都更新", async ({
	page,
	assistant,
	workbench,
}) => {
	void workbench;
	const id = await startSession(page, "先做第一件事");
	assistant.emit(
		id,
		1,
		{
			type: "turn_end",
			turn: 1,
			outcome: "completed",
			reason: "助手已完成",
			steps: 0,
			model_calls: 1,
			duration_ms: 1000,
			usage: USAGE,
		},
		eventAt(),
	);
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	await page.getByRole("textbox", { name: "接着说" }).fill("再做第二件事");
	await page.getByRole("button", { name: "发送" }).click();
	await expect(timeline(page).getByTestId("user-message")).toHaveText([
		"tester：先做第一件事",
		"tester：再做第二件事",
	]);
	// 控制面写下这句话之后才把这一轮交给助手服务：页面上先看到话，助手服务收到命令稍晚一点。
	await expect.poll(() => assistant.prompts.length).toBe(2);
	expect(assistant.prompts[1]?.body).toMatchObject({ turn: 2, text: "再做第二件事" });
	await expect(page.getByTestId("session-status")).toHaveText("在做");
	// 在做时输入框照常可以写下一句：发出去的是插话（还没写话时「发送插话」不可用）。
	await expect(page.getByRole("textbox", { name: "接着说" })).toBeEnabled();
	await expect(page.getByRole("button", { name: "发送插话" })).toBeDisabled();

	const view = (await (await page.request.get(`/api/sessions/${id}`)).json()) as SessionView;
	expect(view.status).toBe("running");
});
