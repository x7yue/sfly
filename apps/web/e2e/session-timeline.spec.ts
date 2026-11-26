import type { Page } from "@playwright/test";
import type { SessionEventBody } from "@sfly/schema";
import { seedSession } from "../../server/test/support/sessions.js";
import {
	test as live,
	startSession,
	streamReady,
	timeline,
	toolRows,
} from "./assistant-live-support";
import {
	eventAt,
	installSessionStream,
	pushEvent,
	sessionView,
	stubSessionDetail,
	toolCall,
	toolResult,
	turnStarted,
	userMessage,
} from "./assistant-support";
import { expect, test } from "./fixtures";
import {
	allItems,
	EXIT_LINE,
	firstTurn,
	MESSAGE_IDS,
	REVIEW_PLATFORM_ANSWER,
	RUN_IDS,
	SCENARIO_NAME,
} from "./session-timeline-support";

// 会话页时间线定稿（#550）：每种条目、每种状态的样子，命令输出的实时显示和滚动，长会话（翻页保持位置、「有新内容」），评论里的几处界面问题。
// 对着固定的事件序列（`session-timeline-support.ts`）：静态的直接写进控制面的库里（真的控制面读出来渲染），实时的用 #541 的假助手服务推。
// 视觉基线在 `visual.spec.ts`（全部条目、排队中、已结束）。

const TITLE = "给 http_check 加一个超时参数";
const ESC = "\u001b";

/** 写进库里的一个会话，打开它的页面。 */
async function open(
	page: Page,
	databaseUrl: string,
	events: readonly SessionEventBody[],
	status: "idle" | "running" | "queued" | "ended" = "idle",
) {
	const id = await seedSession(databaseUrl, {
		title: TITLE,
		status,
		events,
		at: new Date("2026-01-01T00:00:00Z"),
	});
	await page.goto(`/sessions/${id}`);
	return id;
}

const scroller = (page: Page) => page.getByTestId("session-scroll");

/** 滚动区域离底部多远（像素）。 */
const fromBottom = (page: Page) =>
	scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

// ---------------------------------------------------------------- 每种条目的样子

