import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { SessionEvent, SessionEventBody } from "@sfly/schema";
import { seedSession } from "../../server/test/support/sessions.js";
import {
	apiError,
	assistantMessage,
	fulfillJson,
	installSessionStream,
	pushEvent,
	READY,
	sessionView,
	streamOpens,
	stubSessionDetail,
	stubSessionList,
	toolCall,
	toolResult,
	turnEnd,
	turnStarted,
	userMessage,
} from "./assistant-support";
import { expect, test } from "./fixtures";

// 助手页和会话页（#542）：导航和快捷键、就绪状态、新建会话、会话列表、会话的时间线（逐字出现、工具行、一轮结束）、
// 停止、接着说。控制面是真的（读出来的会话和事件是库里的）；会话的写接口和助手服务在 #541 的第二个 PR 之前还没有，
// 写接口在这里被拦截，实时事件由测试推。

const timeline = (page: Page) => page.getByRole("list", { name: "会话的时间线" });
const assistantInput = (page: Page) => page.getByRole("textbox", { name: "要做什么？" });
const composer = (page: Page) => page.getByRole("textbox", { name: "接着说" });
const toolRows = (page: Page) => page.getByTestId("tool-row");

// ---------------------------------------------------------------- 导航

test("导航里有「助手」，快捷键 G I 能跳过去，面包屑写助手", async ({ page }) => {
	await page.goto("/");
	const nav = page.getByRole("navigation", { name: "主导航" });
	await expect(nav.getByRole("link", { name: "助手" })).toBeVisible();
	await page.keyboard.press("g");
	await page.keyboard.press("i");
	await expect(page).toHaveURL(/\/sessions\/?$/);
	await expect(page.getByRole("heading", { level: 1, name: "助手" })).toBeVisible();
	await expect(nav.getByRole("link", { name: "助手" })).toHaveAttribute("aria-current", "page");
	await expect(page.getByRole("navigation", { name: "面包屑" })).toContainText("助手");
});

// ---------------------------------------------------------------- 助手页

test("没有配置助手：就绪状态写明原因，「开始」不可用，输入框照常可以写；没有会话时一句说明", async ({
	page,
}) => {
	await page.goto("/sessions");
	const readiness = page.getByTestId("readiness");
	await expect(readiness).toHaveAttribute("data-ready", "false");
	await expect(readiness).toContainText("现在不能用：");
	await expect(readiness).toContainText("助手没有开启");
	// 缺的每一条都写出来，不只认某一种。
	await expect(readiness.getByRole("listitem")).toHaveCount(2);

	const input = assistantInput(page);
	await input.fill("给 http_check 加一个超时参数");
	await expect(input).toHaveValue("给 http_check 加一个超时参数");
	await expect(page.getByRole("button", { name: "开始" })).toBeDisabled();
	await expect(page.getByTestId("cannot-start")).toContainText("助手现在不能用，不能开始会话");

	await expect(page.getByRole("heading", { name: "还没有会话" })).toBeVisible();
	await expect(page.getByText("在上面说一句话，助手就会开始。")).toBeVisible();
});

test("就绪：「可以用 · 工作台 X 在线」；工作台不在线时逐条写缺什么，写明是哪一台", async ({
	page,
}) => {
	await stubSessionList(page, READY);
	await page.goto("/sessions");
	await expect(page.getByTestId("readiness")).toHaveText("可以用 · 工作台 bench-1 在线");
	await expect(page.getByRole("button", { name: "开始" })).toBeDisabled(); // 还没写话
	await assistantInput(page).fill("做点事");
	await expect(page.getByRole("button", { name: "开始" })).toBeEnabled();

	await page.unroute("**/api/projects/*/sessions");
	await stubSessionList(page, {
		ready: false,
		workbench: "bench-1",
		problems: [
			{ kind: "workbench_offline", message: "工作台的 Agent 不在线" },
			{ kind: "assistant_unreachable", message: "助手服务连不上" },
		],
	});
	await page.reload();
	const readiness = page.getByTestId("readiness");
	await expect(readiness.getByRole("listitem")).toHaveText([
		"工作台 bench-1 不在线",
		"助手服务连不上",
	]);
	await assistantInput(page).fill("做点事");
	await expect(page.getByRole("button", { name: "开始" })).toBeDisabled();
});

