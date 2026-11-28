import { randomUUID } from "node:crypto";
import type { Locator, Page, Route } from "@playwright/test";
import { SESSION_LIST_LIMIT, type SessionEvent, type SessionEventBody } from "@sfly/schema";
import { seedSession } from "../../server/test/support/sessions.js";
import {
	apiError,
	assistantMessage,
	commitEvent,
	eventAt,
	fulfillJson,
	installSessionStream,
	pushEvent,
	queueCancelled,
	READY,
	sessionEnded,
	sessionView,
	steerDropped,
	steerMessage,
	steerQueue,
	streamOpens,
	stubSessionDetail,
	stubSessionList,
	toolCall,
	toolResult,
	turnEnd,
	turnQueued,
	turnStarted,
	USAGE,
	userMessage,
	WAITING_FOR,
} from "./assistant-support";
import { expect, test } from "./fixtures";

// 助手页和会话页（#542）：导航和快捷键、就绪状态、新建会话、会话列表、会话的时间线（逐字出现、工具行、一轮结束）、
// 停止、接着说。控制面是真的（读出来的会话和事件是库里的）；会话的写接口和助手服务在 #541 的第二个 PR 之前还没有，
// 写接口在这里被拦截，实时事件由测试推。

const timeline = (page: Page) => page.getByRole("list", { name: "会话的时间线" });
const assistantInput = (page: Page) => page.getByRole("textbox", { name: "要做什么？" });
const composer = (page: Page) => page.getByRole("textbox", { name: "接着说" });
const toolRows = (page: Page) => page.getByTestId("tool-row");
const box = async (locator: Locator) => {
	const found = await locator.boundingBox();
	if (found === null) throw new Error("元素没有占位置");
	return found;
};

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
	// 缺的每一条都写出来，不只认某一种；每一条后面写该找谁。
	await expect(readiness.getByTestId("readiness-problem")).toHaveCount(2);
	await expect(readiness.getByTestId("readiness-hint")).toHaveText([
		"请部署者在控制面上开启助手",
		"请项目管理员登记工作台（见部署文档「登记工作台」）",
	]);

	const input = assistantInput(page);
	await input.fill("给 http_check 加一个超时参数");
	await expect(input).toHaveValue("给 http_check 加一个超时参数");
	await expect(page.getByRole("button", { name: "开始" })).toBeDisabled();
	// 不能用的原因只在上面的就绪状态里写一处：按钮旁边没有再写一遍，按钮和输入框用 aria-describedby 指向那一块。
	await expect(page.getByText("助手没有开启")).toHaveCount(1);
	await expect(page.getByTestId("cannot-start")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "开始" })).toHaveAccessibleDescription(
		/现在不能用：.*助手没有开启/s,
	);
	// 输入框也指向同一块（读屏读到输入框时也知道现在为什么不能开始）。
	await expect(input).toHaveAttribute("aria-describedby", "assistant-readiness");
	await expect(input).toHaveAccessibleDescription(/现在不能用：.*助手没有开启/s);

	await expect(page.getByRole("heading", { name: "还没有会话" })).toBeVisible();
	await expect(page.getByText("在上面说一句话，助手就会开始。")).toBeVisible();
});

test("就绪：「可以用 · 工作台 X 在线」；工作台不在线时逐条写缺什么，写明是哪一台", async ({
	page,
}) => {
	await stubSessionList(page, READY);
	await page.goto("/sessions");
	await expect(page.getByTestId("readiness")).toHaveText("可以用 · 工作台 bench-1 在线");
	// 可以用时是「开始」旁边的一行小字：同一行、在按钮右边。
	const form = page.getByRole("form", { name: "要做什么？" });
	await expect(form.getByTestId("readiness")).toBeVisible();
	const button = await box(page.getByRole("button", { name: "开始" }));
	const line = await box(page.getByTestId("readiness"));
	expect(line.x).toBeGreaterThanOrEqual(button.x + button.width);
	expect(Math.abs(line.y + line.height / 2 - (button.y + button.height / 2))).toBeLessThanOrEqual(
		button.height / 2,
	);
	await expect(page.getByRole("button", { name: "开始" })).toBeDisabled(); // 还没写话
	await assistantInput(page).fill("做点事");
	await expect(page.getByRole("button", { name: "开始" })).toBeEnabled();
	// 能用时「开始」和输入框都没有指向就绪状态的描述（这时就绪状态只是「可以用」，没有原因要读）。
	await expect(page.getByRole("button", { name: "开始" })).not.toHaveAttribute("aria-describedby");
	await expect(assistantInput(page)).not.toHaveAttribute("aria-describedby");

	await page.unroute("**/api/projects/*/sessions");
	await stubSessionList(page, {
		ready: false,
		workbench: "bench-1",
		exposure: null,
		problems: [
			{ kind: "workbench_offline", message: "工作台的 Agent 不在线" },
			{ kind: "assistant_unreachable", message: "助手服务连不上" },
		],
	});
	await page.reload();
	const readiness = page.getByTestId("readiness");
	const problems = readiness.getByTestId("readiness-problem");
	await expect(problems).toHaveCount(2);
	await expect(problems.nth(0)).toContainText("工作台 bench-1 不在线");
	await expect(problems.nth(0).getByTestId("readiness-hint")).toHaveText(
		"请部署者检查工作台有没有在运行、能不能连上控制面、能力端口有没有上报",
	);
	await expect(problems.nth(1)).toContainText("助手服务连不上");
	await expect(problems.nth(1).getByTestId("readiness-hint")).toHaveText(
		"请部署者检查助手容器有没有在运行",
	);
	// 缺什么写在输入框和「开始」之间。
	const input = await box(assistantInput(page));
	const list = await box(readiness);
	const start = await box(page.getByRole("button", { name: "开始" }));
	expect(list.y).toBeGreaterThanOrEqual(input.y + input.height);
	expect(list.y + list.height).toBeLessThanOrEqual(start.y);
	await assistantInput(page).fill("做点事");
	await expect(page.getByRole("button", { name: "开始" })).toBeDisabled();
});

test("模型没有配置、连不上：就绪状态写明缺什么（连不上的写上次检查的时间），「开始」不可用，输入框照常可以写；好了之后恢复", async ({
	page,
}) => {
	const problem = (kind: "model_not_configured" | "model_unreachable", message: string) => ({
		ready: false,
		workbench: "bench-1",
		exposure: null,
		problems: [{ kind, message }],
	});
	const start = page.getByRole("button", { name: "开始" });
	const states: Array<[ReturnType<typeof problem>, RegExp, string]> = [
		[
			problem(
				"model_not_configured",
				"没有配置模型：没有模型文件 /config/models.json（SFLY_ASSISTANT_MODELS）",
			),
			/没有配置模型：没有模型文件 \/config\/models\.json/,
			"请部署者在助手容器上配置模型",
		],
		[
			problem(
				"model_not_configured",
				"没有配置模型：模型文件引用了环境变量 ACME_KEY，助手服务的环境里没有值",
			),
			/没有配置模型：模型文件引用了环境变量 ACME_KEY，助手服务的环境里没有值/,
			"请部署者在助手容器上配置模型",
		],
		[
			problem(
				"model_not_configured",
				"没有配置模型：SFLY_ASSISTANT_MODEL 选的模型不在模型文件 /config/models.json 里",
			),
			/SFLY_ASSISTANT_MODEL 选的模型不在模型文件/,
			"请部署者在助手容器上配置模型",
		],
		[
			problem(
				"model_unreachable",
				"连不上模型端点 llm.internal:8177：连接被拒绝（上次检查：3 分钟前）",
			),
			/连不上模型端点 llm\.internal:8177：连接被拒绝（上次检查：3 分钟前）/,
			"请部署者检查助手容器能不能连上模型",
		],
	];
	for (const [readiness, text, hint] of states) {
		await stubSessionList(page, readiness);
		await page.goto("/sessions");
		const line = page.getByTestId("readiness");
		await expect(line).toHaveAttribute("data-ready", "false");
		await expect(line).toContainText("现在不能用：");
		await expect(line).toContainText(text);
		// 缺什么后面写该找谁、做什么。
		await expect(line.getByTestId("readiness-hint")).toHaveText(hint);
		await assistantInput(page).fill("做点事");
		await expect(assistantInput(page)).toHaveValue("做点事");
		await expect(start).toBeDisabled();
		await expect(start).toHaveAccessibleDescription(text);
		await page.unrouteAll({ behavior: "ignoreErrors" });
	}
	// 模型好了：就绪，「开始」可点。
	await stubSessionList(page, READY);
	await page.goto("/sessions");
	await expect(page.getByTestId("readiness")).toHaveText("可以用 · 工作台 bench-1 在线");
	await assistantInput(page).fill("做点事");
	await expect(start).toBeEnabled();
});

const alpha = { agent: "alpha-agent", address: "10.0.0.9:50052" };
const beta = { agent: "beta-agent", address: "[fd00::7]:50052" };
const measured = (over: Record<string, unknown> = {}) => ({
	...READY,
	exposure: {
		checked_at: "2026-01-01T00:00:00.000Z",
		agents: [],
		unmeasured: [],
		failed_at: null,
		...over,
	},
});

test("工作台连得到项目外 Agent 的能力端口（#498）：助手页和会话页写出是哪几台、什么地址，该找谁，隔离做到哪一层；不挡着用助手", async ({
	page,
}) => {
	const exposed = measured({ agents: [alpha, beta] });
	await stubSessionList(page, exposed);
	await page.goto("/sessions");
	const warning = page.getByTestId("exposure");
	await expect(warning).toContainText("工作台连得到项目外 Agent 的能力端口：");
	await expect(warning.getByTestId("exposed-agent")).toHaveText([
		"alpha-agent（10.0.0.9:50052）",
		"beta-agent（[fd00::7]:50052）",
	]);
	await expect(warning).toContainText("SFLY_WORKBENCH_EGRESS");
	await expect(warning).toContainText("机器层面的项目隔离还没有做到");
	await expect(page.getByTestId("readiness")).toHaveText("可以用 · 工作台 bench-1 在线");

	const session = sessionView({ status: "idle", readiness: exposed });
	await installSessionStream(page);
	await stubSessionDetail(page, session, [userMessage(1), turnStarted(2), turnEnd(3, "completed")]);
	await page.goto(`/sessions/${session.id}`);
	await expect(page.getByTestId("exposed-agent")).toHaveText([
		"alpha-agent（10.0.0.9:50052）",
		"beta-agent（[fd00::7]:50052）",
	]);
	await expect(page.getByRole("button", { name: "发送" })).toBeVisible();

	// 测成了、一台也连不通（或还没探过）时不显示。
	await page.unroute("**/api/projects/*/sessions");
	await stubSessionList(page, measured());
	await page.goto("/sessions");
	await expect(page.getByTestId("readiness")).toBeVisible();
	await expect(page.getByTestId("exposure")).toHaveCount(0);
});

test("探测没测成（#498）：没测成的目标单独列出，不当成连不通；一轮整个没测成写明时间和上次测成的结果", async ({
	page,
}) => {
	await stubSessionList(
		page,
		measured({ unmeasured: [beta], failed_at: "2026-01-01T00:10:00.000Z", agents: [alpha] }),
	);
	await page.goto("/sessions");
	const line = page.getByTestId("exposure");
	await expect(line.getByTestId("exposed-agent")).toHaveText(["alpha-agent（10.0.0.9:50052）"]);
	await expect(line).toContainText("这几台没测成（不算连不通）：");
	await expect(line.getByTestId("unmeasured-agent")).toHaveText(["beta-agent（[fd00::7]:50052）"]);
	await expect(line.getByTestId("exposure-failed")).toContainText("那一轮没测成");
	await expect(line.getByTestId("exposure-failed")).toContainText("测成的结果");

	// 从来没有测成过：只写没测成，没有「一台也连不通」的假象。
	await page.unroute("**/api/projects/*/sessions");
	await stubSessionList(
		page,
		measured({ checked_at: null, failed_at: "2026-01-01T00:10:00.000Z" }),
	);
	await page.goto("/sessions");
	await expect(page.getByTestId("exposure-failed")).toContainText("之前也没有测成过");
	await expect(page.getByTestId("exposed-agent")).toHaveCount(0);
});