test("每种条目的样子：用户的话带名字和时间；助手的话是 Markdown；工具行有图标；平台记录有标签；提示带图标；结局和会话结束各一行", async ({
	page,
	controlPlane,
}) => {
	await open(page, controlPlane.database.url, allItems(), "ended");
	await expect(page.getByTestId("session-ended")).toHaveText("会话已结束（alice）");

	// 用户的话：名字、时间（悬停是完整的日期时间）、话。插话标「插话」并写送到了没有。
	const first = timeline(page).getByTestId("user-message").first();
	await expect(first.getByTestId("message-author")).toHaveText("alice");
	await expect(first.locator("time")).toHaveText(/^\d\d:\d\d:\d\d$/);
	await expect(first.locator("time")).toHaveAttribute("title", /2026/);
	await expect(first.getByTestId("message-text")).toContainText("给 http_check 加一个超时参数");
	const steers = timeline(page).locator('[data-role="steer"]');
	await expect(steers.nth(0).getByTestId("message-delivery")).toHaveText("已送到");
	await expect(steers.nth(1).getByTestId("message-delivery")).toHaveText("没有送到");
	await expect(steers.nth(0).getByTestId("message-role")).toHaveText("插话");

	// 助手的话：Markdown 渲染（列表、行内代码、代码块、链接）；链接文字和地址对不上时写出主机名；没有外框、没有「平台记录」标签。
	const final = page.getByTestId("assistant-message").last();
	await expect(final.locator("li")).toHaveCount(3);
	await expect(final.locator("code").filter({ hasText: /^timeout$/ })).toHaveCount(1);
	await expect(final.getByTestId("assistant-code")).toHaveText(
		"sfly run start 接口巡检 --wait --timeout 90s",
	);
	const link = final.getByRole("link", { name: /用户文档/ });
	await expect(link).toHaveAttribute("href", "https://example.com/docs");
	await expect(link).toHaveAttribute("target", "_blank");
	await expect(link).toHaveAttribute("rel", /noreferrer/);
	await expect(link).toContainText("(example.com)");
	await expect(final.getByTestId("platform-label")).toHaveCount(0);

	// 工具行：每一种一个图标，标题写 `$ <命令>`、读 / 写 / 改 <路径>。
	await expect(toolRows(page).first()).toContainText("读 nodes/http_check.py");
	await expect(toolRows(page).nth(1)).toContainText("$ sfly package list");
	await expect(toolRows(page).nth(4)).toContainText("改 nodes/http_check.py");
	await expect(toolRows(page).nth(5)).toContainText("写 tests/test_timeout.py");
	for (const row of await toolRows(page).all()) {
		await expect(row.locator("button svg").nth(1)).toBeVisible(); // 箭头之后的图标
	}

	// 平台记录：提交（2 条）、场景版本、运行（2 条）都有「平台记录」的标签；助手的话、工具行、提示没有。
	const records = timeline(page).locator("[data-platform]");
	await expect(records).toHaveCount(5);
	for (const record of await records.all()) {
		await expect(record.getByTestId("platform-label")).toHaveText("平台记录");
	}
	await expect(toolRows(page).getByTestId("platform-label")).toHaveCount(0);
	await expect(page.getByTestId("notice").getByTestId("platform-label")).toHaveCount(0);

	// 提示：每一类一个小图标，一行灰字。
	const notices = page.getByTestId("notice");
	await expect(notices).toHaveCount(5);
	await expect(notices.first()).toContainText("模型限流（429），12 秒后第 1 次重试");
	for (const notice of await notices.all()) await expect(notice.locator("svg")).toHaveCount(1);
	await expect(page.locator('[data-testid="notice"][data-kind="events_lost"]')).toBeVisible();
	await expect(page.locator('[data-testid="notice"][data-kind="context_reset"]')).toBeVisible();

	// 一轮的结束：完成是一行分隔；到了上限是提醒；中断、模型不可用、出错是醒目的一块，写明原因。
	const ends = page.getByTestId("turn-end");
	await expect(ends).toHaveCount(5);
	await expect(page.locator('[data-testid="turn-end"][data-outcome="completed"]')).toHaveText(
		"这一轮完成 · 7 步 · 用时 1m 24s",
	);
	await expect(page.locator('[data-testid="turn-end"][data-outcome="limit"]')).toHaveText(
		"到了上限：40 次模型调用",
	);
	await expect(page.getByTestId("turn-end-block")).toHaveCount(3);
	await expect(
		page.locator('[data-testid="turn-end-block"]', { hasText: "中断：助手服务重启了" }),
	).toContainText("这一轮做过的步骤都在上面");
	await expect(
		page.locator('[data-testid="turn-end-block"]', { hasText: "出错：工作台连不上" }),
	).toContainText("这一轮做过的步骤都在上面");
	// 模型不可用的原因句里已经写了「都在上面」，不再重复一句。
	await expect(
		page.locator('[data-testid="turn-end-block"]', { hasText: "模型不可用：额度不足（402）" }),
	).not.toContainText("这一轮做过的步骤都在上面");
	await expect(page.getByTestId("turn-end-note")).toHaveCount(2);

	// 一轮被中断时命令一直没有结果：已中止。
	await expect(page.locator('[data-testid="tool-row"][data-state="abandoned"]')).toContainText(
		"已中止",
	);
});

test("平台记录只看它就能说出这次会话做了什么：场景和版本、几次运行、提交了几次（设计评审的答案）", async ({
	page,
	controlPlane,
}) => {
	await open(page, controlPlane.database.url, firstTurn(), "idle");
	const records = timeline(page).locator("[data-platform]");
	await expect(records).toHaveCount(5);
	const text = (await records.allTextContents()).join("\n");
	// 版本：场景名和版本号。
	expect(text).toContain(`保存了场景「${SCENARIO_NAME}」的版本 ${REVIEW_PLATFORM_ANSWER.version}`);
	// 运行：每次一行，写运行的前 8 位。
	expect((text.match(/触发了运行/g) ?? []).length).toBe(REVIEW_PLATFORM_ANSWER.runs);
	for (const id of RUN_IDS) expect(text).toContain(id.slice(0, 8));
	// 提交：每次一行（会话开始之前留下的改动那一行单独写明）。
	expect((text.match(/个文件 \+\d+ −\d+/g) ?? []).length).toBe(REVIEW_PLATFORM_ANSWER.commits);
	expect(text).toContain("会话开始之前工作区里留下的改动");
});