test("会话列表：本项目的会话，在做的在前、其余最近活动在前；写标题、发起人、状态、最近活动；点进会话页", async ({
	page,
	controlPlane,
}) => {
	const db = controlPlane.database.url;
	const idle = await seedSession(db, {
		title: "给 http_check 加超时",
		createdBy: "alice",
		status: "idle",
		lastActivityAt: new Date("2026-01-01T00:00:10Z"),
	});
	const running = await seedSession(db, {
		title: "巡检场景改成每小时一次",
		createdBy: "bob",
		status: "running",
		lastActivityAt: new Date("2026-01-01T00:00:05Z"),
	});
	const ended = await seedSession(db, {
		title: "已经做完的事",
		createdBy: "carol",
		status: "ended",
		lastActivityAt: new Date("2026-01-01T00:00:20Z"),
	});
	await page.goto("/sessions");
	const rows = page.getByRole("table", { name: "会话列表" }).getByRole("row");
	// 表头一行；在做的在前，其余最近活动在前。
	await expect(rows).toHaveCount(4);
	await expect(rows.nth(1)).toContainText("巡检场景改成每小时一次");
	await expect(rows.nth(1)).toContainText("bob");
	await expect(rows.nth(1)).toContainText("在做");
	await expect(rows.nth(2)).toContainText("已经做完的事");
	await expect(rows.nth(2)).toContainText("已结束");
	await expect(rows.nth(3)).toContainText("给 http_check 加超时");
	await expect(rows.nth(3)).toContainText("alice");
	await expect(rows.nth(3)).toContainText("空闲");
	await expect(rows.nth(3)).toContainText("01-01 08:00");

	await page.getByRole("link", { name: "给 http_check 加超时" }).click();
	await expect(page).toHaveURL(new RegExp(`/sessions/${idle}$`));
	await expect(page.getByRole("heading", { level: 1, name: "给 http_check 加超时" })).toBeVisible();
	expect([running, ended]).toHaveLength(2);
});

test("开始：成功后跳到会话页；请求里是写好的话", async ({ page, controlPlane }) => {
	const id = await seedSession(controlPlane.database.url, {
		title: "给 http_check 加一个超时参数",
		status: "running",
		events: [
			{
				type: "user_message",
				message_id: randomUUID(),
				text: "给 http_check 加一个超时参数",
				steer: false,
				author: "tester",
				author_user_id: null,
			},
		],
	});
	let posted: unknown;
	await stubSessionList(page, READY, [], async (route, body) => {
		posted = body;
		const detail = (await (await controlPlane.fetch(`/sessions/${id}`)).json()) as Record<
			string,
			unknown
		>;
		const { events: _events, has_more: _hasMore, ...view } = detail;
		await fulfillJson(route, 201, view);
	});
	await page.goto("/sessions");
	await assistantInput(page).fill("给 http_check 加一个超时参数");
	await page.getByRole("button", { name: "开始" }).click();
	await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
	expect(posted).toEqual({ text: "给 http_check 加一个超时参数" });
	await expect(timeline(page).getByTestId("user-message")).toHaveText(
		"tester：给 http_check 加一个超时参数",
	);
});

test("project_busy：留住写好的话，写明原因，给出正在做的那个会话的链接", async ({
	page,
	controlPlane,
}) => {
	const running = await seedSession(controlPlane.database.url, {
		title: "别人在做的事",
		createdBy: "bob",
		status: "running",
	});
	let posts = 0;
	await stubSessionList(page, READY, undefined, async (route) => {
		posts++;
		await apiError(route, 409, "project_busy", "同一个项目里另一个会话正在做");
	});
	// 列表读真的（里面有正在做的那个会话）：只有就绪状态是拦截的。
	await page.unroute("**/api/projects/*/sessions");
	await page.route("**/api/projects/*/sessions", async (route) => {
		if (route.request().method() === "POST") {
			posts++;
			await apiError(route, 409, "project_busy", "同一个项目里另一个会话正在做");
			return;
		}
		const response = await route.fetch();
		const body = (await response.json()) as { readiness: unknown };
		await fulfillJson(route, 200, { ...body, readiness: READY });
	});
	await page.goto("/sessions");
	const input = assistantInput(page);
	await input.fill("想让助手做的事");
	await page.getByRole("button", { name: "开始" }).click();
	const alert = page.getByRole("alert").filter({ hasText: "另一个会话正在做" });
	await expect(alert).toBeVisible();
	await expect(input).toHaveValue("想让助手做的事");
	const link = alert.getByRole("link", { name: "打开正在做的会话" });
	await expect(link).toHaveAttribute("href", `/sessions/${running}`);
	expect(posts).toBe(1);
	await link.click();
	await expect(page).toHaveURL(new RegExp(`/sessions/${running}$`));
});