test("一直开着的助手页和会话页：下一轮探测连得通了，不用刷新页面就出现告警（#498）", async ({
	page,
}) => {
	let listed: unknown = measured();
	await page.route("**/api/projects/*/sessions", (route) =>
		fulfillJson(route, 200, { readiness: listed, sessions: [], truncated: false }),
	);
	await page.goto("/sessions");
	await expect(page.getByTestId("readiness")).toBeVisible();
	await expect(page.getByTestId("exposure")).toHaveCount(0);
	listed = measured({ agents: [alpha] });
	await expect(page.getByTestId("exposed-agent")).toHaveText(["alpha-agent（10.0.0.9:50052）"], {
		timeout: 25_000,
	});

	listed = measured();
	const session = sessionView({ status: "idle", readiness: measured() });
	await installSessionStream(page);
	await stubSessionDetail(page, session, [userMessage(1), turnStarted(2), turnEnd(3, "completed")]);
	await page.goto(`/sessions/${session.id}`);
	await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
	await expect(page.getByTestId("exposure")).toHaveCount(0);
	listed = measured({ agents: [alpha] });
	await expect(page.getByTestId("exposed-agent")).toHaveText(["alpha-agent（10.0.0.9:50052）"], {
		timeout: 25_000,
	});
});

test("会话页：模型有问题时空闲的会话在输入框旁写缺什么和该找谁，「发送」不可用、输入框照常可以写；模型好了页面自己恢复；在做的会话不受影响", async ({
	page,
}) => {
	const down = {
		ready: false,
		workbench: "bench-1",
		exposure: null,
		problems: [
			{
				kind: "model_unreachable" as const,
				message: "连不上模型端点 llm.internal:8177：连接被拒绝（上次检查：2 分钟前）",
			},
		],
	};
	const idle = sessionView({ status: "idle", readiness: down });
	const running = sessionView({ status: "running", readiness: down });
	await installSessionStream(page);
	await stubSessionDetail(page, idle, [userMessage(1), turnStarted(2), turnEnd(3, "completed")]);
	await stubSessionDetail(page, running, [userMessage(1), turnStarted(2)]);
	// 项目的会话列表：打开时有模型的问题的会话页据此刷新就绪状态；这里先说连不上，之后改成好了。
	let listed: unknown = down;
	await page.route("**/api/projects/*/sessions", (route) =>
		fulfillJson(route, 200, { readiness: listed, sessions: [], truncated: false }),
	);

	await page.goto(`/sessions/${idle.id}`);
	const line = page.getByTestId("readiness");
	await expect(line).toContainText(
		"连不上模型端点 llm.internal:8177：连接被拒绝（上次检查：2 分钟前）",
	);
	await expect(line.getByTestId("readiness-hint")).toHaveText("请部署者检查助手容器能不能连上模型");
	// 写在输入框旁（输入框所在的表单里，输入框和「发送」之间），不在页面顶上。
	await expect(page.getByRole("form", { name: "接着说" }).getByTestId("readiness")).toBeVisible();
	const field = await box(composer(page));
	const where = await box(line);
	const sendBox = await box(page.getByRole("button", { name: "发送" }));
	expect(where.y).toBeGreaterThanOrEqual(field.y + field.height);
	expect(where.y + where.height).toBeLessThanOrEqual(sendBox.y);
	await composer(page).fill("再来一次");
	await expect(composer(page)).toHaveValue("再来一次");
	const send = page.getByRole("button", { name: "发送" });
	await expect(send).toBeDisabled();
	await expect(send).toHaveAccessibleDescription(/连不上模型端点/);
	// 模型好了：不用重新打开页面（有问题时每 5 秒查一次）。
	listed = READY;
	await expect(line).toHaveCount(0, { timeout: 15_000 });
	await expect(send).toBeEnabled();

	// 在做的会话：说的是插话，不看模型的就绪状态，页面上也不写。
	await page.goto(`/sessions/${running.id}`);
	await expect(page.getByTestId("session-status")).toHaveText("在做");
	await expect(page.getByTestId("readiness")).toHaveCount(0);
	await composer(page).fill("改一下");
	await expect(page.getByRole("button", { name: "发送插话" })).toBeEnabled();
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

	// 会话没有超过接口一次给的个数：没有「只显示了…」的提示。
	await expect(page.getByTestId("list-truncated")).toHaveCount(0);

	await page.getByRole("link", { name: "给 http_check 加超时" }).click();
	await expect(page).toHaveURL(new RegExp(`/sessions/${idle}$`));
	await expect(page.getByRole("heading", { level: 1, name: "给 http_check 加超时" })).toBeVisible();
	expect([running, ended]).toHaveLength(2);
});

/** 一个已经说过话、一轮已经有结局的会话的事件（会话列表上「上一轮」的结局取自最近一条 `turn_end`）。 */
const endedTurn = (
	outcome: "completed" | "stopped" | "limit" | "model_unavailable" | "interrupted" | "failed",
	extra: Partial<Extract<SessionEventBody, { type: "turn_end" }>> = {},
): SessionEventBody[] => [
	{
		type: "user_message",
		message_id: randomUUID(),
		text: "做点事",
		steer: false,
		author: "alice",
		author_user_id: null,
	},
	{ type: "turn_started", turn: 1 },
	{ type: "turn_end", turn: 1, outcome, reason: "原因", duration_ms: 1000, ...extra },
];

test("会话列表：在做、排队中（带位置）、被打断、已结束各显示正确；在做和排队的在前；上一轮的结局不是完成时标出来（真的控制面）", async ({
	page,
	controlPlane,
}) => {
	const db = controlPlane.database.url;
	const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second));
	// 在做的会话，上一轮是被打断的（这一轮是在那之后开的）。
	await seedSession(db, {
		title: "正在做的事",
		createdBy: "bob",
		status: "running",
		createdAt: at(1),
		lastActivityAt: at(60),
		events: [...endedTurn("interrupted"), { type: "turn_started", turn: 2 }],
	});
	// 排队中的两个：按排队的先后排第 1、2 位。
	await seedSession(db, {
		title: "排在第一位的事",
		createdBy: "alice",
		status: "queued",
		createdAt: at(10),
		lastActivityAt: at(50),
	});
	await seedSession(db, {
		title: "排在第二位的事",
		createdBy: "carol",
		status: "queued",
		createdAt: at(20),
		lastActivityAt: at(40),
	});
	const idleSession = (title: string, outcome: Parameters<typeof endedTurn>[0], second: number) =>
		seedSession(db, {
			title,
			createdBy: "alice",
			status: "idle",
			createdAt: at(1),
			lastActivityAt: at(second),
			events: endedTurn(outcome, outcome === "limit" ? { limit_kind: "model_calls" } : {}),
		});
	await idleSession("做完了的事", "completed", 30);
	await idleSession("被打断的事", "interrupted", 25);
	await idleSession("到了上限的事", "limit", 24);
	await idleSession("出错的事", "failed", 23);
	await idleSession("模型不可用的事", "model_unavailable", 22);
	await idleSession("被停止的事", "stopped", 21);
	await seedSession(db, {
		title: "已经结束的事",
		createdBy: "dave",
		status: "ended",
		createdAt: at(1),
		lastActivityAt: at(20),
		events: [...endedTurn("completed"), { type: "session_ended", by: "dave" }],
	});
	await seedSession(db, {
		title: "还没说过话的事",
		createdBy: "alice",
		status: "idle",
		createdAt: at(1),
		lastActivityAt: at(5),
	});

	await page.goto("/sessions");
	const row = (title: string) =>
		page
			.getByRole("table", { name: "会话列表" })
			.getByRole("row")
			.filter({ has: page.getByRole("link", { name: title, exact: true }) });
	const rows = page.getByRole("table", { name: "会话列表" }).getByRole("row");
	// 在做和排队中的在前（最近活动的在前），其余最近活动在前。用会重试的断言：列表还没回来时不会读到空的。
	await expect(rows.getByRole("link")).toHaveText([
		"正在做的事",
		"排在第一位的事",
		"排在第二位的事",
		"做完了的事",
		"被打断的事",
		"到了上限的事",
		"出错的事",
		"模型不可用的事",
		"被停止的事",
		"已经结束的事",
		"还没说过话的事",
	]);

	// 状态：在做、排队中第 N 位、空闲、已结束。
	await expect(row("正在做的事").getByTestId("list-status")).toHaveText("在做");
	await expect(row("排在第一位的事").getByTestId("list-status")).toHaveText("排队中 · 排在第 1 位");
	await expect(row("排在第二位的事").getByTestId("list-status")).toHaveText("排队中 · 排在第 2 位");
	await expect(row("做完了的事").getByTestId("list-status")).toHaveText("空闲");
	await expect(row("已经结束的事").getByTestId("list-status")).toHaveText("已结束");
	// 发起人是显示名。
	await expect(row("正在做的事")).toContainText("bob");
	await expect(row("排在第二位的事")).toContainText("carol");

	// 上一轮的结局不是完成时标出来；完成的和还没有结束过一轮的不标。
	const flag = (title: string) => row(title).getByTestId("list-last-turn");
	await expect(flag("被打断的事")).toHaveText("上一轮被打断");
	await expect(flag("到了上限的事")).toHaveText("上一轮到了上限");
	await expect(flag("出错的事")).toHaveText("上一轮出错");
	await expect(flag("模型不可用的事")).toHaveText("上一轮模型不可用");
	await expect(flag("被停止的事")).toHaveText("上一轮已停止");
	// 在做的会话标的是这一轮之前的那一轮。
	await expect(flag("正在做的事")).toHaveText("上一轮被打断");
	await expect(flag("正在做的事")).toHaveAttribute("data-outcome", "interrupted");
	for (const title of ["做完了的事", "已经结束的事", "还没说过话的事", "排在第一位的事"]) {
		await expect(flag(title)).toHaveCount(0);
	}
});

