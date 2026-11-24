import type { Page } from "@playwright/test";
import type { SessionView } from "@sfly/schema";
import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import { FakeAssistant } from "../../server/test/support/fake-assistant.js";
import { seedSession } from "../../server/test/support/sessions.js";
import { eventAt } from "./assistant-support";
import { test as base, expect } from "./fixtures";

// 助手页和会话页对着真的控制面加假助手服务（#541 的 `FakeAssistant`）：开始一个会话 → 跳到会话页 → 依次看到这句话、
// 逐字出现的助手的话、一个工具行、「这一轮完成」；刷新页面时间线和刷新前一样；在做时点「停止」，助手服务收到中止，
// 时间线出现「已停止」；同一个项目另一个会话在做时 `project_busy`。

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

// #544：同一个项目里有别的会话在做时，新的一轮不再被拒绝（409 `project_busy`），而是排队（会话变成 `queued`）。页面那一半
// （排队中的显示、「排在第 N 位」，#544 的第 5 部分，544-C）还没有做：它做的时候把这两条换成排队中的 e2e。
test.fixme("project_busy：同一个项目另一个会话在做时，留住写好的话，给出正在做的那个会话的链接", async ({
	page,
	workbench,
}) => {
	void workbench;
	const running = await startSession(page, "第一个会话");
	await page.goto("/sessions");
	await page.getByRole("textbox", { name: "要做什么？" }).fill("第二个会话的话");
	await page.getByRole("button", { name: "开始" }).click();
	const alert = page.getByRole("alert").filter({ hasText: "另一个会话正在做" });
	await expect(alert).toBeVisible();
	await expect(page.getByRole("textbox", { name: "要做什么？" })).toHaveValue("第二个会话的话");
	const link = alert.getByRole("link", { name: "打开正在做的会话" });
	await expect(link).toHaveAttribute("href", `/sessions/${running}`);
	await link.click();
	await expect(page).toHaveURL(new RegExp(`/sessions/${running}$`));
	await expect(timeline(page).getByTestId("user-message")).toHaveText("tester：第一个会话");
});

test.fixme("接着说遇到 project_busy：同一个项目另一个会话在做时，留住写好的话，给出正在做的那个会话的链接", async ({
	page,
	assistant,
	controlPlane,
	workbench,
}) => {
	void workbench;
	const running = await startSession(page, "正在做的这个");
	const idle = await seedSession(controlPlane.database.url, {
		title: "空闲的这个",
		status: "idle",
		events: [],
	});
	await page.goto(`/sessions/${idle}`);
	await page.getByRole("textbox", { name: "接着说" }).fill("再加一个重试次数");
	await page.getByRole("button", { name: "发送" }).click();
	const alert = page.getByRole("alert").filter({ hasText: "另一个会话正在做" });
	await expect(alert).toBeVisible();
	await expect(page.getByRole("textbox", { name: "接着说" })).toHaveValue("再加一个重试次数");
	await expect(alert.getByRole("link", { name: "打开正在做的会话" })).toHaveAttribute(
		"href",
		`/sessions/${running}`,
	);
	// 助手服务只收到了第一个会话的那一句：被拒绝的话没有交给它。
	expect(assistant.prompts).toHaveLength(1);
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
	// 在做时输入框照常可以写下一句，只是不能发。
	await expect(page.getByRole("textbox", { name: "接着说" })).toBeEnabled();
	await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();

	const view = (await (await page.request.get(`/api/sessions/${id}`)).json()) as SessionView;
	expect(view.status).toBe("running");
});