test("开始失败（503）：留住写好的话，写明原因；就绪状态刷新", async ({ page }) => {
	await stubSessionList(page, READY, [], async (route) => {
		await apiError(route, 503, "assistant_unavailable", "助手服务连不上");
	});
	await page.goto("/sessions");
	await assistantInput(page).fill("要做的事");
	await page.getByRole("button", { name: "开始" }).click();
	await expect(
		page.getByRole("alert").filter({ hasText: "无法开始会话：助手服务连不上" }),
	).toBeVisible();
	await expect(assistantInput(page)).toHaveValue("要做的事");
	await expect(page).toHaveURL(/\/sessions\/?$/);
});

// ---------------------------------------------------------------- 会话页：历史

test("一轮的六种结局：各一行；到了上限按 limit_kind 写是哪一种", async ({ page, controlPlane }) => {
	const base = { turn: 1, reason: "原因", duration_ms: 84_000 } as const;
	const events: SessionEventBody[] = [
		{ type: "turn_end", ...base, outcome: "completed", steps: 12, model_calls: 9 },
		{ type: "turn_end", ...base, outcome: "stopped", reason: "用户停止" },
		{ type: "turn_end", ...base, outcome: "limit", limit_kind: "model_calls", model_calls: 40 },
		{ type: "turn_end", ...base, outcome: "limit", limit_kind: "duration", duration_ms: 1_200_000 },
		{ type: "turn_end", ...base, outcome: "interrupted", reason: "助手服务重启了" },
		{ type: "turn_end", ...base, outcome: "model_unavailable", reason: "模型连不上" },
		{ type: "turn_end", ...base, outcome: "failed", reason: "出了点问题" },
	];
	const id = await seedSession(controlPlane.database.url, { events });
	await page.goto(`/sessions/${id}`);
	await expect(page.getByTestId("turn-end")).toHaveText([
		"这一轮完成 · 12 步 · 用时 1m 24s",
		"已停止",
		"到了上限：40 次模型调用",
		"到了上限：用时 20m 00s",
		"中断：助手服务重启了",
		"模型不可用：模型连不上",
		"出错：出了点问题",
	]);
});

test("历史：工具行默认折叠，展开看结果；命令写 $、读写改写路径；出错标红、被截断写明只显示了头尾", async ({
	page,
	controlPlane,
}) => {
	const events: SessionEventBody[] = [
		{
			type: "user_message",
			message_id: randomUUID(),
			text: "整理一下",
			steer: false,
			author: "alice",
			author_user_id: null,
		},
		{ type: "turn_started", turn: 1 },
		{ type: "tool_call", call_id: "c1", tool: "command", title: "sfly package list" },
		{
			type: "tool_result",
			call_id: "c1",
			is_error: false,
			text: "http_check 0.3.0\n",
			truncated: false,
			exit_code: 0,
			duration_ms: 420,
		},
		{ type: "tool_call", call_id: "c2", tool: "read", title: "nodes/a.py" },
		{
			type: "tool_result",
			call_id: "c2",
			is_error: false,
			text: "a",
			truncated: false,
			duration_ms: 12,
		},
		{ type: "tool_call", call_id: "c3", tool: "write", title: "nodes/b.py" },
		{
			type: "tool_result",
			call_id: "c3",
			is_error: false,
			text: "wrote",
			truncated: false,
			duration_ms: 900,
		},
		{ type: "tool_call", call_id: "c4", tool: "edit", title: "nodes/c.py" },
		{
			type: "tool_result",
			call_id: "c4",
			is_error: true,
			text: "Could not find the text to replace",
			truncated: true,
			duration_ms: 12_300,
		},
		{ type: "tool_call", call_id: "c5", tool: "command", title: "false" },
		{
			type: "tool_result",
			call_id: "c5",
			is_error: true,
			text: "",
			truncated: false,
			exit_code: 1,
			duration_ms: 30,
		},
		{ type: "notice", kind: "compaction", message: "上下文太长，已经压缩" },
	];
	const id = await seedSession(controlPlane.database.url, { events });
	await page.goto(`/sessions/${id}`);
	const rows = toolRows(page);
	await expect(rows).toHaveCount(5);
	await expect(rows.nth(0)).toContainText("$ sfly package list");
	await expect(rows.nth(0)).toContainText("退出码 0 · 用时 420ms");
	await expect(rows.nth(1)).toContainText("读 nodes/a.py");
	await expect(rows.nth(2)).toContainText("写 nodes/b.py");
	await expect(rows.nth(3)).toContainText("改 nodes/c.py");
	await expect(rows.nth(3)).toContainText("出错 · 用时 12.3s · 只显示了头尾");
	await expect(rows.nth(3)).toHaveAttribute("data-state", "error");
	await expect(rows.nth(4)).toContainText("出错 · 退出码 1 · 用时 30ms");
	await expect(page.getByTestId("notice")).toHaveText("上下文太长，已经压缩");

	// 默认折叠；点一行展开看结果正文，再点收起。
	await expect(page.getByTestId("tool-result")).toHaveCount(0);
	const first = rows.nth(0).getByRole("button");
	await expect(first).toHaveAttribute("aria-expanded", "false");
	await first.click();
	await expect(first).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByTestId("tool-result")).toHaveText("http_check 0.3.0");
	await first.click();
	await expect(page.getByTestId("tool-result")).toHaveCount(0);
	// 没有输出的结果写明。
	await rows.nth(4).getByRole("button").click();
	await expect(page.getByTestId("tool-result")).toHaveText("（没有输出）");
});