test("会话多于接口一次给的个数：只列最近活动的 200 个，列表下面写一句（真的控制面）", async ({
	page,
	controlPlane,
}) => {
	const db = controlPlane.database.url;
	const total = SESSION_LIST_LIMIT + 1;
	const base = Date.UTC(2026, 0, 1);
	for (let first = 0; first < total; first += 25) {
		await Promise.all(
			Array.from({ length: Math.min(25, total - first) }, (_, k) =>
				seedSession(db, {
					title: `会话 ${first + k}`,
					status: "ended",
					lastActivityAt: new Date(base + (first + k) * 60_000),
				}),
			),
		);
	}
	await page.goto("/sessions");
	const rows = page.getByRole("table", { name: "会话列表" }).getByRole("row");
	await expect(rows).toHaveCount(SESSION_LIST_LIMIT + 1); // 加表头一行
	const hint = page.getByTestId("list-truncated");
	await expect(hint).toHaveText(`只显示了最近活动的 ${SESSION_LIST_LIMIT} 个会话`);
	// 提示在列表上面、一进页面就看得到（不用滚到底），和「会话」标题左对齐。
	await expect(hint).toBeInViewport({ ratio: 1 });
	const hintBox = await hint.boundingBox();
	const tableBox = await page.getByRole("table", { name: "会话列表" }).boundingBox();
	const headingBox = await page.getByRole("heading", { name: "会话", level: 2 }).boundingBox();
	if (!(hintBox && tableBox && headingBox)) throw new Error("量不到提示、表格或标题");
	expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(tableBox.y);
	expect(Math.abs(hintBox.x - headingBox.x)).toBeLessThanOrEqual(1);
	// 最近活动的在前，最早的那一个没有列出来。
	await expect(rows.nth(1)).toContainText(`会话 ${SESSION_LIST_LIMIT}`);
	await expect(page.getByRole("link", { name: "会话 0", exact: true })).toHaveCount(0);
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
	await expect(timeline(page).getByTestId("message-author")).toHaveText("tester");
	await expect(timeline(page).getByTestId("message-text")).toHaveText(
		"给 http_check 加一个超时参数",
	);
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
	// 每一轮只有一个结局：七个结局是七轮（同一轮的第二个结局页面不画）。
	const base = { reason: "原因", duration_ms: 84_000 } as const;
	const events: SessionEventBody[] = [
		{ type: "turn_end", ...base, turn: 1, outcome: "completed", steps: 12, model_calls: 9 },
		{ type: "turn_end", ...base, turn: 2, outcome: "stopped", reason: "用户停止" },
		{
			type: "turn_end",
			...base,
			turn: 3,
			outcome: "limit",
			limit_kind: "model_calls",
			model_calls: 40,
		},
		{
			type: "turn_end",
			...base,
			turn: 4,
			outcome: "limit",
			limit_kind: "duration",
			duration_ms: 1_200_000,
		},
		{ type: "turn_end", ...base, turn: 5, outcome: "interrupted", reason: "助手服务重启了" },
		{
			type: "turn_end",
			...base,
			turn: 6,
			outcome: "model_unavailable",
			reason: "额度不足（402）",
			error_class: "quota",
			steps: 7,
		},
		{ type: "turn_end", ...base, turn: 7, outcome: "failed", reason: "出了点问题" },
		{
			type: "turn_end",
			...base,
			turn: 8,
			outcome: "model_unavailable",
			reason: "对话太长，模型装不下（400）",
			error_class: "context_overflow",
			steps: 3,
		},
	];
	const id = await seedSession(controlPlane.database.url, { events });
	await page.goto(`/sessions/${id}`);
	await expect(page.getByTestId("turn-end")).toHaveText([
		"这一轮完成 · 12 步 · 用时 1m 24s",
		"已停止",
		"到了上限：40 次模型调用",
		"到了上限：用时 20m 00s",
		"中断：助手服务重启了",
		"模型不可用：额度不足（402）。这一轮做了 7 步，都在上面；工作区的改动已经提交，已触发的运行不受影响。稍后说一句话可以接着做。",
		"出错：出了点问题",
		"这次对话太长，模型装不下了。开一个新会话，工作区还在。",
	]);
});

