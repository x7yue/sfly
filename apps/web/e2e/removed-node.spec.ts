import { IDS, seedRemovedKindScenario } from "../../server/test/support/removed-kind-scenario.js";
import { inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";

// 已移除的节点种类（飞书通知节点，ADR 0028）留在历史数据里：
// 最新版本里还有它的场景，画布打开时提示、检查器写明替换办法，删掉之后才能保存；历史运行和历史版本里它照常显示。
// 数据直接写库造出（保存接口已经不收带它的文档）。

const REPLACEMENT = "在节点代码里用 ctx.notify 发飞书消息";

test("最新版本里还有已移除的节点：画布提示哪些节点、怎么替换；保存被拦下，删掉之后才能保存", async ({
	page,
	controlPlane,
}) => {
	await seedRemovedKindScenario(controlPlane);
	await openEditor(page, IDS.scenario, "notify");

	// 画布顶部的提示：哪些节点、怎么替换。
	const banner = page.getByRole("status").filter({ hasText: "不能运行，也不能保存" });
	await expect(banner).toContainText("有 1 个节点的类型已不再支持（notify）");
	await expect(banner).toContainText(REPLACEMENT);

	// 节点卡片：显示名称是标题，种类名是「已移除的节点类型 feishu_notify」。
	const card = nodeCard(page, "notify");
	await expect(card).toContainText("通知群");
	await expect(card).toContainText("已移除的节点类型 feishu_notify");
	await expect(card).toContainText("不再支持");

	// 检查器：写明为什么不能再用、怎么替换，只读地列出当时的配置。
	await card.click();
	const panel = inspector(page);
	await expect(panel).toContainText("已不再支持，不能运行，也不能保存");
	await expect(panel).toContainText(REPLACEMENT);
	await expect(panel).toContainText("当时的配置");
	await expect(panel).toContainText('"bot": "ops"');
	await expect(panel).toContainText("压测结束 ${{ params.env }}");

	// 保存被拦下：字段错误，没有新版本。
	await page.keyboard.press("Control+s");
	await expect(panel.getByText("节点类型：已不再支持，不能保存", { exact: false })).toBeVisible();
	const unchanged = await (await controlPlane.fetch(`/orchestrations/${IDS.scenario}/head`)).json();
	expect((unchanged as { number: number }).number).toBe(1);

	// 删掉它（前后的节点自动接上）：提示消失，保存成功。
	await panel.getByRole("button", { name: "删除节点" }).click();
	await expect(card).toHaveCount(0);
	await expect(banner).toHaveCount(0);
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();

	const head = (await (
		await controlPlane.fetch(`/orchestrations/${IDS.scenario}/head`)
	).json()) as {
		number: number;
		document: { nodes: { id: string }[]; edges: { from: string; to: string }[] };
	};
	expect(head.number).toBe(2);
	expect(head.document.nodes.map((n) => n.id)).toEqual(["entry", "wait"]);
	expect(head.document.edges).toEqual([{ from: "entry", to: "wait", kind: "chain" }]);
});

test("历史运行里已移除的节点照常显示：时间线上写它当时的种类名，状态和输入都在", async ({
	page,
	controlPlane,
	clock,
}) => {
	await seedRemovedKindScenario(controlPlane);
	await openMonitor(page, clock, IDS.run, "notify", "io");

	const timeline = page.getByRole("region", { name: "链路时间线" });
	await expect(timeline).toContainText("已移除的节点类型 feishu_notify");
	await expect(timeline).toContainText("通知群");
	await expect(page.getByText("压测结束 A").first()).toBeVisible();
});

test("版本历史里查看移除之前保存的版本：已移除的节点照常画出来", async ({ page, controlPlane }) => {
	await seedRemovedKindScenario(controlPlane);
	await page.goto(`/orchestrations/${IDS.scenario}/versions?a=1`);
	await expect(nodeCard(page, "notify")).toContainText("已移除的节点类型 feishu_notify");
});
