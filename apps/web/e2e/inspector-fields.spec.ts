import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage } from "./support";

// 检查器里的字段：长参数名、校验的时机、保存被拦下时的焦点、开关旁的文字。

const uploadNodes = [
	{
		name: "upload",
		title: "上传",
		entry: "demo_checks.upload:run",
		inputs: {
			type: "object",
			properties: {
				release_file: { type: "string" },
				request_timeout_ms: { type: "integer" },
				mode: { enum: ["fast", "safe"] },
			},
			required: ["release_file"],
		},
		outputs: { type: "object", properties: {} },
	},
];

const uploadDocument = {
	default_agent: "agent-linux",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			position: { x: 0, y: 0 },
			params: [{ name: "who", type: "string", required: false, secret: false }],
		},
		{
			id: "upload",
			kind: "package",
			package: "demo-checks",
			node: "upload",
			position: { x: 252, y: 0 },
			inputs: { release_file: "a.zip" },
		},
	],
	edges: [{ from: "entry", to: "upload", kind: "chain" }],
	packages: { "demo-checks": "1.2.0" },
};

async function openUpload(page: Page, controlPlane: TestControlPlane) {
	await publishPackage(controlPlane, { nodes: uploadNodes });
	const id = await createScenario(controlPlane, "上传发布", uploadDocument);
	await openEditor(page, id, "upload");
	await nodeCard(page, "upload").click();
	return inspector(page);
}

test("参数名很长也不被截断：必填星号看得见，名称列共用一个宽度，有按钮的字段控件右沿对齐", async ({
	page,
	controlPlane,
}) => {
	const panel = await openUpload(page, controlPlane);
	const required = panel.locator("label", { hasText: "release_file" });
	const long = panel.locator("label", { hasText: "request_timeout_ms" });

	await expect(required).toContainText("release_file*");
	for (const label of [required, long]) {
		await expect(label).toBeVisible();
		expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	}
	// 太长的名称折行，而不是截断成省略号。
	expect((await box(long)).height).toBeGreaterThan((await box(required)).height + 10);

	// 名称列共用一个宽度：控件从同一个位置开始；有按钮的两个字段控件的右沿对齐。
	const frame = panel.locator('[data-slot="reference-editor"]').first();
	const input = panel.getByRole("textbox", { name: "输入 request_timeout_ms" });
	const labels = await Promise.all([box(required), box(long)]);
	expect(labels[0].x).toBeCloseTo(labels[1].x, 0);
	const [a, b] = await Promise.all([box(frame), box(input)]);
	expect(a.x).toBeCloseTo(b.x, 0);
	expect(a.x + a.width).toBeCloseTo(b.x + b.width, 0);
});

test("输入到一半不报错：第一次失焦才显示，错误文字与输入框关联，之后随输入更新", async ({
	page,
	controlPlane,
}) => {
	const panel = await openUpload(page, controlPlane);
	const timeout = panel.getByRole("textbox", { name: "输入 request_timeout_ms" });
	const error = panel.getByText("需要整数");

	await timeout.click();
	await page.keyboard.type("1.5");
	await expect(timeout).toHaveValue("1.5");
	await expect(error).toHaveCount(0);
	await expect(timeout).not.toHaveAttribute("aria-invalid");
	await expect(page.getByText("处字段错误")).toHaveCount(0);

	await timeout.blur();
	await expect(error).toBeVisible();
	await expect(timeout).toHaveAttribute("aria-invalid", "true");
	await expect(timeout).toHaveAccessibleDescription("需要整数");
	await expect(page.getByRole("button", { name: "1 处字段错误" })).toBeVisible();

	// 失焦之后每次输入都立即校验：改对了错误立刻消失，再写错立刻出现。
	await timeout.focus();
	await page.keyboard.press("Backspace");
	await expect(error).toHaveCount(0);
	await expect(timeout).not.toHaveAttribute("aria-invalid");
	await page.keyboard.type("5");
	await expect(error).toBeVisible();
	await expect(timeout).toHaveAccessibleDescription("需要整数");
});