test("历史：工具行默认折叠，展开看结果；命令写 $、读写改写路径；出错标红、被截断写明只显示了一部分", async ({
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
	await expect(rows.nth(3)).toContainText("出错 · 用时 12.3s · 输出太长，只显示了一部分");
	await expect(rows.nth(3)).toHaveAttribute("data-state", "error");
	await expect(rows.nth(4)).toContainText("出错 · 退出码 1 · 用时 30ms");
	await expect(page.getByTestId("notice")).toHaveText("上下文太长，已经压缩");

	// 默认折叠；点一行展开看结果正文，再点收起。
	await expect(page.getByTestId("tool-result")).toHaveCount(0);
	const first = rows.nth(0).getByRole("button");
	await expect(first).toHaveAttribute("aria-expanded", "false");
	await first.click();
	await expect(first).toHaveAttribute("aria-expanded", "true");
	await expect(rows.nth(0).getByTestId("tool-command")).toHaveText("$ sfly package list");
	await expect(page.getByTestId("tool-result")).toHaveText("http_check 0.3.0");
	await first.click();
	await expect(page.getByTestId("tool-result")).toHaveCount(0);
	// 没有输出的结果写明。
	await rows.nth(4).getByRole("button").click();
	await expect(page.getByTestId("tool-result")).toHaveText("（没有输出）");
});

test("提交的记录（platform 的 commit）：一行「这一轮改了 N 个文件 +a −b」和短提交号，默认折叠，展开是文件列表和差异；差异太长写明只显示了开头；补提交写是哪一轮留下的；路径里的方向控制字符写出来；刷新后一样（真的控制面）", async ({
	page,
	controlPlane,
}) => {
	const hash = "3f1c2ab9d0e4a5b6c7d8e9f00112233445566778";
	const files = [
		{ path: "nodes/http_check.py", additions: 12, deletions: 3 },
		{ path: "assets/logo.png", additions: null, deletions: null },
	];
	const commit = (turn: number, over: Record<string, unknown> = {}): SessionEventBody =>
		({
			type: "platform",
			kind: "commit",
			turn,
			hash,
			files,
			diff: "diff --git a/nodes/http_check.py b/nodes/http_check.py\n+timeout = 30\n",
			truncated: false,
			...over,
		}) as SessionEventBody;
	const say = (text: string): SessionEventBody => ({
		type: "user_message",
		message_id: randomUUID(),
		text,
		steer: false,
		author: "alice",
		author_user_id: null,
	});
	const end = (turn: number): SessionEventBody => ({
		type: "turn_end",
		turn,
		outcome: "completed",
		reason: "",
		duration_ms: 1000,
	});
	const events: SessionEventBody[] = [
		say("给 http_check 加超时"),
		{ type: "turn_started", turn: 1 },
		{ type: "assistant_message", text: "改好了。", usage: USAGE },
		commit(1),
		end(1),
		say("接着做"),
		{ type: "turn_started", turn: 2 },
		// 第 1 轮被打断时留下的改动，在第 2 轮开始前补提交的。
		commit(1, {
			truncated: true,
			hash: "b".repeat(40),
			files: [{ path: "big.txt", additions: 20_000, deletions: 0 }],
		}),
		// 路径里有从右到左的覆盖字符：写出来，不让它把旁边的字带反。
		commit(2, {
			hash: "c".repeat(40),
			files: [{ path: "evil\u202Efdp.py", additions: 1, deletions: 0 }],
		}),
		end(2),
	];
	const id = await seedSession(controlPlane.database.url, { events });
	for (const reload of [false, true]) {
		if (reload) await page.reload();
		else await page.goto(`/sessions/${id}`);
		const rows = page.getByTestId("commit-row");
		await expect(rows).toHaveCount(3);
		// 一行摘要和短提交号；不是「助手的话」，也不是工具行。
		await expect(rows.nth(0).getByTestId("commit-summary")).toHaveText(
			"这一轮改了 2 个文件 +12 −3",
		);
		await expect(rows.nth(0).getByTestId("commit-hash")).toContainText("3f1c2ab");
		await expect(rows.nth(0).getByTestId("commit-hash")).toHaveAttribute("title", hash);
		await expect(rows.nth(0)).not.toHaveAttribute("data-leftover");
		await expect(rows.nth(1)).toHaveAttribute("data-leftover", "true");
		await expect(rows.nth(1).getByTestId("commit-summary")).toHaveText(
			"第 1 轮被打断时留下的改动：1 个文件 +20000 −0",
		);
		await expect(page.getByTestId("assistant-message")).toHaveCount(1);
		await expect(page.getByTestId("tool-row")).toHaveCount(0);
		// 默认折叠。
		const first = rows.nth(0);
		await expect(first.getByRole("button")).toHaveAttribute("aria-expanded", "false");
		await expect(first.getByTestId("commit-files")).toHaveCount(0);
		await expect(first.getByTestId("commit-diff")).toHaveCount(0);
		// 展开：文件列表（增删行数，二进制写「二进制文件」）和差异；差异没有被截断，没有那句说明。
		await first.getByRole("button").click();
		await expect(first.getByRole("button")).toHaveAttribute("aria-expanded", "true");
		const listed = first.getByTestId("commit-file");
		await expect(listed).toHaveCount(2);
		await expect(listed.nth(0)).toContainText("nodes/http_check.py");
		await expect(listed.nth(0)).toContainText("+12");
		await expect(listed.nth(0)).toContainText("−3");
		await expect(listed.nth(1)).toContainText("assets/logo.png");
		await expect(listed.nth(1)).toContainText("二进制文件");
		await expect(first.getByTestId("commit-diff")).toContainText("+timeout = 30");
		await expect(first.getByTestId("commit-truncated")).toHaveCount(0);
		// 收起。
		await first.getByRole("button").click();
		await expect(first.getByTestId("commit-files")).toHaveCount(0);
		// 差异太长只存了开头：写明。
		await rows.nth(1).getByRole("button").click();
		await expect(rows.nth(1).getByTestId("commit-truncated")).toHaveText("差异太长，只显示了开头");
		// 别人写的路径经不可信文字组件：覆盖字符写成 U+202E，页面上没有原样的控制字符。
		await rows.nth(2).getByRole("button").click();
		const evil = rows.nth(2).getByTestId("commit-file");
		await expect(evil).toContainText("U+202E");
		expect(await evil.evaluate((el) => el.textContent?.includes("\u202e"))).toBe(false);
	}
});

test("提交的记录：一轮在做时到的 commit 事件排在这一轮的结局前面，不改会话的状态", async ({
	page,
}) => {
	await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	await pushEvent(page, commitEvent(3));
	await expect(page.getByTestId("commit-row")).toHaveCount(1);
	await expect(page.getByTestId("session-status")).toHaveText("在做");
	await pushEvent(page, turnEnd(4, "completed"));
	const kinds = await timeline(page)
		.getByRole("listitem")
		.evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
	expect(kinds).toEqual(["user-message", "commit-row", "turn-end"]);
	// 同一个序号再来一次（重连后补发）：不重复。
	await pushEvent(page, commitEvent(3));
	await expect(page.getByTestId("commit-row")).toHaveCount(1);
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
	await expect(timeline(page).getByTestId("message-author")).toHaveText("alice");
	await expect(timeline(page).getByTestId("message-text")).toHaveText("给 http_check 加超时");
	await expect(page.getByTestId("session-status")).toHaveText("在做");
	await expect(page.getByRole("button", { name: "停止" })).toBeVisible();
	// 在做时输入框照常可以写，发出去的是插话：输入框下写插话什么时候送到。
	await expect(composer(page)).toBeEnabled();
	await expect(page.getByTestId("composer-hint")).toHaveText(
		"插话在当前这一步做完后送到；要马上停下用停止",
	);
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
	// 在做的行也能展开：看完整的命令（还没有结果）。
	await row.getByRole("button").click();
	await expect(row.getByTestId("tool-command")).toHaveText("$ sfly package list");
	await expect(row.getByTestId("tool-result")).toHaveCount(0);
	await row.getByRole("button").click();
	await push(toolResult(5, "call_1", { exit_code: 0, text: "http_check 0.3.0\n" }));
	await expect(row).toHaveAttribute("data-state", "done");
	await expect(row).toContainText("退出码 0 · 用时 420ms");
	await row.getByRole("button").click();
	await expect(page.getByTestId("tool-result")).toHaveText("http_check 0.3.0");
	await row.getByRole("button").click();

	await push(toolCall(6, "call_2", "edit", "nodes/http_check.py"));
	await push(toolResult(7, "call_2", { is_error: true, truncated: true, text: "没改成" }));
	await expect(toolRows(page).nth(1)).toContainText("出错 · 用时 420ms · 输出太长，只显示了一部分");

	// 一轮结束：「这一轮完成」，会话回到空闲，可以接着说。
	await push(turnEnd(8, "completed", { steps: 2, model_calls: 3 }));
	await expect(page.getByTestId("turn-end")).toHaveText("这一轮完成 · 2 步 · 用时 1m 24s");
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
	await expect(composer(page)).toBeEnabled();

	// 刷新：时间线和刷新前一样（刷新后读回的是持久的事件；会话视图是控制面此刻读的，这一轮结束了就是空闲）。
	view.status = "idle";
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
	// 没有对上调用的工具输出、什么现场都没有的快照：不画任何东西。
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
		queue_position: null,
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
	// 记下依次获得焦点的元素：「停止」消失之后焦点直接交给输入框，中间不经过页面标题（焦点恢复的兜底去向）。
	await page.addInitScript(() => {
		const seen: string[] = [];
		(window as unknown as { __focused: string[] }).__focused = seen;
		document.addEventListener(
			"focusin",
			(event) => seen.push(event.target instanceof Element ? event.target.tagName : "?"),
			true,
		);
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
	// 点「停止」的按钮随这一轮消失：焦点回到输入框，不落在 body 上，也不先落在页面标题上。
	await expect(composer(page)).toBeFocused();
	expect(
		await page.evaluate(() => (window as unknown as { __focused: string[] }).__focused),
	).toEqual(["BUTTON", "TEXTAREA"]);
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
	// 失败之后按钮恢复可点，焦点还在它上面（请求在路上时它只是 aria-disabled，没有被浏览器夺走焦点）。
	const stop = page.getByRole("button", { name: "停止" });
	await expect(stop).not.toHaveAttribute("aria-disabled", "true");
	await expect(stop).toBeFocused();
});

test("停止的请求在路上（慢）：「停止」不可点但保留焦点；这一轮结束之后焦点交给输入框；会话同时结束时没有输入框，焦点落在页面标题", async ({
	page,
}) => {
	for (const mode of ["turn_end", "session_ended"] as const) {
		const view = sessionView({ status: "running" });
		await installSessionStream(page);
		await stubSessionDetail(page, view, [userMessage(1), turnStarted(2)]);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let stops = 0;
		await page.route(new RegExp(`/api/sessions/${view.id}/stop$`), async (route) => {
			stops++;
			await gate;
			await fulfillJson(route, 200, { ...view, status: "running" });
		});
		await page.goto(`/sessions/${view.id}`);
		const stop = page.getByRole("button", { name: "停止" });
		await stop.click();
		await expect.poll(() => stops).toBe(1);
		// 请求在路上：不可点（再点不会再发一个请求），但焦点还在按钮上，不是被禁用夺走了。
		await expect(stop).toHaveAttribute("aria-disabled", "true");
		await expect(stop).toBeFocused();
		// 读屏听到的是「正在停止…」，不是只有「不可用」的「停止」（和「发送」的「正在发送…」一样）。
		await expect(stop).toHaveText("正在停止…");
		await stop.click({ force: true });
		expect(stops).toBe(1);
		release();
		if (mode === "turn_end") {
			await pushEvent(page, turnEnd(3, "stopped"));
			await expect(page.getByTestId("session-status")).toHaveText("空闲");
			await expect(stop).toHaveCount(0);
			await expect(composer(page)).toBeFocused();
		} else {
			await pushEvent(page, { type: "session_ended", seq: 3, at: eventAt(), by: "alice" });
			await expect(page.getByTestId("session-status")).toHaveText("已结束");
			await expect(stop).toHaveCount(0);
			await expect(composer(page)).toHaveCount(0);
			// 声明的接班元素（输入框）已经没有了：退回原来的规则，交给页面标题。
			await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
		}
		await page.unrouteAll({ behavior: "ignoreErrors" });
	}
});

// ---------------------------------------------------------------- 会话页：接着说

test("接着说：空闲时可以发（请求里是写好的话），发完清空；在做时发出去的是插话（按钮写「发送插话」，输入框下写什么时候送到）；已结束时不显示", async ({
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
	// 在做时输入框照常可以写，发出去的是插话：按钮写「发送插话」，输入框下写插话什么时候送到。
	await expect(composer(page)).toBeEnabled();
	await expect(page.getByRole("button", { name: "发送插话" })).toBeDisabled(); // 还没写话
	await expect(page.getByTestId("composer-hint")).toHaveText(
		"插话在当前这一步做完后送到；要马上停下用停止",
	);
	await composer(page).fill("先别改测试");
	await page.getByRole("button", { name: "发送插话" }).click();
	await expect.poll(() => posts).toEqual([{ text: "再加一个重试次数" }, { text: "先别改测试" }]);
	await expect(composer(page)).toHaveValue("");

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

for (const [code, text] of [
	["session_queued", "这个会话在排队，等它开始之后再说，或者先停止"],
	["session_ended", "这个会话已经结束或者正在结束，不能再说话"],
] as const) {
	test(`接着说被拒绝（${code}）：留住写好的话，写明原因`, async ({ page, controlPlane }) => {
		const id = await seedSession(controlPlane.database.url, { status: "idle", events: [] });
		await page.route(/\/api\/sessions\/[^/]+\/messages$/, (route) =>
			apiError(route, 409, code, "服务端的那句话"),
		);
		await page.goto(`/sessions/${id}`);
		await composer(page).fill("再加一个重试次数");
		await page.getByRole("button", { name: "发送" }).click();
		await expect(page.getByRole("alert").filter({ hasText: text })).toBeVisible();
		await expect(composer(page)).toHaveValue("再加一个重试次数");
	});
}

test("没有配置助手时接着说：控制面真的返回 503，留住写好的话，写明原因", async ({
	page,
	controlPlane,
}) => {
	const id = await seedSession(controlPlane.database.url, { status: "idle", events: [] });
	await page.goto(`/sessions/${id}`);
	await composer(page).fill("再加一个重试次数");
	const response = page.waitForResponse(
		(r) => r.url().endsWith(`/api/sessions/${id}/messages`) && r.request().method() === "POST",
	);
	await page.getByRole("button", { name: "发送" }).click();
	expect((await response).status()).toBe(503);
	await expect(page.getByRole("alert").filter({ hasText: "助手没有开启" })).toContainText(
		"无法发送",
	);
	await expect(composer(page)).toHaveValue("再加一个重试次数");
});

// ---------------------------------------------------------------- 会话页：插话、排队、结束会话（#544）

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const userRows = (page: Page) => timeline(page).getByTestId("user-message");
const row = (page: Page, text: string) => userRows(page).filter({ hasText: text });

/** 打开一个会话页：详情（会话视图和已有的持久事件）是拦截的，事件流由测试推。 */
async function openSession(
	page: Page,
	over: Record<string, unknown>,
	persisted: SessionEvent[],
): Promise<ReturnType<typeof sessionView>> {
	const view = sessionView(over);
	await installSessionStream(page);
	await stubSessionDetail(page, view, persisted);
	await page.goto(`/sessions/${view.id}`);
	// 事件流订阅上了再返回：订阅之前推的事件就丢了。
	await expect(page.getByTestId("session-status")).toBeVisible();
	await expect.poll(async () => (await streamOpens(page)).opened).toBe(1);
	return view;
}

test("插话：在做时说的话标「插话」，先是等待送达；steer_queue 里不再有它之后变成已送到；没有送到的写明，通知给的那句说明也在时间线上", async ({
	page,
}) => {
	await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	// 用户在这个页面发出了两句插话：控制面写 user_message（steer 为 true）。
	await pushEvent(page, steerMessage(3, A, "先别改测试"));
	await pushEvent(page, steerMessage(4, B, "再加一条日志"));
	await expect(row(page, "先别改测试")).toHaveAttribute("data-role", "steer");
	await expect(row(page, "先别改测试").getByTestId("message-role")).toHaveText("插话");
	await expect(row(page, "先别改测试").getByTestId("message-delivery")).toHaveText("等待送达");
	await expect(row(page, "再加一条日志").getByTestId("message-delivery")).toHaveText("等待送达");
	// 助手服务发来还没送到的完整列表：两句都在，仍是等待送达。
	await pushEvent(page, steerQueue(A, B));
	await expect(row(page, "先别改测试").getByTestId("message-delivery")).toHaveText("等待送达");
	// 第一句送到了（列表里只剩第二句）。
	await pushEvent(page, steerQueue(B));
	await expect(row(page, "先别改测试").getByTestId("message-delivery")).toHaveText("已送到");
	await expect(row(page, "再加一条日志").getByTestId("message-delivery")).toHaveText("等待送达");
	// 第二句没有送到：先有通知（带它的 message_id），再有不含它的列表。
	await pushEvent(
		page,
		steerDropped(5, B, "这句插话没有确认送到助手（助手服务没有及时回应），需要的话再说一次"),
	);
	await pushEvent(page, steerQueue());
	const dropped = row(page, "再加一条日志");
	await expect(dropped.getByTestId("message-delivery")).toHaveText("没有送到");
	await expect(dropped).toHaveAttribute("data-delivery", "dropped");
	// 通知那一行写着是「没有送到」还是「没有确认送到」，由控制面或助手服务的那句话说，页面不改写。
	await expect(page.getByTestId("notice")).toContainText("没有确认送到助手");
	// 同一句话再来一条通知（助手服务之后又确认没送到）：通知只显示一次。
	await pushEvent(page, steerDropped(6, B, "这句插话没有送到：「再加一条日志」"));
	await expect(page.getByTestId("notice")).toHaveCount(1);
	await expect(dropped.getByTestId("message-delivery")).toHaveText("没有送到");
});

test("插话：这一轮结束时没有 steer_dropped 的都算送到；刷新后读历史，已经结束的一轮里的插话按有没有 steer_dropped 判断", async ({
	page,
}) => {
	const persisted: SessionEvent[] = [
		userMessage(1),
		turnStarted(2),
		steerMessage(3, A, "送到了的话"),
		steerMessage(4, B, "没送到的话"),
		steerDropped(5, B, "这句插话没有送到：「没送到的话」"),
		turnEnd(6, "stopped"),
	];
	await openSession(page, { status: "idle" }, persisted);
	await expect(row(page, "送到了的话").getByTestId("message-delivery")).toHaveText("已送到");
	await expect(row(page, "没送到的话").getByTestId("message-delivery")).toHaveText("没有送到");
	// 「已停止」不写原因：助手服务写的原因不一定是用户点的停止。
	await expect(page.getByTestId("turn-end")).toHaveText("已停止");
});

test("补发的次序：晚到的 steer_queue、turn_queued 属于已经过去的一轮，不改插话的状态，也不让会话变成排队中", async ({
	page,
}) => {
	await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	await pushEvent(page, steerMessage(3, A, "先别改测试"));
	await pushEvent(page, steerQueue(A));
	await pushEvent(page, turnEnd(4, "completed"));
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	await expect(row(page, "先别改测试").getByTestId("message-delivery")).toHaveText("已送到");
	// 补发把不持久的事件排在后面放出：这一轮的队列、位置这时才到。
	await pushEvent(page, steerQueue(A));
	await pushEvent(page, turnQueued(1));
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	await expect(row(page, "先别改测试").getByTestId("message-delivery")).toHaveText("已送到");
	await expect(composer(page)).toBeEnabled();
	await expect(page.getByTestId("composer-blocked")).toHaveCount(0);
});

test("排队中：顶栏写排第几，输入框不可用并写「排在第 N 位：<标题>（<发起人>）正在做」，位置前进时跟着变；开始之后可以插话", async ({
	page,
}) => {
	await openSession(page, { status: "queued", queue_position: 2, waiting_for: WAITING_FOR }, [
		userMessage(1, "要做的事"),
	]);
	await expect(page.getByTestId("session-status")).toHaveText("排队中 · 排在第 2 位");
	await expect(composer(page)).toBeDisabled();
	// 不可用的输入框里也写原因（它看起来和可用的差不多）。
	await expect(composer(page)).toHaveAttribute("placeholder", "排队中，轮到它之后才能说话");
	const note = page.getByTestId("composer-blocked");
	await expect(note).toHaveText("排在第 2 位：别人在做的事（bob）正在做");
	await expect(note.getByRole("link", { name: "别人在做的事" })).toHaveAttribute(
		"href",
		`/sessions/${WAITING_FOR.session_id}`,
	);
	// 前面的会话做完一轮，位置前进。
	await pushEvent(page, turnQueued(1));
	await expect(page.getByTestId("session-status")).toHaveText("排队中 · 排在第 1 位");
	await expect(note).toHaveText("排在第 1 位：别人在做的事（bob）正在做");
	// 轮到它：开始这一轮。
	await pushEvent(page, turnStarted(2));
	await expect(page.getByTestId("session-status")).toHaveText("在做");
	await expect(composer(page)).toBeEnabled();
	await expect(page.getByRole("button", { name: "发送插话" })).toBeDisabled();
	await expect(page.getByTestId("composer-blocked")).toHaveCount(0);
});

test("排队中点「停止」是移出队列：请求发给停止接口，时间线上排着的那句话标「已撤掉」，会话回到空闲", async ({
	page,
}) => {
	const view = await openSession(
		page,
		{ status: "queued", queue_position: 1, waiting_for: WAITING_FOR },
		[userMessage(1, "要做的事", { message_id: A })],
	);
	const stops: string[] = [];
	await page.route(new RegExp(`/api/sessions/${view.id}/stop$`), async (route) => {
		stops.push(route.request().method());
		await fulfillJson(route, 200, { ...view, status: "idle", queue_position: null });
	});
	const stop = page.getByRole("button", { name: "停止" });
	await expect(stop).toHaveAttribute("title", "移出队列：这句话不会交给助手");
	await stop.click();
	await expect.poll(() => stops).toEqual(["POST"]);
	await pushEvent(page, queueCancelled(2, A));
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
	await expect(row(page, "要做的事")).toHaveAttribute("data-role", "cancelled");
	await expect(row(page, "要做的事").getByTestId("message-role")).toHaveText("已撤掉");
	// 删除线只划话本身，整行（`li`）、名字那一行和「已撤掉」标记没有：父元素的删除线会把标记也划掉。
	await expect(row(page, "要做的事")).toHaveCSS("text-decoration-line", "none");
	await expect(row(page, "要做的事").getByTestId("message-role")).toHaveCSS(
		"text-decoration-line",
		"none",
	);
	await expect(row(page, "要做的事").getByTestId("message-text")).toHaveCSS(
		"text-decoration-line",
		"line-through",
	);
	await expect(page.getByTestId("notice")).toHaveText("这句话排队时被取消了，没有交给助手");
	await expect(composer(page)).toBeEnabled();
	await expect(stop).toHaveCount(0);
});

test("停止途中说的话：不是插话，标「排在这一轮后面」，输入框写明这一轮在停止；再点一次停止（按钮写「撤掉排着的话」）撤掉它；这一轮结束之后会话是排队中", async ({
	page,
}) => {
	const view = await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stops: number[] = [];
	await page.route(new RegExp(`/api/sessions/${view.id}/stop$`), async (route) => {
		stops.push(stops.length + 1);
		if (stops.length === 1) await gate;
		await fulfillJson(route, 200, { ...view, status: "running" });
	});
	// 第一次点停止：这一轮在停止，请求在路上。
	await page.getByRole("button", { name: "停止" }).click();
	await expect.poll(() => stops).toEqual([1]);
	// 用户（也可能是别的人）这时说了话：steer 为 false，一轮还在进行。
	await pushEvent(page, userMessage(3, "停下来之后的话", { message_id: A }));
	await pushEvent(page, turnQueued(1, { ...WAITING_FOR, title: view.title }));
	await expect(row(page, "停下来之后的话")).toHaveAttribute("data-role", "behind");
	await expect(row(page, "停下来之后的话").getByTestId("message-role")).toHaveText(
		"排在这一轮后面",
	);
	await expect(row(page, "停下来之后的话").getByTestId("message-delivery")).toHaveCount(0);
	await expect(composer(page)).toBeDisabled();
	await expect(composer(page)).toHaveAttribute("placeholder", "这一轮正在停止，暂时不能说话");
	await expect(page.getByTestId("composer-blocked")).toHaveText(
		"这一轮正在停止，有话排在它后面（第 1 位）；不想让它开始，点「撤掉排着的话」",
	);
	await expect(page.getByTestId("session-status")).toHaveText("在做");
	// 再点一次停止（请求在路上也可点）：撤掉那句话。
	const cancel = page.getByRole("button", { name: "撤掉排着的话" });
	await expect(cancel).toBeEnabled();
	await cancel.click();
	await expect.poll(() => stops).toEqual([1, 2]);
	await pushEvent(page, queueCancelled(4, A));
	await expect(row(page, "停下来之后的话")).toHaveAttribute("data-role", "cancelled");
	await expect(composer(page)).toBeEnabled();
	release();
	// 这一轮停下来：没有话排着，会话回到空闲。
	await pushEvent(page, turnEnd(5, "stopped"));
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
});

test("撤掉排着的话失败：提示写「没能撤掉排着的话」，不写「无法停止这一轮」；按钮和说明不变，可以再点", async ({
	page,
}) => {
	const view = await openSession(
		page,
		{ status: "running", queue_position: 1, waiting_for: { ...WAITING_FOR, title: "自己" } },
		[userMessage(1), turnStarted(2), userMessage(3, "停下来之后的话", { message_id: A })],
	);
	let calls = 0;
	await page.route(new RegExp(`/api/sessions/${view.id}/stop$`), (route) => {
		calls += 1;
		return apiError(route, 503, "assistant_unavailable", "助手服务连不上");
	});
	const cancel = page.getByRole("button", { name: "撤掉排着的话" });
	await cancel.click();
	const toast = page.locator("[data-sonner-toast]").filter({ hasText: "没能撤掉排着的话" });
	await expect(toast).toContainText("助手服务连不上");
	await expect(
		page.locator("[data-sonner-toast]").filter({ hasText: "无法停止这一轮" }),
	).toHaveCount(0);
	await expect(cancel).toBeEnabled();
	await expect(row(page, "停下来之后的话")).toHaveAttribute("data-role", "behind");
	await cancel.click();
	await expect.poll(() => calls).toBe(2);
});

test("停止途中说的话没有被撤掉：这一轮结束之后会话是排队中，轮到它时那句话成了开一轮的话", async ({
	page,
}) => {
	await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	await pushEvent(page, userMessage(3, "停下来之后的话", { message_id: A }));
	await pushEvent(page, turnQueued(1));
	await pushEvent(page, turnEnd(4, "stopped"));
	await expect(page.getByTestId("session-status")).toHaveText("排队中 · 排在第 1 位");
	await expect(row(page, "停下来之后的话")).toHaveAttribute("data-role", "behind");
	await expect(composer(page)).toBeDisabled();
	await pushEvent(page, { ...turnStarted(5), turn: 2 });
	await expect(page.getByTestId("session-status")).toHaveText("在做");
	await expect(row(page, "停下来之后的话")).toHaveAttribute("data-role", "turn");
	await expect(composer(page)).toBeEnabled();
});

test("结束会话：点「结束会话」先确认，写明后果；取消不发请求；确认后请求发给结束接口，事件流带回 session_ended：状态已结束、一行写谁结束的、没有输入框和按钮", async ({
	page,
}) => {
	const view = await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	const ends: string[] = [];
	await page.route(new RegExp(`/api/sessions/${view.id}/end$`), async (route) => {
		ends.push(route.request().method());
		await fulfillJson(route, 200, { ...view, status: "ended" });
	});
	await page.getByRole("button", { name: "结束会话" }).click();
	const dialog = page.getByRole("dialog", { name: "结束这个会话？" });
	// 三件后果一件一行写全。
	await expect(dialog.getByTestId("end-effects").getByRole("listitem")).toHaveText([
		"在做的一轮会停下",
		"排着的话会撤掉",
		"结束之后不能再说话",
	]);
	await expect(dialog).toContainText("工作区、提交、场景版本和运行都留着，不删除任何东西");
	await dialog.getByRole("button", { name: "取消" }).click();
	await expect(dialog).toHaveCount(0);
	expect(ends).toEqual([]);
	await page.getByRole("button", { name: "结束会话" }).click();
	await dialog.getByRole("button", { name: "结束会话" }).click();
	await expect.poll(() => ends).toEqual(["POST"]);
	await expect(dialog).toHaveCount(0);
	// 停止并等到这一轮的结局，再写 session_ended（控制面的先后）。
	await pushEvent(page, turnEnd(3, "stopped", { reason: "会话结束了" }));
	await pushEvent(page, sessionEnded(4, "bob"));
	await expect(page.getByTestId("session-status")).toHaveText("已结束");
	await expect(page.getByTestId("session-ended")).toHaveText("会话已结束（bob）");
	await expect(composer(page)).toHaveCount(0);
	await expect(page.getByText("这个会话已经结束，不能再说话")).toBeVisible();
	await expect(page.getByRole("button", { name: "结束会话" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
});

test("结束会话：请求在路上（最长等到这一轮停下）时按钮写「正在结束…」，输入框不可用；失败时留在确认框里写明原因，可以重试", async ({
	page,
}) => {
	const view = await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	await page.route(new RegExp(`/api/sessions/${view.id}/end$`), async (route) => {
		calls++;
		if (calls === 1) {
			await gate;
			await apiError(route, 409, "turn_running", "会话又开始了一轮，先停止再结束");
			return;
		}
		await fulfillJson(route, 200, { ...view, status: "ended" });
	});
	await page.getByRole("button", { name: "结束会话" }).click();
	const dialog = page.getByRole("dialog", { name: "结束这个会话？" });
	await dialog.getByRole("button", { name: "结束会话" }).click();
	const ending = dialog.getByRole("button", { name: "正在结束…" });
	await expect(ending).toBeDisabled();
	// 结束进行中再点一次不再发请求。
	await ending.click({ force: true });
	expect(calls).toBe(1);
	release();
	await expect(dialog.getByRole("alert")).toContainText("无法结束会话");
	await expect(dialog.getByRole("alert")).toContainText("会话又开始了一轮，先停止再结束");
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "结束会话" }).click();
	await expect.poll(() => calls).toBe(2);
	await expect(dialog).toHaveCount(0);
});

test("会话已经没有了（新建会话等第一轮结局期间点了停止，没有被碰过的会话被删掉）：停止遇到 404 回到列表，写一句", async ({
	page,
}) => {
	const view = await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	await page.route(new RegExp(`/api/sessions/${view.id}/stop$`), (route) =>
		apiError(route, 404, "not_found", "session not found"),
	);
	await page.getByRole("button", { name: "停止" }).click();
	await expect(page).toHaveURL(/\/sessions\/?$/);
	await expect(
		page.locator("[data-sonner-toast]").filter({ hasText: "这个会话已经没有了" }),
	).toBeVisible();
});

test("会话已经没有了：结束遇到 404 回到列表，确认框关掉，写一句", async ({ page }) => {
	const view = await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	await page.route(new RegExp(`/api/sessions/${view.id}/end$`), (route) =>
		apiError(route, 404, "not_found", "session not found"),
	);
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

test("会话已经没有了：事件流遇到 404（真的控制面里没有这个会话，详情是拦截的）不再重连，回到列表", async ({
	page,
}) => {
	const ghost = sessionView({ status: "idle" });
	await stubSessionDetail(page, ghost, [userMessage(1), turnStarted(2), turnEnd(3, "completed")]);
	await page.goto(`/sessions/${ghost.id}`);
	await expect(page).toHaveURL(/\/sessions\/?$/);
});

// ---------------------------------------------------------------- #713 第一次审查之后

test("有话排在这一轮后面：刷新之后（这个页面没点过停止）按钮的字也是「撤掉排着的话」，不是「停止」", async ({
	page,
}) => {
	await openSession(
		page,
		{ status: "running", queue_position: 1, waiting_for: { ...WAITING_FOR, title: "自己" } },
		[userMessage(1), turnStarted(2), userMessage(3, "停下来之后的话", { message_id: A })],
	);
	await expect(row(page, "停下来之后的话")).toHaveAttribute("data-role", "behind");
	const cancel = page.getByRole("button", { name: "撤掉排着的话" });
	await expect(cancel).toBeVisible();
	await expect(cancel).toHaveAttribute("title", "撤掉排在这一轮后面的话，不开始新的一轮");
	await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
	await expect(page.getByTestId("composer-blocked")).toContainText("点「撤掉排着的话」");
	await expect(page.getByTestId("composer-blocked")).not.toContainText("再点一次");
});

test("排队说明：标题是阿拉伯文、昵称是希伯来文，「正在做」在昵称之后（控制台自己的字不进方向隔离）", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await openSession(
		page,
		{
			status: "queued",
			queue_position: 11,
			waiting_for: {
				session_id: WAITING_FOR.session_id,
				title: "عنوان الجلسة الطويل جدا",
				created_by: "שם המשתמש",
			},
		},
		[userMessage(1, "要做的事")],
	);
	const note = page.getByTestId("composer-blocked");
	await expect(note).toContainText("正在做");
	const places = await note.evaluate((element) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		let suffix: DOMRect | null = null;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const at = node.textContent?.indexOf("正在做") ?? -1;
			if (at < 0) continue;
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + 3);
			suffix = range.getBoundingClientRect();
		}
		const nickname = [...element.querySelectorAll("bdi")].at(-1)?.getBoundingClientRect();
		return { suffixLeft: suffix?.left ?? null, nicknameRight: nickname?.right ?? null };
	});
	expect(places.suffixLeft).not.toBeNull();
	expect(places.nicknameRight).not.toBeNull();
	// 在昵称的右边（左到右排版）：「）正在做」不会被昵称的方向带到它的左边去。
	expect(places.suffixLeft as number).toBeGreaterThanOrEqual((places.nicknameRight as number) - 1);
});

test("别人写的文字都经公共的不可信文字组件：页头的标题、列表里的标题和发起人、通知里引用的话、结束会话的人，方向隔离（基准方向从左到右）", async ({
	page,
}) => {
	const title = "عنوان الجلسة";
	const author = "שם המשתמש";
	const view = await openSession(page, { status: "running", title, created_by: author }, [
		userMessage(1, title, { author }),
		turnStarted(2),
		steerMessage(3, A, "كلام المستخدم", author),
		steerDropped(4, A, "这句插话没有送到：「كلام المستخدم」"),
		sessionEnded(5, author),
	]);
	// 每一处别人写的文字都在自己的 `<bdi dir="ltr">` 里：从右到左的文字自己成一段，不把旁边控制台的字带反。
	const isolated = (locator: Locator) =>
		locator.evaluate((el) => el.closest('bdi[dir="ltr"]') !== null);
	expect(await isolated(page.getByRole("heading", { level: 1 }).locator("bdi"))).toBe(true);
	expect(await isolated(page.getByTestId("notice").locator("bdi"))).toBe(true);
	expect(await isolated(page.getByTestId("session-ended").locator("bdi"))).toBe(true);
	expect(await isolated(row(page, "كلام المستخدم").locator("bdi").first())).toBe(true);
	await stubSessionList(page, READY, [{ ...view, status: "running" }]);
	await page.goto("/sessions");
	const rowOfSession = page.locator(`[data-session="${view.id}"]`);
	await expect(rowOfSession).toBeVisible();
	const cells = rowOfSession.locator("td");
	// 标题那一格是按文字截断的（`Truncate untrusted`）：截断层自己是从左到右、隔离的（`dir="ltr"`），里面不再包 `<bdi>`。
	await expect(cells.nth(0).locator('[data-truncate-clip][dir="ltr"]')).toBeVisible();
	expect(await isolated(cells.nth(1).locator("bdi").first())).toBe(true);
});

test("读屏：排到了、插话没有送到、会话被别人结束各播一句（页面里已有的播报区）", async ({
	page,
}) => {
	await openSession(page, { status: "queued", queue_position: 1, waiting_for: WAITING_FOR }, [
		userMessage(1, "要做的事"),
	]);
	const live = page.locator("output[aria-live=polite]");
	await expect(live).toHaveText("");
	await pushEvent(page, turnStarted(2));
	await expect(live).toHaveText("轮到这个会话了，助手开始做");
	await pushEvent(page, steerMessage(3, A, "先别改测试"));
	await pushEvent(page, steerDropped(4, A, "这句插话没有送到"));
	await expect(live).toHaveText("有一句插话没有送到，看时间线");
	await pushEvent(page, sessionEnded(5, "bob"));
	await expect(live).toHaveText("这个会话已经结束（bob）");
});

test("会话被别人结束时写了一半的话留在页面上：只读、可以复制，写明会话已结束", async ({ page }) => {
	await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	await composer(page).fill("写了一半的话，还没发出去");
	await pushEvent(page, sessionEnded(3, "bob"));
	await expect(page.getByTestId("session-status")).toHaveText("已结束");
	await expect(composer(page)).toHaveCount(0);
	const draft = page.getByTestId("ended-draft");
	await expect(draft).toHaveValue("写了一半的话，还没发出去");
	await expect(draft).toHaveAttribute("readonly", "");
	await expect(page.getByText("没有发出去的话还在这里，可以复制：")).toBeVisible();
	// 没有写过话的会话：没有这一块。
});

const liveRegion = (page: Page) => page.locator("output[aria-live=polite]");

test("读屏：打开一个历史里已经有结局和没送到的插话的会话，播报区是空的（打开页面不播）", async ({
	page,
}) => {
	await openSession(page, { status: "idle" }, [
		userMessage(1),
		turnStarted(2),
		steerMessage(3, A, "先别改测试"),
		steerDropped(4, A, "这句插话没有送到"),
		turnEnd(5, "completed"),
	]);
	// 打开页面（`openSession` 已经等到事件流订阅上了，页面的副作用都跑过了）：历史里的事不是刚发生的。
	await expect(row(page, "先别改测试").getByTestId("message-delivery")).toHaveText("没有送到");
	await expect(liveRegion(page)).toHaveText("");
});

test("读屏：往前翻页读进来的更早的一页里有结局和没送到的插话，播报区不变", async ({ page }) => {
	const view = sessionView({ status: "running" });
	const latest: SessionEvent[] = [userMessage(51, "现在的话"), turnStarted(52)];
	const older: SessionEvent[] = [
		userMessage(1, "很早的话"),
		turnStarted(2),
		steerMessage(3, A, "先别改测试"),
		steerDropped(4, A, "这句插话没有送到"),
		turnEnd(5, "completed"),
	];
	await installSessionStream(page);
	await page.route(new RegExp(`/api/sessions/${view.id}(\\?.*)?$`), (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const paging = new URL(route.request().url()).searchParams.has("before");
		return fulfillJson(route, 200, {
			...view,
			events: paging ? older : latest,
			has_more: !paging,
		});
	});
	await page.goto(`/sessions/${view.id}`);
	await expect.poll(async () => (await streamOpens(page)).opened).toBe(1);
	await expect(liveRegion(page)).toHaveText("");
	await page.getByRole("button", { name: "加载更早的" }).click();
	// 更早的一页读进来了（里面的结局和没送到的插话在时间线上），播报区仍是空的：它们不是刚发生的。
	await expect(page.getByTestId("turn-end")).toHaveCount(1);
	await expect(row(page, "先别改测试").getByTestId("message-delivery")).toHaveText("没有送到");
	await expect(liveRegion(page)).toHaveText("");
});

test("一轮出错、原因有好几行：分隔行和播报里换行压成一个空格，不写出「U+000A」", async ({
	page,
}) => {
	await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	await pushEvent(page, {
		...turnEnd(3, "failed"),
		reason: "上游返回：\n第一行\n第二行",
	} as SessionEvent);
	await expect(page.getByTestId("turn-end")).toHaveText("出错：上游返回： 第一行 第二行");
	await expect(liveRegion(page)).toHaveText("出错：上游返回： 第一行 第二行");
	await expect(page.getByTestId("turn-end").locator("[data-slot=hidden-character]")).toHaveCount(0);
});

test("读屏：连着两个「已停止」都播（同一句话再播一次，读屏才会再读）", async ({ page }) => {
	await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	// 记下播报区每一次的文字变化（文字没有变化就不会有变化记录）。
	await page.evaluate(() => {
		const said: string[] = [];
		(window as unknown as { __said: string[] }).__said = said;
		const region = document.querySelector("output[aria-live=polite]") as Element;
		new MutationObserver(() => said.push(region.textContent ?? "")).observe(region, {
			childList: true,
			characterData: true,
			subtree: true,
		});
	});
	const stopped = (seq: number, turn: number): SessionEvent => ({
		...turnEnd(seq, "stopped"),
		turn,
	});
	await pushEvent(page, stopped(3, 1));
	await expect(liveRegion(page)).toHaveText("已停止");
	await pushEvent(page, userMessage(4, "再来一轮"));
	await pushEvent(page, { ...turnStarted(5), turn: 2 });
	await pushEvent(page, stopped(6, 2));
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as { __said: string[] }).__said.map((text) =>
					text.replace(/\u200b/g, ""),
				),
			),
		)
		.toEqual(["已停止", "已停止"]);
});

test("会话已结束、输入框里没有话：只有一句「已经结束」，没有只读的块", async ({ page }) => {
	await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	await pushEvent(page, sessionEnded(3, "bob"));
	await expect(page.getByText("这个会话已经结束，不能再说话")).toBeVisible();
	await expect(page.getByTestId("ended-draft")).toHaveCount(0);
});

for (const order of ["事件先到", "回应先到"] as const) {
	test(`在做时说的插话遇到 503（${order}）：时间线上已经有这句话和「没有确认送到」，输入框清空，说明指向时间线上那一条，再点不会发第二句`, async ({
		page,
	}) => {
		const view = await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
		let calls = 0;
		await page.route(new RegExp(`/api/sessions/${view.id}/messages$`), async (route) => {
			calls += 1;
			const recorded = async () => {
				await pushEvent(page, steerMessage(3, A, "先别改测试"));
				await pushEvent(page, steerDropped(4, A, "这句插话没有确认送到"));
			};
			if (order === "事件先到") await recorded();
			await apiError(route, 503, "assistant_unavailable", "助手服务没有及时回应");
			if (order === "回应先到") setTimeout(() => void recorded(), 300);
		});
		await composer(page).fill("先别改测试");
		await page.getByRole("button", { name: "发送插话" }).click();
		await expect(page.getByTestId("send-recorded")).toHaveText(
			"这句话已经记在时间线上，没有确认送到：看时间线上那一条",
		);
		await expect(composer(page)).toHaveValue("");
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(row(page, "先别改测试").getByTestId("message-delivery")).toHaveText("没有送到");
		await expect(page.getByRole("button", { name: "发送插话" })).toBeDisabled();
		expect(calls).toBe(1);
	});
}

test("插话遇到 503、这句话没有记在时间线上（请求在控制面写入之前就失败了）：输入框留着，写明无法发送，可以再试", async ({
	page,
}) => {
	const view = await openSession(page, { status: "running" }, [userMessage(1), turnStarted(2)]);
	await page.route(new RegExp(`/api/sessions/${view.id}/messages$`), (route) =>
		apiError(route, 503, "assistant_unavailable", "助手没有开启"),
	);
	await composer(page).fill("先别改测试");
	await page.getByRole("button", { name: "发送插话" }).click();
	await expect(page.getByRole("alert")).toContainText("无法发送");
	await expect(composer(page)).toHaveValue("先别改测试");
	await expect(page.getByTestId("send-recorded")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "发送插话" })).toBeEnabled();
});