test("历史很长：先读最近一页，「加载更早的」往前翻页，翻完就没有这个按钮", async ({
	page,
	controlPlane,
}) => {
	const events: SessionEventBody[] = Array.from({ length: 230 }, (_, i) => ({
		type: "notice",
		kind: "compaction",
		message: `提示 ${i + 1}`,
	}));
	const id = await seedSession(controlPlane.database.url, { events });
	await page.goto(`/sessions/${id}`);
	const notices = page.getByTestId("notice");
	await expect(notices).toHaveCount(200);
	await expect(notices.first()).toHaveText("提示 31");
	await expect(notices.last()).toHaveText("提示 230");
	const older = page.getByRole("button", { name: "加载更早的" });
	await older.click();
	await expect(notices).toHaveCount(230);
	await expect(notices.first()).toHaveText("提示 1");
	await expect(notices.nth(30)).toHaveText("提示 31");
	await expect(notices.last()).toHaveText("提示 230");
	await expect(older).toHaveCount(0);
});

test("会话不存在：写明无法加载", async ({ page }) => {
	await page.goto(`/sessions/${randomUUID()}`);
	await expect(page.getByRole("alert").filter({ hasText: "无法加载这个会话" })).toBeVisible();
});

// ---------------------------------------------------------------- 会话页：实时

