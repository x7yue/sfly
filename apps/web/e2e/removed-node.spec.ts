import { IDS, seedRemovedKindScenario } from "../../server/test/support/removed-kind-scenario.js";
import { inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";

// 已移除的节点种类（飞书通知节点、定时节点、Sleep 节点，ADR 0028）留在历史数据里：
// 最新版本里还有它们的场景，画布打开时提示、检查器写明替换办法，删掉之后才能保存；历史运行和历史版本里它们照常显示。
// 数据直接写库造出（保存接口已经不收带它们的文档）：入口 → 等待（sleep）→ 定时（timer）→ 通知（feishu_notify）。

const NOTIFY_REPLACEMENT = "在节点代码里用 ctx.notify 发飞书消息";
const SLEEP_REPLACEMENT = "在节点代码里等待，或把场景拆成两次运行";
const TIMER_REPLACEMENT = "在节点代码里等到那个时刻，或把场景拆成两次运行";

test("最新版本里还有已移除的节点：画布提示哪些节点、怎么替换；保存被拦下，删掉之后才能保存", async ({
	page,
	controlPlane,
}) => {
	await seedRemovedKindScenario(controlPlane);
	await openEditor(page, IDS.scenario, "notify");

	// 画布顶部的提示：哪些节点、每种怎么替换。
	const banner = page.getByRole("status").filter({ hasText: "不能运行，删掉之后才能保存" });
	await expect(banner).toContainText("有 3 个节点的类型已不再支持（wait、at、notify）");
	await expect(banner).toContainText(`Sleep 节点改成${SLEEP_REPLACEMENT}`);
	await expect(banner).toContainText(`定时节点改成${TIMER_REPLACEMENT}`);
	await expect(banner).toContainText(`飞书通知节点改成${NOTIFY_REPLACEMENT}`);
	// 定时、Sleep 节点原来有输出：引用过它们的节点，删掉之后也要改。
	await expect(banner).toContainText("引用了它们输出的节点也要一起改");

	// 节点卡片：显示名称是标题（没有时是种类名），种类名是「已移除的节点类型 <种类>」。
	const wait = nodeCard(page, "wait");
	await expect(wait).toContainText("歇一会");
	await expect(wait).toContainText("已移除的节点类型 sleep");
	const at = nodeCard(page, "at");
	await expect(at).toContainText("已移除的节点类型 timer");
	const notify = nodeCard(page, "notify");
	await expect(notify).toContainText("通知群");
	await expect(notify).toContainText("已移除的节点类型 feishu_notify");
	await expect(notify).toContainText("不再支持");

	// 检查器：写明为什么不能再用、怎么替换，只读地列出当时的配置。
	await notify.click();
	const panel = inspector(page);
	await expect(panel).toContainText("已不再支持，不能运行，也不能保存");
	await expect(panel).toContainText(NOTIFY_REPLACEMENT);
	await expect(panel).toContainText("当时的配置");
	await expect(panel).toContainText('"bot": "ops"');
	await expect(panel).toContainText("压测结束 ${{ params.env }}");
	await expect(panel).not.toContainText("引用了它的输出");
	await at.click();
	await expect(panel).toContainText(TIMER_REPLACEMENT);
	await expect(panel).toContainText("别的节点引用了它的输出（triggered_at、late）的，也要一起改");
	await expect(panel).toContainText('"at": "09:30:00"');
	await wait.click();
	await expect(panel).toContainText(SLEEP_REPLACEMENT);
	await expect(panel).toContainText("别的节点引用了它的输出（triggered_at）的，也要一起改");
	await expect(panel).toContainText('"duration": "5s"');

	// 保存被拦下：字段错误，没有新版本。
	await page.keyboard.press("Control+s");
	await expect(panel.getByText("节点类型：已不再支持，不能保存", { exact: false })).toBeVisible();
	const unchanged = await (await controlPlane.fetch(`/orchestrations/${IDS.scenario}/head`)).json();
	expect((unchanged as { number: number }).number).toBe(1);

	// 一个一个删掉（前后的节点自动接上）：提示逐步变少，最后消失，保存成功。
	await panel.getByRole("button", { name: "删除节点" }).click();
	await expect(wait).toHaveCount(0);
	await expect(banner).toContainText("有 2 个节点的类型已不再支持（at、notify）");
	for (const [id, left] of [
		["at", "有 1 个节点的类型已不再支持（notify）"],
		["notify", null],
	] as const) {
		await nodeCard(page, id).click();
		await inspector(page).getByRole("button", { name: "删除节点" }).click();
		await expect(nodeCard(page, id)).toHaveCount(0);
		if (left) await expect(banner).toContainText(left);
		// 只剩没有输出的飞书通知节点时，不再提引用的事。
		if (left) await expect(banner).not.toContainText("引用了它们输出的节点");
	}
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
	expect(head.document.nodes.map((n) => n.id)).toEqual(["entry"]);
	expect(head.document.edges).toEqual([]);
});

test("历史运行里已移除的节点照常显示：时间线上写它们当时的种类名，状态和输入都在", async ({
	page,
	controlPlane,
	clock,
}) => {
	await seedRemovedKindScenario(controlPlane);
	await openMonitor(page, clock, IDS.run, "notify", "io");

	const timeline = page.getByRole("region", { name: "链路时间线" });
	await expect(timeline).toContainText("已移除的节点类型 feishu_notify");
	await expect(timeline).toContainText("已移除的节点类型 sleep");
	await expect(timeline).toContainText("已移除的节点类型 timer");
	await expect(timeline).toContainText("通知群");
	await expect(page.getByText("压测结束 A").first()).toBeVisible();
});

test("版本历史里查看移除之前保存的版本：已移除的节点照常画出来", async ({ page, controlPlane }) => {
	await seedRemovedKindScenario(controlPlane);
	await page.goto(`/orchestrations/${IDS.scenario}/versions?a=1`);
	await expect(nodeCard(page, "notify")).toContainText("已移除的节点类型 feishu_notify");
	await expect(nodeCard(page, "wait")).toContainText("已移除的节点类型 sleep");
	await expect(nodeCard(page, "at")).toContainText("已移除的节点类型 timer");
});