test("空闲的会话说话：这句话排上了队，可是页面没有收到 turn_queued（推送漏了，兜底）：页面说完话之后核对一次会话视图，得知是排队中、有停止按钮，再说一句不会撞上 409", async ({
	page,
}) => {
	const view = await openSession(page, { status: "idle" }, [
		userMessage(1),
		turnStarted(2),
		{
			type: "turn_end",
			seq: 3,
			at: eventAt(),
			turn: 1,
			outcome: "completed",
			reason: "",
			duration_ms: 1000,
		},
	]);
	await page.route(new RegExp(`/api/sessions/${view.id}/messages$`), async (route) => {
		// 控制面：写 user_message，会话排队；这一次的 turn_queued 推丢了（控制面现在项目里没有会话在做时也推，waiting_for 为 null，#545；
		// 页面说完话之后核对一次视图是兜底，这里测的就是兜底）。
		await fulfillJson(route, 200, { seq: 4 });
		await pushEvent(page, userMessage(4, "接着做", { message_id: A }));
	});
	// 之后读会话视图：排队中，没有在等谁。
	await page.route(new RegExp(`/api/sessions/${view.id}\\?`), async (route) => {
		await fulfillJson(route, 200, {
			...view,
			status: "queued",
			queue_position: 1,
			waiting_for: null,
			events: [],
			has_more: false,
		});
	});
	await composer(page).fill("接着做");
	await page.getByRole("button", { name: "发送" }).click();
	await expect(page.getByTestId("session-status")).toHaveText("排队中 · 排在第 1 位");
	await expect(page.getByRole("button", { name: "停止" })).toBeVisible();
	await expect(composer(page)).toBeDisabled();
	await expect(page.getByTestId("composer-blocked")).toContainText("等助手空出来");
});