test("一轮从头到尾：这句话、思考中、逐字出现的助手的话、工具行（转圈，结果到了展开看）、「这一轮完成」；刷新后一样", async ({
	page,
}) => {
	const view = sessionView({ status: "running" });
	const persisted: SessionEvent[] = [userMessage(1), turnStarted(2)];
	await installSessionStream(page);
	await stubSessionDetail(page, view, persisted);
	const push = async (event: Parameters<typeof pushEvent>[1]) => {
		if ("seq" in event) persisted.push(event);
		await pushEvent(page, event);
	};
	await page.goto(`/sessions/${view.id}`);

	// 这句话；会话在做：状态、「停止」、不能接着说。
	await expect(timeline(page).getByTestId("user-message")).toHaveText(
		"alice：给 http_check 加超时",
	);
	await expect(page.getByTestId("session-status")).toHaveText("在做");
	await expect(page.getByRole("button", { name: "停止" })).toBeVisible();
	await expect(composer(page)).toBeDisabled();
	await expect(page.getByTestId("composer-blocked")).toHaveText("助手正在做这一轮；要改方向先停止");
	// 事件流从历史的最大序号之后接。
	expect((await streamOpens(page)).urls[0]).toContain("after=2");

	// 模型在思考：「思考中」，有文字出来就去掉。
	await push({ type: "thinking" });
	await expect(page.getByTestId("thinking")).toHaveText("思考中");
	await push({ type: "assistant_delta", text: "我先看" });
	await expect(page.getByTestId("thinking")).toHaveCount(0);
	const said = page.getByTestId("assistant-message");
	await expect(said).toHaveText("我先看");
	await expect(said).toHaveAttribute("data-streaming", "true");
	await push({ type: "assistant_delta", text: "一下现有的" });
	await expect(said).toHaveText("我先看一下现有的");
	// 整条消息以它为准：替换逐字拼出来的文字。
	await push(assistantMessage(3, "我先看一下现有的节点。"));
	await expect(said).toHaveText("我先看一下现有的节点。");
	await expect(said).not.toHaveAttribute("data-streaming");

	// 工具调用：一行，在做；结果到了补上摘要，展开看正文。
	await push(toolCall(4, "call_1", "command", "sfly package list"));
	const row = toolRows(page).first();
	await expect(row).toHaveAttribute("data-state", "running");
	await expect(row).toContainText("$ sfly package list");
	await expect(row).toContainText("在做");
	await expect(row.getByRole("button")).toBeDisabled();
	await push(toolResult(5, "call_1", { exit_code: 0, text: "http_check 0.3.0\n" }));
	await expect(row).toHaveAttribute("data-state", "done");
	await expect(row).toContainText("退出码 0 · 用时 420ms");
	await row.getByRole("button").click();
	await expect(page.getByTestId("tool-result")).toHaveText("http_check 0.3.0");
	await row.getByRole("button").click();

	await push(toolCall(6, "call_2", "edit", "nodes/http_check.py"));
	await push(toolResult(7, "call_2", { is_error: true, truncated: true, text: "没改成" }));
	await expect(toolRows(page).nth(1)).toContainText("出错 · 用时 420ms · 只显示了头尾");

	// 一轮结束：「这一轮完成」，会话回到空闲，可以接着说。
	await push(turnEnd(8, "completed", { steps: 2, model_calls: 3 }));
	await expect(page.getByTestId("turn-end")).toHaveText("这一轮完成 · 2 步 · 用时 1m 24s");
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
	await expect(composer(page)).toBeEnabled();

	// 刷新：时间线和刷新前一样（刷新后读回的是持久的事件）。
	const before = await timeline(page).innerText();
	await page.reload();
	await expect(page.getByTestId("turn-end")).toHaveText("这一轮完成 · 2 步 · 用时 1m 24s");
	expect(await timeline(page).innerText()).toBe(before);
	expect(persisted.map((e) => ("seq" in e ? e.seq : 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("事件重复来（重连后补发、历史和事件流重叠）不重复；这一版不渲染的类型不添行也不报错", async ({
	page,
}) => {
	const view = sessionView({ status: "running" });
	const persisted: SessionEvent[] = [userMessage(1), turnStarted(2), assistantMessage(3, "好的。")];
	await installSessionStream(page);
	await stubSessionDetail(page, view, persisted);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`/sessions/${view.id}`);
	await expect(timeline(page).getByTestId("assistant-message")).toHaveText("好的。");

	// 历史里已有的序号再来一次：不重复。
	await pushEvent(page, userMessage(1));
	await pushEvent(page, assistantMessage(3, "好的。"));
	// 这一版不渲染的类型。
	await pushEvent(page, {
		type: "tool_output",
		call_id: "x",
		text: "半截输出",
	});
	await pushEvent(page, {
		type: "snapshot",
		status: "running",
		partial_text: "",
		running_tool: null,
		steer_queue: [],
		waiting_for: null,
	});
	await pushEvent(page, { type: "steer_queue", messages: [] });
	// 一个不认识的类型（以后才有的）。
	await page.evaluate(() => {
		(
			window as unknown as { __sessionStream: { push(e: string, d: unknown, id?: number): void } }
		).__sessionStream.push("future_event", { type: "future_event" });
	});
	// 之后来的事件照常处理，说明前面的没有卡住。
	await pushEvent(page, turnEnd(4, "stopped"));
	await expect(page.getByTestId("turn-end")).toHaveText("已停止");
	await expect(page.getByTestId("user-message")).toHaveCount(1);
	await expect(page.getByTestId("assistant-message")).toHaveCount(1);
	await expect(timeline(page).getByRole("listitem")).toHaveCount(3);
	expect(errors).toEqual([]);
});

test("停止：在做时点「停止」，请求发给停止接口，时间线出现「已停止」", async ({ page }) => {
	const view = sessionView({ status: "running" });
	const persisted: SessionEvent[] = [
		userMessage(1),
		turnStarted(2),
		toolCall(3, "c", "command", "sleep 600"),
	];
	await installSessionStream(page);
	await stubSessionDetail(page, view, persisted);
	const stops: string[] = [];
	await page.route(new RegExp(`/api/sessions/${view.id}/stop$`), async (route) => {
		stops.push(route.request().method());
		await fulfillJson(route, 200, { ...view, status: "running" });
	});
	await page.goto(`/sessions/${view.id}`);
	await expect(toolRows(page).first()).toHaveAttribute("data-state", "running");
	await page.getByRole("button", { name: "停止" }).click();
	await expect.poll(() => stops).toEqual(["POST"]);
	// 这一轮的 turn_end 由助手服务的事件带回来。
	await pushEvent(page, turnEnd(4, "stopped"));
	await expect(page.getByTestId("turn-end")).toHaveText("已停止");
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
	// 停下来时还没有结果的工具行不再算在做。
	await expect(toolRows(page).first()).toHaveAttribute("data-state", "abandoned");
});

test("停止失败：写明原因，会话仍是在做", async ({ page }) => {
	const view = sessionView({ status: "running" });
	await installSessionStream(page);
	await stubSessionDetail(page, view, [userMessage(1), turnStarted(2)]);
	await page.route(new RegExp(`/api/sessions/${view.id}/stop$`), (route) =>
		apiError(route, 503, "assistant_unavailable", "助手服务连不上"),
	);
	await page.goto(`/sessions/${view.id}`);
	await page.getByRole("button", { name: "停止" }).click();
	await expect(
		page.locator("[data-sonner-toast]").filter({ hasText: "无法停止这一轮" }),
	).toContainText("助手服务连不上");
	await expect(page.getByTestId("session-status")).toHaveText("在做");
});

// ---------------------------------------------------------------- 会话页：接着说

test("接着说：空闲时可以发（请求里是写好的话），发完清空；在做时不可用并写明原因；已结束时不显示", async ({
	page,
	controlPlane,
}) => {
	const db = controlPlane.database.url;
	const idle = await seedSession(db, { status: "idle", events: [] });
	const running = await seedSession(db, { status: "running", events: [] });
	const ended = await seedSession(db, { status: "ended", events: [] });
	const posts: unknown[] = [];
	await page.route(/\/api\/sessions\/[^/]+\/messages$/, async (route) => {
		posts.push(route.request().postDataJSON());
		await fulfillJson(route, 200, { seq: 7 });
	});

	await page.goto(`/sessions/${idle}`);
	await expect(composer(page)).toBeEnabled();
	await expect(page.getByRole("button", { name: "发送" })).toBeDisabled(); // 还没写话
	await composer(page).fill("再加一个重试次数");
	await page.getByRole("button", { name: "发送" }).click();
	await expect.poll(() => posts).toEqual([{ text: "再加一个重试次数" }]);
	await expect(composer(page)).toHaveValue("");

	await page.goto(`/sessions/${running}`);
	await expect(composer(page)).toBeDisabled();
	await expect(page.getByTestId("composer-blocked")).toHaveText("助手正在做这一轮；要改方向先停止");
	await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();

	await page.goto(`/sessions/${ended}`);
	await expect(composer(page)).toHaveCount(0);
	await expect(page.getByText("这个会话已经结束")).toBeVisible();
	await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
});

test("接着说失败：留住写好的话，写明原因", async ({ page, controlPlane }) => {
	const id = await seedSession(controlPlane.database.url, { status: "idle", events: [] });
	await page.route(/\/api\/sessions\/[^/]+\/messages$/, (route) =>
		apiError(route, 409, "turn_running", "这个会话有一轮在做"),
	);
	await page.goto(`/sessions/${id}`);
	await composer(page).fill("再加一个重试次数");
	await page.getByRole("button", { name: "发送" }).click();
	await expect(
		page.getByRole("alert").filter({ hasText: "助手正在做这一轮；要改方向先停止" }),
	).toBeVisible();
	await expect(composer(page)).toHaveValue("再加一个重试次数");
});
