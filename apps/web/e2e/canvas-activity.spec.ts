import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { runningScenario } from "./monitor-scenario";

// 编排画布的运行状态（#356）：执行中的节点卡片在标题下写此刻在做什么，最外层、开始得最早的动作和已持续多久；
// 节点没有动作时写进度的说明。卡片的可访问名称里带「正在做 X」。

const HOUR_43 = (60 + 43) * 60_000;

test("执行中的节点卡片写出正在做的动作和已持续多久，没有动作时写进度的说明，随推送更新", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId, agent, tasks } = await runningScenario(
		controlPlane,
		connectAgent,
		clock,
	);
	const verify = tasks.verify as AssignedTask;
	const now = clock.now().getTime();
	agent.actionSummary(verify, {
		total: 2,
		reported: 2,
		running: [
			{
				id: 1,
				parent: null,
				depth: 0,
				name: "保持 4 小时",
				fields: {},
				...agent.stamp(now - HOUR_43),
			},
			{ id: 2, parent: 1, depth: 1, name: "下单", fields: {}, ...agent.stamp(now - 5) },
		],
	});
	agent.progress(tasks.probe as AssignedTask, 3, 10, "第 3 批");
	await agent.sync();

	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	const verifyCard = nodeCard(page, "verify");
	await expect(verifyCard).toHaveAttribute("data-run", "running");
	const verifyActivity = verifyCard.getByTestId("node-activity");
	await expect(verifyActivity).toContainText("保持 4 小时");
	await expect(verifyActivity).toContainText("1h 43m");
	// verify 是第 2 次尝试：10 分钟以内开始的重试算异常，场景没设关注项时主指标的异常也写进名称。
	const retry = /1 项需要注意：主指标 level 重试（尝试 2）· \d\d:\d\d:\d\d/;
	await expect(verifyCard).toHaveAccessibleName(
		new RegExp(`^节点 verify，.+ 执行中 正在做 保持 4 小时 ${retry.source}$`),
	);
	// 进度的说明：没有时长。
	const probeCard = nodeCard(page, "probe");
	await expect(probeCard.getByTestId("node-activity")).toContainText("第 3 批");
	await expect(probeCard.getByTestId("node-activity")).not.toContainText(/\d(ms|s|m)\b/);
	await expect(probeCard).toHaveAccessibleName(/ 执行中 正在做 第 3 批$/);
	// 有主指标的卡片多了一行就长高，仍在子流程区域里面。
	await expect(probeCard.locator("[data-primary-metric]")).toBeVisible();
	const card = await probeCard.boundingBox();
	const region = await page.getByRole("region", { name: "子流程 sub" }).boundingBox();
	expect(card && region && card.y + card.height < region.y + region.height).toBe(true);
	// 已经结束的节点没有这一行。
	await expect(nodeCard(page, "fetch").getByTestId("node-activity")).toHaveCount(0);
	await expect(nodeCard(page, "fetch")).toHaveAccessibleName("节点 fetch，HTTP 检查 成功");

	// 换了一个最外层的动作：推送过来，卡片跟着变。
	agent.actionSummary(verify, {
		total: 3,
		reported: 3,
		running: [{ id: 3, parent: null, depth: 0, name: "收尾", fields: {}, ...agent.stamp(now) }],
	});
	await expect(verifyCard.getByTestId("node-activity")).toContainText("收尾");
	await expect(verifyCard).toHaveAccessibleName(new RegExp(` 执行中 正在做 收尾 ${retry.source}$`));

	// 动作都结束了、也没有进度：这一行撤掉。
	agent.actionSummary(verify, { total: 3, reported: 3 });
	await expect(verifyCard.getByTestId("node-activity")).toHaveCount(0);
	await expect(verifyCard).toHaveAccessibleName(
		new RegExp(`^节点 verify，.+ 执行中 ${retry.source}$`),
	);
});