test("会话已经没有了：说话遇到 404 回到列表，写一句", async ({ page }) => {
	const view = await openSession(page, { status: "idle" }, [userMessage(1)]);
	await page.route(new RegExp(`/api/sessions/${view.id}/messages$`), (route) =>
		apiError(route, 404, "not_found", "session not found"),
	);
	await composer(page).fill("接着说");
	await page.getByRole("button", { name: "发送" }).click();
	await expect(page).toHaveURL(/\/sessions\/?$/);
	await expect(
		page.locator("[data-sonner-toast]").filter({ hasText: "这个会话已经没有了" }),
	).toBeVisible();
});

test("会话列表的重新查询：没有在做或排队的会话时每 10 秒查一次（就绪状态里的探测结果，#498），不是 5 秒", async ({
	page,
	controlPlane,
}) => {
	await seedSession(controlPlane.database.url, { title: "已经做完的", status: "idle" });
	let lists = 0;
	page.on("request", (request) => {
		if (
			request.method() === "GET" &&
			/\/api\/projects\/[^/]+\/sessions(\?|$)/.test(request.url())
		) {
			lists += 1;
		}
	});
	await page.goto("/sessions");
	await expect(page.getByTestId("list-status")).toHaveText("空闲");
	const first = lists;
	expect(first).toBeGreaterThanOrEqual(1);
	// 过了 5 秒的轮询周期还没有新的查询……
	// biome-ignore lint/plugin/e2e-fixed-wait: 确认「没有按 5 秒查」只能等过这个周期再数请求
	await page.waitForTimeout(6_500);
	expect(lists).toBe(first);
	// ……到 10 秒时查一次。
	await expect.poll(() => lists, { timeout: 8_000 }).toBeGreaterThan(first);
});

