// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { editorDocument, inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage } from "./support";

// 画布上的提示（#191）：警告徽标悬停或键盘聚焦时显示警告内容；字段错误写参数名和位置；端口的命中范围比圆点大。

/** ping 的输入里有两处无效引用：卡片上「2 警告」。 */
async function scenarioWithWarnings(cp: Parameters<typeof publishPackage>[0]) {
	await publishPackage(cp);
	return createScenario(cp, "带警告的场景", {
		...editorDocument,
		nodes: editorDocument.nodes.map((n) =>
			n.id === "ping"
				? { ...n, inputs: { host: "${{ nodes.nope.outputs.x }}:${{ params.missing }}" } }
				: n,
		),
	});
}

const PING_WARNINGS = [
	"节点 ping 的输入 host 引用了不存在的节点 nope",
	"节点 ping 的输入 host 引用的参数 missing 不是本链入口声明的参数",
];

test("警告徽标：鼠标悬停时列出这个节点的全部警告，移开后消失", async ({ page, controlPlane }) => {
	const id = await scenarioWithWarnings(controlPlane);
	await openEditor(page, id);
	const badge = nodeCard(page, "ping").getByText("2 警告");
	await expect(badge).toBeVisible();

	await badge.hover();
	const tip = page.getByRole("tooltip");
	await expect(tip).toBeVisible();
	await expect(tip.getByRole("listitem")).toHaveText(PING_WARNINGS);

	await page.mouse.move(5, 300);
	await expect(tip).toHaveCount(0);
});

test("警告徽标：用方向键把焦点移到节点上时显示警告，焦点离开后消失", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWithWarnings(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "dispatch").click();
	await expect(nodeCard(page, "dispatch")).toBeFocused();
	// 鼠标点选节点时不弹出（dispatch 没有警告，这里只确认没有提示）。
	await expect(page.getByRole("tooltip")).toHaveCount(0);

	await page.keyboard.press("ArrowRight");
	await expect(nodeCard(page, "ping")).toBeFocused();
	await expect(nodeCard(page, "ping")).toHaveAccessibleName("节点 ping 2 警告");
	const tip = page.getByRole("tooltip");
	await expect(tip.getByRole("listitem")).toHaveText(PING_WARNINGS);

	await page.keyboard.press("ArrowLeft");
	await expect(nodeCard(page, "dispatch")).toBeFocused();
	await expect(tip).toHaveCount(0);
});

test("字段错误写参数名和位置，不写内部路径", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "参数名", editorDocument);
	await openEditor(page, id);

	await nodeCard(page, "entry").click();
	const panel = inspector(page);
	await panel.getByRole("textbox", { name: "参数名称" }).nth(1).fill("1st");
	await expect(page.getByText("1 处字段错误")).toBeVisible();

	// 场景设置的「检查」列出字段错误：节点 ID、参数名加第几个、哪一项。
	await page.mouse.click(200, 640);
	await expect(panel.getByRole("heading", { name: "场景设置" })).toBeVisible();
	await expect(panel.getByRole("listitem").filter({ hasText: "1st" })).toContainText(
		"entry 参数 1st（第 2 个）的名称：参数名只能包含字母、数字和下划线，不能以数字开头",
	);
	await expect(panel.getByText("params.1.name")).toHaveCount(0);
});

test("端口的命中范围比圆点大：从圆点外几像素按下也能拖出连线", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "端口", editorDocument);
	await openEditor(page, id);

	const port = nodeCard(page, "ping").locator('.react-flow__handle[data-handleid="chain"].source');
	// 圆点的外观不变：直径仍是 9px。
	expect(await port.evaluate((el) => getComputedStyle(el).width)).toBe("9px");
	// 在圆点右边、圆点之外 4px 处按下（那里是画布空白处，以前会拖动画布）。
	const dot = await box(port);
	const x = dot.x + dot.width + 4;
	const y = dot.y + dot.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 40, y + 60, { steps: 4 });
	await page.mouse.move(x + 80, y + 110, { steps: 4 });
	await page.mouse.up();
	const menu = page.getByRole("dialog", { name: "添加节点" });
	await expect(menu).toBeVisible();
	await expect(menu.getByText("新节点接在 ping 之后")).toBeVisible();
});