// ---------------------------------------------------------------- 输出的显示：颜色码、控制字符、空行、截断、差异

test("命令的输出：颜色码整段去掉不留残文；失败命令输出中间不多出空行；展开的结果里没有转义字符", async ({
	page,
	controlPlane,
}) => {
	await open(page, controlPlane.database.url, firstTurn(), "idle");
	const row = toolRows(page).nth(2); // 并行的两个调用里先开始的那个：失败的 pytest
	await expect(row).toContainText("出错 · 退出码 1 · 用时 2.9s");
	await row.getByRole("button").click();
	const output = row.getByTestId("tool-result");
	const shown = (await output.textContent()) ?? "";
	// 整段去掉：没有 ESC，也没有 `[1m`、`[31m`、`[0m` 这样的残文。
	expect(shown).not.toContain(ESC);
	expect(shown).not.toMatch(/\[\d+(;\d+)*m/);
	expect(shown.startsWith("FAILED tests/test_http_check.py::test_timeout")).toBe(true);
	// 原文里 pytest 的一行之后有两个空行，再接退出说明：显示时压成一个空行（存的数据不改）。
	expect(shown).toContain(
		`TypeError: run() got an unexpected keyword argument 'timeout'\n\n${EXIT_LINE}`,
	);
	expect(shown).not.toContain("\n\n\n");
	await expect(output.locator("[data-slot=hidden-character]")).toHaveCount(0);
});

test("命令的输出里的其余控制字符（响铃、退格）写成可见的占位，不是原样；整段的 OSC 窗口标题和光标移动去掉", async ({
	page,
	controlPlane,
}) => {
	const events: SessionEventBody[] = [
		{
			type: "user_message",
			message_id: MESSAGE_IDS.first,
			text: "跑一下",
			steer: false,
			author: "alice",
			author_user_id: null,
		},
		{ type: "turn_started", turn: 1 },
		{ type: "tool_call", call_id: "k1", tool: "command", title: "make" },
		{
			type: "tool_result",
			call_id: "k1",
			is_error: false,
			text: `${ESC}]0;make: build${"\u0007"}${ESC}[2K${ESC}[1Gbuilding\u0007 done\bx\n`,
			truncated: false,
			exit_code: 0,
			duration_ms: 5,
		},
		{ type: "turn_end", turn: 1, outcome: "completed", reason: "", duration_ms: 1000 },
	];
	await open(page, controlPlane.database.url, events);
	const row = toolRows(page).first();
	await row.getByRole("button").click();
	const output = row.getByTestId("tool-result");
	// 窗口标题序列（含结束的响铃）、清行、光标定位整段没了；单独的响铃和退格是控制字符：写成占位。
	await expect(output).toContainText("building");
	await expect(output).not.toContainText("make: build");
	await expect(output.locator("[data-slot=hidden-character]")).toHaveCount(2);
	await expect(output.locator("[data-slot=hidden-character]").first()).toHaveAttribute(
		"title",
		/控制字符/,
	);
});

test("输出被截断：写「输出太长，只显示了一部分」（事件里只留头尾和 pi 只留末尾两种都说得通）", async ({
	page,
	controlPlane,
}) => {
	const events: SessionEventBody[] = [
		{
			type: "user_message",
			message_id: MESSAGE_IDS.first,
			text: "跑",
			steer: false,
			author: "alice",
			author_user_id: null,
		},
		{ type: "turn_started", turn: 1 },
		{ type: "tool_call", call_id: "t1", tool: "command", title: "yes | head -n 100000" },
		{
			type: "tool_result",
			call_id: "t1",
			is_error: false,
			text: "y\n".repeat(50),
			truncated: true,
			exit_code: 0,
			duration_ms: 90,
		},
		{ type: "turn_end", turn: 1, outcome: "completed", reason: "", duration_ms: 1000 },
	];
	await open(page, controlPlane.database.url, events);
	const row = toolRows(page).first();
	await expect(row).toContainText("退出码 0 · 用时 90ms · 输出太长，只显示了一部分");
	await row.getByRole("button").click();
	await expect(row.getByTestId("tool-truncated")).toHaveText("输出太长，只显示了一部分");
	await expect(page.getByText("只显示了头尾")).toHaveCount(0);
});

test("编辑的工具行展开后是差异：增的行绿、删的行红、没动的行次要色；差异下面是结果的那句话", async ({
	page,
	controlPlane,
}) => {
	await open(page, controlPlane.database.url, firstTurn(), "idle");
	const row = toolRows(page).nth(4);
	await expect(row).toContainText("改 nodes/http_check.py");
	await row.getByRole("button").click();
	const diff = row.getByTestId("tool-diff");
	await expect(diff).toBeVisible();
	await expect(diff.locator('[data-diff="add"]')).toHaveCount(2);
	await expect(diff.locator('[data-diff="del"]')).toHaveCount(2);
	await expect(diff.locator('[data-diff="context"]')).toHaveCount(1);
	// 颜色之外靠行首的 `+`、`-`：原文就有的字符，色觉缺陷、强制颜色下读起来一样。
	await expect(diff.locator('[data-diff="add"]').first()).toContainText(
		"+1 def run(url: str, timeout",
	);
	const green = await diff
		.locator('[data-diff="add"]')
		.first()
		.evaluate((el) => getComputedStyle(el).color);
	const red = await diff
		.locator('[data-diff="del"]')
		.first()
		.evaluate((el) => getComputedStyle(el).color);
	const plain = await diff
		.locator('[data-diff="context"]')
		.first()
		.evaluate((el) => getComputedStyle(el).color);
	expect(new Set([green, red, plain]).size).toBe(3);
	await expect(row.getByTestId("tool-result")).toHaveText(
		"Successfully replaced 1 block(s) in nodes/http_check.py.",
	);
	// 不是编辑的行没有差异块。
	const other = toolRows(page).nth(1);
	await other.getByRole("button").click();
	await expect(other.getByTestId("tool-diff")).toHaveCount(0);
});

test("提交的记录展开后差异也分增删两种颜色", async ({ page, controlPlane }) => {
	await open(page, controlPlane.database.url, firstTurn(), "idle");
	const commit = page.getByTestId("commit-row").nth(1);
	await commit.getByRole("button").click();
	const diff = commit.getByTestId("commit-diff");
	await expect(diff.locator('[data-diff="add"]')).toHaveCount(2);
	await expect(diff.locator('[data-diff="del"]')).toHaveCount(2);
	await expect(diff.locator('[data-diff="meta"]').first()).toContainText("diff --git");
});

// ---------------------------------------------------------------- 翻页边界上只有结果、没有调用的那一行

test("翻页边界上只有结果、没有调用的行：写明是哪一次调用的结果和调用在哪里；加载更早的内容后和调用合上", async ({
	page,
	controlPlane,
}) => {
	// 230 条：第 30 条是命令的调用，第 31 条是它的结果；最近一页（200 条）从第 31 条开始，所以这一页的第一条是结果、调用在更早的一页里。
	const notice = (i: number): SessionEventBody => ({
		type: "notice",
		kind: "compaction",
		message: `提示 ${i}`,
	});
	const events: SessionEventBody[] = [
		...Array.from({ length: 29 }, (_, i) => notice(i + 1)),
		{ type: "tool_call", call_id: "edge", tool: "command", title: "uv run pytest -q" },
		{
			type: "tool_result",
			call_id: "edge",
			is_error: false,
			text: "2 passed\n",
			truncated: false,
			exit_code: 0,
			duration_ms: 44,
		},
		...Array.from({ length: 199 }, (_, i) => notice(i + 30)),
	];
	await open(page, controlPlane.database.url, events);
	const row = page.locator('[data-testid="tool-row"][data-call="edge"]');
	await expect(row).toContainText("命令的结果 · 更早的调用，加载更早的内容后显示");
	await expect(row).toContainText("退出码 0 · 用时 44ms");
	await expect(row).not.toContainText("工具 ·");
	await page.getByRole("button", { name: "加载更早的", exact: true }).click();
	await expect(row).toContainText("$ uv run pytest -q");
	await expect(row).not.toContainText("更早的调用");
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("退出码 0 · 用时 44ms");
});

// ---------------------------------------------------------------- 并行的两次调用

test("模型一次发出两个调用：两行都标「并行」，后开始的先出结果时前一行仍在做，结果各落在自己那一行", async ({
	page,
}) => {
	const view = sessionView({ status: "running" });
	await installSessionStream(page);
	await stubSessionDetail(page, view, [userMessage(1, "跑两件事"), turnStarted(2)]);
	await page.goto(`/sessions/${view.id}`);
	await expect
		.poll(
			async () =>
				await page.evaluate(
					() =>
						(window as unknown as { __sessionStream: { opened: number } }).__sessionStream.opened,
				),
		)
		.toBe(1);
	await pushEvent(page, toolCall(3, "a", "command", "sleep 5; echo a"));
	await expect(toolRows(page).first()).not.toHaveAttribute("data-parallel");
	await pushEvent(page, toolCall(4, "b", "command", "echo b"));
	const [a, b] = [toolRows(page).nth(0), toolRows(page).nth(1)];
	await expect(a).toHaveAttribute("data-parallel", "true");
	await expect(b).toHaveAttribute("data-parallel", "true");
	await expect(a.getByTestId("tool-parallel")).toHaveText("并行");
	await expect(b.getByTestId("tool-parallel")).toHaveText("并行");
	// 后开始的先出结果：它那一行是完成，前一行还在做，两个都仍标并行。
	await pushEvent(page, toolResult(5, "b", { exit_code: 0, text: "b\n" }));
	await expect(b).toHaveAttribute("data-state", "done");
	await expect(a).toHaveAttribute("data-state", "running");
	await expect(a.getByTestId("tool-parallel")).toBeVisible();
	await pushEvent(page, toolResult(6, "a", { exit_code: 0, text: "a\n" }));
	await expect(a).toHaveAttribute("data-state", "done");
	// 之后单独发出的调用不是并行。
	await pushEvent(page, toolCall(7, "c", "command", "echo c"));
	await expect(toolRows(page).nth(2)).not.toHaveAttribute("data-parallel");
});

// ---------------------------------------------------------------- 等模型的第一次回复

test("等模型第一次回复：页面刚打开时错过了「思考」（它只发一次、不存），也写「等模型回复」；听到思考变「思考中」；有文字或工具出来都去掉", async ({
	page,
}) => {
	const view = sessionView({ status: "running" });
	await installSessionStream(page);
	await stubSessionDetail(page, view, [userMessage(1), turnStarted(2)]);
	await page.goto(`/sessions/${view.id}`);
	// 历史里只有这一轮的开始：没有任何事件说「在思考」，页面照样写在等（上游的 `thinking` 是有的，在页面打开之前就发过了）。
	await expect(page.getByTestId("waiting-model")).toContainText("等模型回复");
	await expect(page.getByTestId("thinking")).toHaveCount(0);
	await expect
		.poll(
			async () =>
				await page.evaluate(
					() =>
						(window as unknown as { __sessionStream: { opened: number } }).__sessionStream.opened,
				),
		)
		.toBe(1);
	await pushEvent(page, { type: "thinking" });
	await expect(page.getByTestId("thinking")).toHaveText("思考中");
	await expect(page.getByTestId("waiting-model")).toHaveCount(0);
	await pushEvent(page, { type: "assistant_delta", text: "我先看" });
	await expect(page.getByTestId("thinking")).toHaveCount(0);
	await expect(page.getByTestId("waiting-model")).toHaveCount(0);
	// 整条消息到了、工具开始之前，又在等模型的下一次回复。
	await pushEvent(page, {
		type: "assistant_message",
		seq: 3,
		at: eventAt(),
		text: "我先看一下。",
		usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
	});
	await expect(page.getByTestId("waiting-model")).toBeVisible();
	await pushEvent(page, toolCall(4, "c1", "command", "ls"));
	await expect(page.getByTestId("waiting-model")).toHaveCount(0);
	await pushEvent(page, toolResult(5, "c1", { exit_code: 0 }));
	await expect(page.getByTestId("waiting-model")).toBeVisible();
});

test("不在做的会话没有「等模型回复」：空闲、排队中、已结束的会话打开时都没有", async ({
	page,
	controlPlane,
}) => {
	await open(page, controlPlane.database.url, firstTurn(), "idle");
	await expect(page.getByTestId("waiting-model")).toHaveCount(0);
	await expect(page.getByTestId("thinking")).toHaveCount(0);
});

// ---------------------------------------------------------------- 滚动：进入时在最新、不抢滚动、「有新内容」、翻页保持位置

const NOTICES = (n: number): SessionEventBody[] =>
	Array.from({ length: n }, (_, i) => ({
		type: "notice",
		kind: "compaction",
		message: `提示 ${i + 1}`,
	}));

test("进入页面滚到最新；人在底部时新内容出来继续跟着；往上翻之后不被拉回，显示「有新内容」，点了回到底部", async ({
	page,
	controlPlane,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "running",
		events: [
			{
				type: "user_message",
				message_id: MESSAGE_IDS.first,
				text: "开始",
				steer: false,
				author: "alice",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
			...NOTICES(60),
		],
		at: new Date("2026-01-01T00:00:00Z"),
	});
	await installSessionStream(page);
	await page.goto(`/sessions/${id}`);
	await expect(page.getByTestId("notice")).toHaveCount(60);
	// 进入页面：在最新。
	await expect.poll(() => fromBottom(page)).toBeLessThan(2);
	await expect
		.poll(
			async () =>
				await page.evaluate(
					() =>
						(window as unknown as { __sessionStream: { opened: number } }).__sessionStream.opened,
				),
		)
		.toBe(1);
	// 在底部：新内容来了继续跟着。
	await pushEvent(page, { type: "assistant_delta", text: "第一段。" });
	await expect(page.getByTestId("assistant-message")).toHaveText("第一段。");
	await expect.poll(() => fromBottom(page)).toBeLessThan(2);
	await expect(page.getByTestId("timeline-new-content")).toHaveCount(0);
	// 往上翻：回到顶部。
	await scroller(page).evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBe(0);
	await pushEvent(page, { type: "assistant_delta", text: "第二段，人在往上看。" });
	await expect(page.getByTestId("assistant-message")).toHaveText("第一段。第二段，人在往上看。");
	// 不抢滚动：位置不动，出现「有新内容」。
	await expect(page.getByTestId("timeline-new-content")).toBeVisible();
	expect(await scroller(page).evaluate((el) => el.scrollTop)).toBe(0);
	await page.getByTestId("timeline-new-content").click();
	await expect.poll(() => fromBottom(page)).toBeLessThan(2);
	await expect(page.getByTestId("timeline-new-content")).toHaveCount(0);
	// 自己滚回底部时「有新内容」也消失（往上翻一点、来新内容、再滚回去）。
	await scroller(page).evaluate((el) => {
		el.scrollTop = 0;
	});
	await pushEvent(page, { type: "assistant_delta", text: "第三段。" });
	await expect(page.getByTestId("timeline-new-content")).toBeVisible();
	await scroller(page).evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(page.getByTestId("timeline-new-content")).toHaveCount(0);
});

test("往前翻页保持位置：点「加载更早的」之后，刚才看着的那一行在屏幕上的位置不动", async ({
	page,
	controlPlane,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await open(page, controlPlane.database.url, NOTICES(260));
	const notices = page.getByTestId("notice");
	await expect(notices).toHaveCount(200);
	// 滚到最上面：「加载更早的」在那里；最靠上的那条是「提示 61」。
	await scroller(page).evaluate((el) => {
		el.scrollTop = 0;
	});
	// 刚才看着的那一行：翻页之后最前面换成了更早的，所以按文字认它，不按「第一个」。
	const anchor = notices.filter({ hasText: /^提示 61$/ });
	await expect(notices.first()).toHaveText("提示 61");
	const top = async () => (await anchor.boundingBox())?.y ?? Number.NaN;
	const before = await top();
	await page.getByRole("button", { name: "加载更早的", exact: true }).click();
	await expect(notices).toHaveCount(260);
	// 位置不跳：同一条提示还在屏幕上的原来的位置（差一两个像素的取整不算）。
	await expect.poll(async () => Math.abs((await top()) - before)).toBeLessThan(2);
	// 滚动区域已经不在最顶：更早的一页在上面，往上滚得到。
	expect(await scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
	await expect(page.getByRole("button", { name: "加载更早的", exact: true })).toHaveCount(0);
	await expect(notices.first()).toHaveText("提示 1");
});

test("页头不会滚到顶栏下面：一轮里插话很多时（1280×800），页头、输入框都留在屏幕里，滚动的只有时间线", async ({
	page,
	controlPlane,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const steers: SessionEventBody[] = Array.from({ length: 40 }, (_, i) => ({
		type: "user_message",
		message_id: `a0000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
		text: `插话 ${i + 1}：再加一条日志`,
		steer: true,
		author: "bob",
		author_user_id: null,
	}));
	await open(
		page,
		controlPlane.database.url,
		[
			{
				type: "user_message",
				message_id: MESSAGE_IDS.first,
				text: "开始",
				steer: false,
				author: "alice",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
			...steers,
		],
		"running",
	);
	await expect(page.getByTestId("user-message")).toHaveCount(41);
	await expect.poll(() => fromBottom(page)).toBeLessThan(2);
	const header = page.getByRole("heading", { level: 1 });
	const topbar = await page.locator("header").first().boundingBox();
	const box = await header.boundingBox();
	// 页头在顶栏下面、屏幕里；输入框在屏幕里。
	expect(box?.y ?? -1).toBeGreaterThanOrEqual((topbar?.y ?? 0) + (topbar?.height ?? 0) - 1);
	const field = await page.getByRole("textbox", { name: "接着说" }).boundingBox();
	expect((field?.y ?? 0) + (field?.height ?? 0)).toBeLessThanOrEqual(800);
	// 整页（`#main`）不滚：滚动的只有时间线。
	const main = await page
		.locator("#main")
		.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, top: el.scrollTop }));
	expect(main.scroll).toBeLessThanOrEqual(main.client + 1);
	expect(main.top).toBe(0);
	await scroller(page).evaluate((el) => {
		el.scrollTop = 0;
	});
	const after = await header.boundingBox();
	expect(after?.y).toBe(box?.y);
});

// ---------------------------------------------------------------- 助手的话是 Markdown，但是别人写的文字

test("助手的话里的 HTML、图片、危险链接不起作用：脚本和 HTML 当文字显示，图片不请求，javascript: 链接只显示文字；方向和转义字符写成占位", async ({
	page,
	controlPlane,
}) => {
	const text = [
		"<script>window.__pwned = 1</script><b>粗体不是 HTML</b>",
		"",
		"![一张图](http://127.0.0.1:1/leak.png?token=abc)",
		"",
		"[点我](javascript:window.__pwned=2) 和 [官网](https://example.org/a?b=1)",
		"",
		`隐藏的：${"\u202e"}drowssap${ESC}[31m`,
	].join("\n");
	const events: SessionEventBody[] = [
		{
			type: "user_message",
			message_id: MESSAGE_IDS.first,
			text: "说话",
			steer: false,
			author: "alice",
			author_user_id: null,
		},
		{ type: "turn_started", turn: 1 },
		{
			type: "assistant_message",
			text,
			usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
		},
		{ type: "turn_end", turn: 1, outcome: "completed", reason: "", duration_ms: 1000 },
	];
	const requests: string[] = [];
	page.on("request", (request) => requests.push(request.url()));
	await open(page, controlPlane.database.url, events);
	const said = page.getByTestId("assistant-message");
	await expect(said).toContainText("粗体不是 HTML");
	// HTML 当文字：没有 script、没有 <b>，原样写出来。
	await expect(said.locator("script, b, img")).toHaveCount(0);
	await expect(said).toContainText("<script>window.__pwned = 1</script>");
	// 图片不渲染，也不发请求；写成一行文字。
	await expect(said).toContainText("[图片：一张图]");
	expect(requests.filter((url) => url.includes("127.0.0.1:1"))).toEqual([]);
	// javascript: 链接只显示文字，不可点；http(s) 的链接新窗口打开、不带来源页。
	await expect(said.getByRole("link")).toHaveCount(1);
	await expect(said.getByRole("link", { name: /官网/ })).toHaveAttribute("rel", /noreferrer/);
	expect(
		await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
	).toBeUndefined();
	// 方向控制字符和转义字符写成可见的占位，文字里没有原样留下。
	await expect(said.locator("[data-slot=hidden-character]").first()).toBeVisible();
	const raw = (await said.textContent()) ?? "";
	expect(raw).not.toContain("\u202e");
	expect(raw).not.toContain(ESC);
});

// ---------------------------------------------------------------- 命令跑着时展开：输出实时出现，停在底部，往上翻不被拉回（假助手服务推）

live(
	"命令运行中展开工具行：输出边跑边出现、停在底部；往上翻之后新输出不把人拉回底部，给「回到最新输出」；结果到了改显示结果",
	async ({ page, assistant, workbench }) => {
		void workbench;
		await page.setViewportSize({ width: 1280, height: 900 });
		const id = await startSession(page, "跑一遍巡检");
		await streamReady(page, assistant, id);
		assistant.emit(
			id,
			1,
			{
				type: "tool_call",
				call_id: "run1",
				tool: "command",
				title: "sfly run start 接口巡检 --wait --timeout 90s",
			},
			eventAt(),
		);
		const row = toolRows(page).first();
		await expect(row).toHaveAttribute("data-state", "running");
		await row.getByRole("button").click();
		// 还没有输出：写一句，不是一块空白。
		await expect(row.getByTestId("tool-live-empty")).toHaveText("还没有输出");
		const output = row.getByTestId("tool-output");
		const line = (n: number) => `第 ${n} 行输出 ${"·".repeat(10)}\n`;
		assistant.emit(
			id,
			1,
			{ type: "tool_output", call_id: "run1", text: line(1) + line(2) },
			eventAt(),
		);
		await expect(output).toContainText("第 2 行输出");
		// 边跑边出：再来 60 行，页面停在最新的一行（在底部）。
		for (let n = 3; n <= 62; n += 1) {
			assistant.emit(id, 1, { type: "tool_output", call_id: "run1", text: line(n) }, eventAt());
		}
		await expect(output).toContainText("第 62 行输出");
		const atEnd = () => output.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
		await expect.poll(atEnd).toBeLessThan(2);
		expect(await output.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
		await expect(row.getByTestId("tool-live-follow")).toHaveCount(0);
		// 往上翻：再来新输出，位置不被拉回，出现「回到最新输出」。
		await output.evaluate((el) => {
			el.scrollTop = 0;
		});
		assistant.emit(id, 1, { type: "tool_output", call_id: "run1", text: line(63) }, eventAt());
		await expect(output).toContainText("第 63 行输出");
		await expect(row.getByTestId("tool-live-follow")).toBeVisible();
		expect(await output.evaluate((el) => el.scrollTop)).toBe(0);
		await row.getByTestId("tool-live-follow").click();
		await expect.poll(atEnd).toBeLessThan(2);
		await expect(row.getByTestId("tool-live-follow")).toHaveCount(0);
		// 结果到了：改显示结果（退出码和用时在行上），实时的那一块没有了。
		assistant.emit(
			id,
			1,
			{
				type: "tool_result",
				call_id: "run1",
				is_error: false,
				text: "运行成功\n",
				truncated: false,
				exit_code: 0,
				duration_ms: 8_400,
			},
			eventAt(),
		);
		await expect(row).toHaveAttribute("data-state", "done");
		await expect(row).toContainText("退出码 0 · 用时 8.4s");
		await expect(row.getByTestId("tool-output")).toHaveCount(0);
		await expect(row.getByTestId("tool-result")).toHaveText("运行成功");
	},
);

live(
	"新建会话后等模型第一次回复：页面一直写着在等；听到「思考」是「思考中」；刷新之后（「思考」只发一次、不存，补不回来）仍写「等模型回复」",
	async ({ page, assistant, workbench }) => {
		void workbench;
		const id = await startSession(page, "跑一遍巡检");
		// 助手服务还没有发任何事件：不是一片空白，写在等模型。
		await expect(page.getByTestId("waiting-model")).toContainText("等模型回复");
		await streamReady(page, assistant, id);
		await expect(page.getByTestId("thinking")).toHaveText("思考中");
		await expect(page.getByTestId("waiting-model")).toHaveCount(0);
		// 刷新：助手服务发过的「思考」没有存，新打开的页面补不回来，历史里只有这一轮的开始。
		await page.reload();
		await expect(page.getByTestId("waiting-model")).toContainText("等模型回复");
		await expect(page.getByTestId("thinking")).toHaveCount(0);
		// 之后听到「思考」或者第一段文字出来，提示都去掉。
		await streamReady(page, assistant, id);
		assistant.emit(id, 1, { type: "assistant_delta", text: "我先看" }, eventAt());
		await expect(page.getByTestId("assistant-message")).toHaveText("我先看");
		await expect(page.getByTestId("thinking")).toHaveCount(0);
		await expect(page.getByTestId("waiting-model")).toHaveCount(0);
	},
);