test("会话列表的重新查询：有在做的会话时每 5 秒查一次（排位前进、做完回到空闲才看得到）", async ({
	page,
	controlPlane,
}) => {
	await seedSession(controlPlane.database.url, { title: "在做的", status: "running" });
	let lists = 0;
	page.on("request", (request) => {
		if (
			request.method() === "GET" &&
			/\/api\/projects\/[^/]+\/sessions(\?|$)/.test(request.url())
		) {
			lists += 1;
		}
	});
	await page.goto("/sessions");
	await expect(page.getByTestId("list-status")).toHaveText("在做");
	const first = lists;
	await expect.poll(() => lists, { timeout: 8_000 }).toBeGreaterThan(first);
});

// ---------------------------------------------------------------- 时间线的显示（#564 的审查）

const longPath = `/home/builder/workspace/${"deeply-nested-directory/".repeat(16)}some_module_with_a_long_name.py`;
const longUrl = `https://example.com/${"a1b2c3d4".repeat(40)}`;
/** 一条带一长串参数的命令：一行放不下。 */
const longCommand = `pytest -x -q ${Array.from({ length: 24 }, (_, i) => `tests/test_module_${i}.py::test_case_${i}`).join(" ")} | tee out.log`;

test("很长、不带空格的文字（路径、网址）在任意位置折行：不撑宽时间线，用户和助手的话、提示都能读全", async ({
	page,
	controlPlane,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const id = await seedSession(controlPlane.database.url, {
		events: [
			{
				type: "user_message",
				message_id: randomUUID(),
				text: `看一下 ${longPath}`,
				steer: false,
				author: "alice",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
			{ type: "assistant_message", text: `改好了：${longPath} 和 ${longUrl}`, usage: USAGE },
			{ type: "notice", kind: "compaction", message: `上下文太长，已压缩 ${longPath}` },
			{
				type: "turn_end",
				turn: 1,
				outcome: "completed",
				reason: "助手已完成",
				steps: 1,
				model_calls: 1,
				duration_ms: 1000,
			},
		],
	});
	await page.goto(`/sessions/${id}`);
	const list = timeline(page);
	await expect(list.getByTestId("assistant-message")).toBeVisible();
	const listBox = await list.boundingBox();
	if (!listBox) throw new Error("量不到时间线");
	for (const testId of ["user-message", "assistant-message", "notice"]) {
		const item = list.getByTestId(testId);
		await expect(item, testId).toContainText(longPath);
		// 内容没有超出这一行（折行了，不是被裁掉），这一行也没有伸出时间线。
		const overflow = await item.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(overflow, `${testId}：内容比这一行宽 ${overflow}px`).toBeLessThanOrEqual(1);
		const box = await item.boundingBox();
		expect((box?.x ?? 0) + (box?.width ?? 0), testId).toBeLessThanOrEqual(
			listBox.x + listBox.width + 1,
		);
	}
	await expect(list.getByTestId("assistant-message")).toContainText(longUrl);
	// 整个页面没有横向滚动条。
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
});

test("工具行里很长的命令：标题一行放不下，悬停给全文；每一行（有结果的、在做的、已中止的）都能展开看完整的命令", async ({
	page,
	controlPlane,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const line = `$ ${longCommand}`;
	const call = (call_id: string): SessionEventBody => ({
		type: "tool_call",
		call_id,
		tool: "command",
		title: longCommand,
	});
	const finished = await seedSession(controlPlane.database.url, {
		events: [
			{
				type: "user_message",
				message_id: randomUUID(),
				text: "跑测试",
				steer: false,
				author: "alice",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
			call("done"),
			{
				type: "tool_result",
				call_id: "done",
				is_error: false,
				text: "24 passed\n",
				truncated: false,
				exit_code: 0,
				duration_ms: 420,
			},
			call("cut"),
			{
				type: "turn_end",
				turn: 1,
				outcome: "limit",
				reason: "到了上限",
				steps: 2,
				model_calls: 40,
				duration_ms: 1_200_000,
				limit_kind: "duration",
			},
		],
	});
	const running = await seedSession(controlPlane.database.url, {
		status: "running",
		events: [
			{
				type: "user_message",
				message_id: randomUUID(),
				text: "跑测试",
				steer: false,
				author: "alice",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
			call("live"),
		],
	});

	await page.goto(`/sessions/${finished}`);
	const done = toolRows(page).nth(0);
	const cut = toolRows(page).nth(1);
	await expect(done).toHaveAttribute("data-state", "done");
	await expect(cut).toHaveAttribute("data-state", "abandoned");
	for (const [name, row] of [
		["有结果的", done],
		["已中止的", cut],
	] as const) {
		// 标题一行放不下：被截断了，悬停给全文。
		const clipped = await row
			.locator("[data-truncate-clip]")
			.first()
			.evaluate((el) => el.scrollWidth > el.clientWidth);
		expect(clipped, `${name}：命令应该放不下`).toBe(true);
		await row.getByRole("button").hover();
		await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(line);
		await page.mouse.move(5, 5);
		// 提示收起之后再点：它还在时可能压在按钮上，点击会一直等到用例超时。
		await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
		// 展开：先写完整的命令（折行，不横向溢出）。
		await row.getByRole("button").click();
		const command = row.getByTestId("tool-command");
		await expect(command, name).toHaveText(line);
		expect(
			await command.evaluate((el) => el.scrollWidth - el.clientWidth),
			name,
		).toBeLessThanOrEqual(1);
	}
	// 有结果的接着是结果正文；已中止的没有结果块。
	await expect(done.getByTestId("tool-result")).toHaveText("24 passed");
	await expect(cut.getByTestId("tool-result")).toHaveCount(0);

	// 展开的正文块不盖住外框的下圆角：外框裁切，正文的底边不超出外框。
	const frame = await done.evaluate((li) => {
		const style = getComputedStyle(li);
		const result = li.querySelector('[data-testid="tool-result"]')?.getBoundingClientRect();
		return {
			overflow: style.overflow,
			radius: Number.parseFloat(style.borderTopLeftRadius),
			bottom: li.getBoundingClientRect().bottom,
			resultBottom: result?.bottom ?? 0,
		};
	});
	expect(frame.overflow).toBe("hidden");
	expect(frame.radius).toBeGreaterThan(0);
	expect(frame.resultBottom).toBeLessThanOrEqual(frame.bottom);

	// 「已中止」和结果的摘要不是一种灰字：正文色、带一个点。
	await done.getByRole("button").click();
	const colors = await page.evaluate(() => {
		const summary = document.querySelector(
			'[data-testid="tool-row"][data-state="done"] button > span:last-child',
		);
		const aborted = document.querySelector('[data-testid="tool-abandoned"]');
		const dot = aborted?.firstElementChild?.getBoundingClientRect();
		return {
			summary: summary ? getComputedStyle(summary).color : "",
			aborted: aborted ? getComputedStyle(aborted).color : "",
			dotWidth: dot?.width ?? 0,
		};
	});
	expect(colors.aborted).not.toBe("");
	expect(colors.aborted).not.toBe(colors.summary);
	expect(colors.dotWidth).toBeGreaterThan(0);

	// 在做的行：没有结果，照样能展开看完整的命令。
	await page.goto(`/sessions/${running}`);
	const live = toolRows(page).first();
	await expect(live).toHaveAttribute("data-state", "running");
	await live.getByRole("button").click();
	await expect(live.getByTestId("tool-command")).toHaveText(line);
	await expect(live.getByTestId("tool-result")).toHaveCount(0);
});

test("接着说：在做时 Ctrl/⌘+Enter 发出的是插话；空闲时 Ctrl/⌘+Enter 发送，Enter 是换行；快捷键面板里登记了", async ({
	page,
	controlPlane,
}) => {
	const idle = await seedSession(controlPlane.database.url, { status: "idle", events: [] });
	const running = await seedSession(controlPlane.database.url, { status: "running", events: [] });
	const posts: unknown[] = [];
	await page.route(/\/api\/sessions\/[^/]+\/messages$/, async (route) => {
		posts.push(route.request().postDataJSON());
		await fulfillJson(route, 200, { seq: 7 });
	});

	await page.goto(`/sessions/${running}`);
	await composer(page).fill("先别改测试");
	await composer(page).press("Control+Enter");
	await expect.poll(() => posts).toEqual([{ text: "先别改测试" }]);
	await expect(composer(page)).toHaveValue("");
	posts.length = 0;

	await page.goto(`/sessions/${idle}`);
	await composer(page).fill("第一行");
	await composer(page).press("Enter");
	await composer(page).pressSequentially("第二行");
	await expect(composer(page)).toHaveValue("第一行\n第二行");
	expect(posts).toEqual([]);
	await composer(page).press("Control+Enter");
	await expect.poll(() => posts).toEqual([{ text: "第一行\n第二行" }]);
	await expect(composer(page)).toHaveValue("");
	// 发完焦点还在输入框里。
	await expect(composer(page)).toBeFocused();

	// 快捷键面板的「助手」一组里有这一行。
	await page.locator("body").click({ position: { x: 4, y: 4 } });
	await page.keyboard.press("?");
	const group = page.getByRole("dialog", { name: "快捷键" }).getByRole("region", { name: "助手" });
	await expect(group).toContainText("发送（输入框里）");
	await expect(group).toContainText("Ctrl");
	await expect(group).toContainText("Enter");
});

test("Ctrl/⌘+Enter 只在输入框里发送：焦点在页面上别的地方时，输入框里写了一半的话不会被发出去（会话页和助手页）", async ({
	page,
	controlPlane,
}) => {
	const idle = await seedSession(controlPlane.database.url, { status: "idle", events: [] });
	const posts: unknown[] = [];
	await page.route(/\/api\/sessions\/[^/]+\/messages$/, async (route) => {
		posts.push(route.request().postDataJSON());
		await fulfillJson(route, 200, { seq: 7 });
	});
	await page.goto(`/sessions/${idle}`);
	await composer(page).fill("写了一半的话");
	// 焦点移到页面标题上（不在输入框里）：Ctrl/⌘+Enter 什么也不做。
	await page.getByRole("heading", { level: 1 }).focus();
	await page.keyboard.press("ControlOrMeta+Enter");
	// biome-ignore lint/plugin/e2e-fixed-wait: 确认一件事没有发生（没有请求发出），没有可以等的信号
	await page.waitForTimeout(300);
	expect(posts).toEqual([]);
	await expect(composer(page)).toHaveValue("写了一半的话");
	// 回到输入框里才发。
	await composer(page).focus();
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect.poll(() => posts).toEqual([{ text: "写了一半的话" }]);

	// 助手页的新建会话一样。
	const id = await seedSession(controlPlane.database.url, { status: "running", events: [] });
	const posted: unknown[] = [];
	await stubSessionList(page, READY, [], async (route, body) => {
		posted.push(body);
		const detail = (await (await controlPlane.fetch(`/sessions/${id}`)).json()) as Record<
			string,
			unknown
		>;
		const { events: _events, has_more: _hasMore, ...view } = detail;
		await fulfillJson(route, 201, view);
	});
	await page.goto("/sessions");
	await assistantInput(page).fill("还没写完的话");
	await page.getByRole("heading", { level: 1 }).focus();
	await page.keyboard.press("ControlOrMeta+Enter");
	// biome-ignore lint/plugin/e2e-fixed-wait: 确认一件事没有发生（没有请求发出），没有可以等的信号
	await page.waitForTimeout(300);
	expect(posted).toEqual([]);
	await assistantInput(page).focus();
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
	expect(posted).toEqual([{ text: "还没写完的话" }]);
});

// 发出一句话之后焦点留在输入框（#628）：「发送」随即不可用，浏览器会让被禁用的按钮失去焦点、落到 body 上，
// 之后没有人再放回来；点按钮时按钮拿不到焦点的浏览器（Safari）里焦点本来就在 body 上。一轮结束时焦点还在输入框里。
const SEND_WAYS = {
	"鼠标点「发送」": async (page: Page) => {
		await page.getByRole("button", { name: "发送" }).click();
	},
	"Tab 到「发送」再按 Enter": async (page: Page) => {
		await page.keyboard.press("Tab");
		await expect(page.getByRole("button", { name: "发送" })).toBeFocused();
		await page.keyboard.press("Enter");
	},
	"点按钮时按钮拿不到焦点（Safari：按下时输入框失焦、焦点落到 body）": async (page: Page) => {
		await page.getByRole("button", { name: "发送" }).evaluate((button) => {
			button.addEventListener("mousedown", (event) => {
				event.preventDefault();
				(document.activeElement as HTMLElement | null)?.blur();
			});
		});
		await page.getByRole("button", { name: "发送" }).click();
	},
};

async function openIdleSession(page: Page, reply: (route: Route) => Promise<void>) {
	const view = sessionView({ status: "idle" });
	await installSessionStream(page);
	await stubSessionDetail(page, view, [userMessage(1), turnStarted(2), turnEnd(3, "completed")]);
	await page.route(new RegExp(`/api/sessions/${view.id}/messages$`), reply);
	await page.goto(`/sessions/${view.id}`);
	return view;
}

/** 这一轮开始又结束（事件流推过来）。 */
async function runOneTurn(page: Page) {
	await pushEvent(page, userMessage(4, "下一句"));
	await pushEvent(page, { ...turnStarted(5), turn: 2 });
	await expect(page.getByTestId("session-status")).toHaveText("在做");
	await pushEvent(page, turnEnd(6, "completed", { turn: 2 }));
	await expect(page.getByTestId("session-status")).toHaveText("空闲");
}

for (const [way, send] of Object.entries(SEND_WAYS)) {
	test(`接着说：${way}发出之后，焦点在输入框里，这一轮结束时还在`, async ({ page }) => {
		await openIdleSession(page, (route) => fulfillJson(route, 200, { seq: 4 }));
		await composer(page).fill("下一句");
		await send(page);
		await expect(composer(page)).toHaveValue("");
		await expect(composer(page)).toBeFocused();
		await runOneTurn(page);
		await expect(composer(page)).toBeFocused();
	});
}

test("接着说：发出之后用户自己把焦点移到别的控件上，这一轮结束时不抢回来", async ({ page }) => {
	await openIdleSession(page, (route) => fulfillJson(route, 200, { seq: 4 }));
	await composer(page).fill("下一句");
	await page.getByRole("button", { name: "发送" }).click();
	await expect(composer(page)).toHaveValue("");
	const heading = page.getByRole("heading", { level: 1 });
	await heading.focus();
	await runOneTurn(page);
	await expect(heading).toBeFocused();
	await expect(composer(page)).not.toBeFocused();
});

test("接着说：发送失败时焦点在输入框里，写好的话还在，写明原因", async ({ page }) => {
	await openIdleSession(page, (route) =>
		apiError(route, 503, "assistant_unavailable", "助手服务连不上"),
	);
	await composer(page).fill("下一句");
	await page.getByRole("button", { name: "发送" }).click();
	await expect(page.getByRole("alert").filter({ hasText: "助手服务连不上" })).toBeVisible();
	await expect(composer(page)).toHaveValue("下一句");
	await expect(composer(page)).toBeFocused();
	await expect(page.getByRole("button", { name: "发送" })).toBeEnabled();
});

// 发送的请求还在路上时（控制面先写 user_message、turn_started，再等助手服务接住这一轮：事件比响应先到），焦点在输入框里，
// 用户可以接着写；请求成功时只去掉发出去的那一句，这时写的字留着；请求失败时两段都在。
const IN_FLIGHT_WAYS = {
	"点「发送」": (page: Page) => page.getByRole("button", { name: "发送" }).click(),
	"Ctrl/⌘+Enter": (page: Page) => composer(page).press("ControlOrMeta+Enter"),
};

async function openInFlight(page: Page, outcome: "ok" | "fail") {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const posts: unknown[] = [];
	await openIdleSession(page, async (route) => {
		posts.push(route.request().postDataJSON());
		await gate;
		if (outcome === "ok") await fulfillJson(route, 200, { seq: 4 });
		else await apiError(route, 503, "assistant_unavailable", "助手服务连不上");
	});
	return { posts, release };
}

for (const [way, send] of Object.entries(IN_FLIGHT_WAYS)) {
	test(`接着说：${way}发出之后请求还在路上，用户接着写的字在请求成功时不被清掉；途中再按 Ctrl/⌘+Enter 不会重复发`, async ({
		page,
	}) => {
		const { posts, release } = await openInFlight(page, "ok");
		await composer(page).fill("第一句");
		await send(page);
		await expect.poll(() => posts.length).toBe(1);
		await expect(composer(page)).toBeFocused();
		await pushEvent(page, userMessage(4, "第一句"));
		await pushEvent(page, { ...turnStarted(5), turn: 2 });
		await expect(page.getByTestId("session-status")).toHaveText("在做");
		await page.keyboard.type("，再补一句");
		await page.keyboard.press("ControlOrMeta+Enter");
		// biome-ignore lint/plugin/e2e-fixed-wait: 确认一件事没有发生（途中再按没有发出第二个请求），没有可以等的信号
		await page.waitForTimeout(300);
		expect(posts).toHaveLength(1);
		release();
		await expect(page.getByRole("button", { name: "正在发送…" })).toHaveCount(0);
		// 发出去的「第一句」去掉了，请求在路上时写的留着。
		await expect(composer(page)).toHaveValue("，再补一句");
		expect(posts).toEqual([{ text: "第一句" }]);
	});
}

test("接着说：请求在路上时接着写了字，请求失败：发出去的话和接着写的字都在，写明原因", async ({
	page,
}) => {
	const { posts, release } = await openInFlight(page, "fail");
	await composer(page).fill("第一句");
	await page.getByRole("button", { name: "发送" }).click();
	await expect.poll(() => posts.length).toBe(1);
	await page.keyboard.type("，再补一句");
	release();
	await expect(page.getByRole("alert").filter({ hasText: "助手服务连不上" })).toBeVisible();
	await expect(composer(page)).toHaveValue("第一句，再补一句");
	await expect(composer(page)).toBeFocused();
});

test("助手页：「开始」失败时焦点在输入框里，写好的话还在，写明原因", async ({ page }) => {
	await stubSessionList(page, READY, [], async (route) => {
		await apiError(route, 503, "assistant_unavailable", "助手服务连不上");
	});
	await page.goto("/sessions");
	await assistantInput(page).fill("要做的事");
	await page.getByRole("button", { name: "开始" }).click();
	await expect(page.getByRole("alert").filter({ hasText: "助手服务连不上" })).toBeVisible();
	await expect(assistantInput(page)).toHaveValue("要做的事");
	await expect(assistantInput(page)).toBeFocused();
	await expect(page.getByRole("button", { name: "开始" })).toBeEnabled();
});

test("输入法选字时的 Ctrl/⌘+Enter 不发送（isComposing，或 Safari 在组字结束那次按键上 isComposing 已经是 false 的 keyCode 229）：会话页和助手页", async ({
	page,
	controlPlane,
}) => {
	// 两种组字中的 Enter 各一份：isComposing 为真（keyCode 是普通的 13），和 Safari 组字结束那次按键（isComposing 已经是 false，keyCode 229）；
	// 只看其中一个的实现各被一份抓到。
	const compose = (field: Locator, init: { isComposing: boolean; keyCode: number }) =>
		field.evaluate((el, init) => {
			el.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
					...init,
				}),
			);
		}, init);
	const idle = await seedSession(controlPlane.database.url, { status: "idle", events: [] });
	const posts: unknown[] = [];
	await page.route(/\/api\/sessions\/[^/]+\/messages$/, async (route) => {
		posts.push(route.request().postDataJSON());
		await fulfillJson(route, 200, { seq: 7 });
	});
	await page.goto(`/sessions/${idle}`);
	await composer(page).fill("选字中的话");
	await compose(composer(page), { isComposing: true, keyCode: 13 });
	await compose(composer(page), { isComposing: false, keyCode: 229 });
	// biome-ignore lint/plugin/e2e-fixed-wait: 确认一件事没有发生（没有请求发出），没有可以等的信号
	await page.waitForTimeout(300);
	expect(posts).toEqual([]);
	// 组字结束之后的 Ctrl/⌘+Enter 才发。
	await composer(page).press("ControlOrMeta+Enter");
	await expect.poll(() => posts).toEqual([{ text: "选字中的话" }]);

	const posted: unknown[] = [];
	await stubSessionList(page, READY, [], async (route, body) => {
		posted.push(body);
		await apiError(route, 503, "assistant_unavailable", "助手服务连不上");
	});
	await page.goto("/sessions");
	await assistantInput(page).fill("选字中的话");
	await compose(assistantInput(page), { isComposing: true, keyCode: 13 });
	await compose(assistantInput(page), { isComposing: false, keyCode: 229 });
	// biome-ignore lint/plugin/e2e-fixed-wait: 确认一件事没有发生（没有请求发出），没有可以等的信号
	await page.waitForTimeout(300);
	expect(posted).toEqual([]);
	await assistantInput(page).press("ControlOrMeta+Enter");
	await expect.poll(() => posted).toEqual([{ text: "选字中的话" }]);
});

test("助手页：Ctrl/⌘+Enter 开始会话（和「开始」按钮一样的请求）", async ({
	page,
	controlPlane,
}) => {
	const id = await seedSession(controlPlane.database.url, { status: "running", events: [] });
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
	await assistantInput(page).press("Control+Enter");
	await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
	expect(posted).toEqual({ text: "给 http_check 加一个超时参数" });
});
