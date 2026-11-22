import { editorDocument, inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage } from "./support";

// 节点上写了节点类型没有声明的输入（#444）：和「缺必填输入」「常量类型不符」一样是静态检查的警告（`input_not_declared`），
// 保存时提示、触发前阻断；检查器的「检查」里列出它，写明节点类型声明了哪些输入，差一两个字符时问是不是想写另一个；
// 「参数」页里那个输入有「移除」，移掉之后警告消失。画布上不再有另一份「提醒」重复列一遍。

const WARNING =
	"节点 fetch 的输入 exepct 没有声明：节点类型 http_check 声明的输入有 url、expect；是不是想写 expect？";

const misspelled = {
	...editorDocument,
	nodes: editorDocument.nodes.map((n) =>
		n.id === "fetch" ? { ...n, inputs: { ...n.inputs, exepct: 200 } } : n,
	),
};

test("写错的输入名：检查里只有一条警告（含「是不是想写」），参数页里移除它之后检查通过", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "写错输入名", misspelled);
	await openEditor(page, id);

	// 节点卡片和顶栏都算一条警告；没有另外的「提醒」。
	await expect(nodeCard(page, "fetch")).toContainText("1 警告");
	await page.getByRole("button", { name: "1 条警告" }).click();
	const panel = inspector(page);
	const found = panel.getByRole("listitem").filter({ hasText: "输入 exepct" });
	await expect(found).toHaveCount(1);
	await expect(found).toContainText(WARNING);
	await expect(panel.getByText(/条提醒/)).toHaveCount(0);
	await expect(panel.getByText("提醒不影响运行")).toHaveCount(0);

	// 「前往」选中节点，参数页里写错的那个输入有「移除」。
	await found.getByRole("button", { name: "前往" }).click();
	await expect(nodeCard(page, "fetch")).toHaveAttribute("aria-pressed", "true");
	await panel.getByRole("tab", { name: "参数" }).click();
	await expect(panel.getByText("输入 exepct 没有在节点类型中声明")).toBeVisible();
	await panel.getByRole("button", { name: "移除" }).click();

	await expect(panel.getByText("输入 exepct 没有在节点类型中声明")).toHaveCount(0);
	await expect(nodeCard(page, "fetch")).not.toContainText("警告");
	await expect(page.getByRole("button", { name: "检查通过" })).toBeVisible();
});