test("Ctrl S 被字段错误拦下：错误亮出来，焦点直接到出错的字段，换了节点、页签也一样", async ({
	page,
	controlPlane,
}) => {
	const panel = await openUpload(page, controlPlane);
	const timeout = panel.getByRole("textbox", { name: "输入 request_timeout_ms" });

	// 还没显示的错误：焦点在输入框里按 Ctrl S，错误显示出来，焦点留在这个输入框。
	await timeout.click();
	await page.keyboard.type("1.5");
	await expect(page.getByText("处字段错误")).toHaveCount(0);
	await page.keyboard.press("Control+s");
	await expect(panel.getByText("需要整数")).toBeVisible();
	await expect(timeout).toBeFocused();
	await expect(page.getByRole("button", { name: "1 处字段错误" })).toBeVisible();

	// 执行页的超时也出错之后，走到别的节点；Ctrl S 回到出错的节点，最先出错的字段拿到焦点。
	await panel.getByRole("tab", { name: "执行" }).click();
	await panel.getByLabel("超时", { exact: true }).fill("0");
	await nodeCard(page, "entry").click();
	await expect(panel.getByRole("heading", { name: "入口" })).toBeVisible();
	await page.keyboard.press("Control+s");
	await expect(nodeCard(page, "upload")).toHaveAttribute("aria-pressed", "true");
	await expect(panel.getByRole("tab", { name: /参数/ })).toHaveAttribute("aria-selected", "true");
	await expect(timeout).toBeFocused();

	// 只剩执行页的错误时，检查器切到「执行」页并聚焦那个字段。
	await timeout.fill("5");
	await nodeCard(page, "entry").click();
	await page.keyboard.press("Control+s");
	await expect(panel.getByRole("tab", { name: "执行" })).toHaveAttribute("aria-selected", "true");
	await expect(panel.getByLabel("超时", { exact: true })).toBeFocused();
	await expect(panel.getByText("需要正整数")).toBeVisible();
});

test("开关旁边的文字也是开关的一部分：点文字就能切换", async ({ page, controlPlane }) => {
	const panel = await openUpload(page, controlPlane);

	await panel.getByRole("tab", { name: "执行" }).click();
	const always = panel.getByRole("switch", { name: "always" });
	await expect(always).not.toBeChecked();
	await panel.getByText("前面失败或运行被取消时仍执行").click();
	await expect(always).toBeChecked();
	await panel.getByText("always", { exact: true }).click();
	await expect(always).not.toBeChecked();

	await nodeCard(page, "entry").click();
	const required = panel.getByRole("switch", { name: "必填" });
	const secret = panel.getByRole("switch", { name: "敏感" });
	await panel.getByText("必填", { exact: true }).click();
	await expect(required).toBeChecked();
	await expect(secret).not.toBeChecked();
	await panel.getByText("敏感", { exact: true }).click();
	await expect(secret).toBeChecked();
});

test("检查器的标题最多两行、不截成一行；工具条里的场景名太长时截断并在悬停时给出全文；小节标题不靠 500 字重", async ({
	page,
	controlPlane,
}) => {
	const nodeTitle = "上传发布包到制品库并校验签名与摘要之后再通知下游系统开始灰度发布的节点";
	const scenarioName =
		"每日凌晨定时执行的跨机房制品同步与校验任务（含灰度发布与回滚演练的完整流程）";
	await publishPackage(controlPlane, { nodes: [{ ...uploadNodes[0], title: nodeTitle }] });
	const id = await createScenario(controlPlane, scenarioName, uploadDocument);
	await openEditor(page, id, "upload");
	await nodeCard(page, "upload").click();

	const panel = inspector(page);
	const title = panel.getByRole("heading", { level: 2 });
	await expect(title).toHaveText(nodeTitle);
	const { height, lineHeight, overflowing } = await title.evaluate((el) => ({
		height: el.getBoundingClientRect().height,
		lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
		overflowing: el.scrollWidth > el.clientWidth,
	}));
	expect(height).toBeGreaterThan(lineHeight * 1.5);
	expect(height).toBeLessThanOrEqual(lineHeight * 2 + 1);
	expect(overflowing).toBe(false);
	await expect(panel.getByRole("heading", { level: 3 }).first()).toHaveCSS("font-weight", "600");

	const name = page.getByRole("heading", { level: 1 }).locator('[data-slot="truncate"]');
	await expect(name).toHaveAttribute("data-truncated", "true");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(scenarioName);
	await name.hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(scenarioName);
});
