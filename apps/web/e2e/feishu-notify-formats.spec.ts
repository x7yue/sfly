// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import { headOf, inspector, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";
import { createFeishuBot, createScenario, triggerRun } from "./support";

// 飞书通知节点的三种格式（#231，ADR 0020）：检查器里在文本、Markdown 卡片、原始消息之间切换，
// 每种格式显示各自的字段；运行时控制面发出对应的请求体。

const AWKWARD = 'He said "hi"\n第二行 \\ 反斜杠';

const entry = {
	id: "entry",
	kind: "entry",
	position: { x: 0, y: 0 },
	params: [
		{ name: "env", type: "string", default: "A 环境" },
		{ name: "who", type: "string", default: AWKWARD },
	],
};

const scenario = (notify: Record<string, unknown>) => ({
	nodes: [
		entry,
		{ id: "notify", kind: "feishu_notify", position: { x: 252, y: 0 }, bot: "ops", ...notify },
	],
	edges: [{ from: "entry", to: "notify", kind: "chain" }],
	packages: {},
});

const formats = (page: Page) => inspector(page).getByRole("group", { name: "格式" });
const field = (page: Page, name: string) =>
	inspector(page).getByRole("combobox", { name, exact: true });

test("检查器里切换三种格式，每种格式显示各自的字段；Markdown 卡片保存后运行，飞书收到卡片 JSON 2.0", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "ops", feishu.webhookUrl("ops-token"));
	const id = await createScenario(controlPlane, "压测通知", scenario({ text: "hi" }));
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "notify").click();
	const panel = inspector(page);

	// 文本格式（默认）：文本和「@所有人」，没有卡片和原始消息的字段。
	await expect(formats(page).getByRole("button", { name: "文本" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(field(page, "文本")).toBeVisible();
	await expect(panel.getByRole("switch", { name: "@所有人" })).toBeVisible();
	await expect(field(page, "标题")).toHaveCount(0);
	await expect(panel.getByRole("combobox", { name: "标题颜色" })).toHaveCount(0);
	await expect(field(page, "原始消息")).toHaveCount(0);

	// Markdown 卡片：标题、标题颜色和正文；文本和「@所有人」收起。
	await formats(page).getByRole("button", { name: "Markdown 卡片" }).click();
	await expect(formats(page).getByRole("button", { name: "Markdown 卡片" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(field(page, "文本")).toHaveCount(0);
	await expect(panel.getByRole("switch", { name: "@所有人" })).toHaveCount(0);
	await expect(field(page, "原始消息")).toHaveCount(0);
	const color = panel.getByRole("combobox", { name: "标题颜色" });
	await expect(color).toHaveValue("blue");
	await expect(color.getByRole("option")).toHaveText(["蓝色", "绿色", "橙色", "红色", "灰色"]);
	await field(page, "标题").fill("【${{ params.env }}】压测开始");
	await color.selectOption("green");
	await field(page, "正文").fill("**目标 QPS** 100\n\n来自 ${{ params.who }}");

	// 原始消息：一个 JSON 编辑器；卡片的字段收起。
	await formats(page).getByRole("button", { name: "原始消息" }).click();
	await expect(field(page, "原始消息")).toBeVisible();
	await expect(field(page, "标题")).toHaveCount(0);
	await expect(field(page, "正文")).toHaveCount(0);
	await expect(panel.getByRole("combobox", { name: "标题颜色" })).toHaveCount(0);

	// 切回去：卡片里填过的内容还在。
	await formats(page).getByRole("button", { name: "Markdown 卡片" }).click();
	await expect(field(page, "标题")).toContainText("【${{ params.env }}】压测开始");
	await expect(panel.getByRole("combobox", { name: "标题颜色" })).toHaveValue("green");
	await expect(field(page, "正文")).toContainText("**目标 QPS** 100");

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.document.nodes.find((n) => n.id === "notify")).toMatchObject({
		kind: "feishu_notify",
		format: "card",
		title: "【${{ params.env }}】压测开始",
		color: "green",
		markdown: "**目标 QPS** 100\n\n来自 ${{ params.who }}",
		text: "hi",
	});

	await triggerRun(controlPlane, id);
	await expect.poll(() => feishu.requests.length).toBe(1);
	expect(feishu.requests[0]).toMatchObject({
		path: "/open-apis/bot/v2/hook/ops-token",
		json: {
			msg_type: "interactive",
			card: {
				schema: "2.0",
				header: { title: { tag: "plain_text", content: "【A 环境】压测开始" }, template: "green" },
				body: {
					elements: [{ tag: "markdown", content: `**目标 QPS** 100\n\n来自 ${AWKWARD}` }],
				},
			},
		},
	});
});

test("原始消息：写完整的请求体，字符串字段里的引用逐个替换，值里有引号和换行时请求体仍是有效 JSON；不合法的 JSON 在字段下提示", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "ops", feishu.webhookUrl("ops-token"));
	const id = await createScenario(controlPlane, "压测通知", scenario({ format: "raw" }));
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "notify").click();
	const panel = inspector(page);
	await expect(formats(page).getByRole("button", { name: "原始消息" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// 还不是合法的 JSON：字段下有提示，保存不会生效。
	const message = field(page, "原始消息");
	await message.fill('{"msg_type": "text", "content": {');
	await expect(panel.getByText("不是合法的 JSON")).toBeVisible();

	await message.fill(
		JSON.stringify({
			msg_type: "interactive",
			card: {
				schema: "2.0",
				header: { title: { tag: "plain_text", content: "来自 ${{ params.who }}" } },
				body: { elements: [{ tag: "markdown", content: "环境：${{ params.env }}" }] },
			},
		}),
	);
	await expect(panel.getByText("不是合法的 JSON")).toHaveCount(0);
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.document.nodes.find((n) => n.id === "notify")).toMatchObject({
		format: "raw",
		message: {
			msg_type: "interactive",
			card: { header: { title: { content: "来自 ${{ params.who }}" } } },
		},
	});

	await triggerRun(controlPlane, id);
	await expect.poll(() => feishu.requests.length).toBe(1);
	const request = feishu.requests[0];
	expect(request?.json).toEqual({
		msg_type: "interactive",
		card: {
			schema: "2.0",
			header: { title: { tag: "plain_text", content: `来自 ${AWKWARD}` } },
			body: { elements: [{ tag: "markdown", content: "环境：A 环境" }] },
		},
	});
	expect(() => JSON.parse(request?.body ?? "")).not.toThrow();
});

test("原始消息不合格：不发送，节点日志里写明原因，节点和运行仍然成功", async ({
	page,
	controlPlane,
	feishu,
	clock,
}) => {
	await createFeishuBot(controlPlane, "ops", feishu.webhookUrl("ops-token"));
	const id = await createScenario(
		controlPlane,
		"压测通知",
		scenario({ format: "raw", message: { msg_type: "audio", content: {} } }),
	);
	const runId = await triggerRun(controlPlane, id);

	await openMonitor(page, clock, runId, "notify");
	await expect(page.getByRole("banner").getByTestId("run-status")).toHaveText("成功");
	const logs = page.getByRole("region", { name: "底部面板" }).getByRole("log", { name: "日志" });
	await expect(logs).toContainText("消息没有发送");
	await expect(logs).toContainText("msg_type");
	expect(feishu.requests).toHaveLength(0);
});
