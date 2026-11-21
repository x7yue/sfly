import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	FAILED_NAME,
	FAILED_NODE,
	FAILURE_HEADLINE,
	failedRun,
	openFailedOverview,
} from "./monitor-failure-scenario";
import { goOffline, queuedOffline, queuedSlotsFull, queueScenario } from "./monitor-queue-scenario";
import { createScenario, publishPackage, triggerRun } from "./support";

// 排队中的节点写明在等谁、等了多久（#457）：概览的「进行中」、没有节点执行时的说明、详情的尝试卡片；
// 运行还没结束、已有节点失败时，失败区域（概览）和顶栏的摘要（详情）立刻写出失败的节点和原因，二者不在同一屏上重复。

const header = (page: Page) => page.getByRole("banner");
const waitNote = (page: Page) => page.getByTestId("queue-wait");

test("Agent 不在线：概览写明等谁、离线多久、排了多久、多久后超时，主指标一栏不写「没有执行中的节点」，能跳到 Agent 管理页那台 Agent", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await queuedOffline(controlPlane, connectAgent, clock);
	await openFailedOverview(page, clock, runId);

	// 「进行中」：这个节点排队中，写明等的 Agent、离线多久、排了多久、多久后排队超时。
	const note = waitNote(page);
	await expect(note).toHaveCount(2); // 「进行中」一行和主指标一栏各写一遍
	await expect(note.first()).toHaveAttribute("data-state", "offline");
	await expect(note.first()).toHaveText(
		"等 agent-a（不在线，已离线 2m 05s）· 排队 5s · 4m 55s 后超时",
	);
	// 主指标一栏：写它们在等什么，不写「没有执行中的节点」。
	const waiting = page.getByTestId("waiting-nodes");
	await expect(waiting).toContainText("节点都在排队，还没有开始执行：");
	await expect(waiting).toContainText("准备环境（a）");
	await expect(page.getByText("没有执行中的节点。")).toHaveCount(0);

	// 详情：选中这个节点，「尝试」页签的卡片写同样的话。
	await page.goto(`/runs/${runId}?view=detail&node=a&tab=attempts`);
	const card = page.getByRole("article", { name: "准备环境（a） 第 1 次尝试" });
	await expect(card.getByTestId("queue-wait")).toHaveText(
		"等 agent-a（不在线，已离线 2m 05s）· 排队 5s · 4m 55s 后超时",
	);

	// 点 Agent 名称：去 Agent 管理页，落在那台 Agent 上。
	await page.goto(`/runs/${runId}?view=overview`);
	await waitNote(page).first().getByRole("link", { name: "agent-a" }).click();
	await expect(page).toHaveURL(/\/agents#agent-agent-a$/);
	await expect(page.getByRole("region", { name: "agent-a" })).toBeInViewport({ ratio: 1 });
});

test("Agent 上线但还在准备环境：不等运行视图推送，页面定时重新读取，写法跟着变", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await publishPackage(controlPlane);
	const gone = await connectAgent({
		name: "agent-a",
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await goOffline(controlPlane, gone, "agent-a");
	const scenarioId = await createScenario(controlPlane, "准备环境场景", queueScenario("agent-a"));
	const runId = await triggerRun(controlPlane, scenarioId);
	await openFailedOverview(page, clock, runId);
	await expect(waitNote(page).first()).toHaveAttribute("data-state", "offline");

	// 重新连上、停在准备环境：节点仍在排队，运行本身没有变化，没有事件推送。
	await connectAgent(
		{ name: "agent-a", installedPackages: [{ name: "demo-checks", version: "1.2.0" }] },
		{ preparing: true },
	);
	await expect(waitNote(page).first()).toHaveAttribute("data-state", "preparing", {
		timeout: 20_000,
	});
	await expect(waitNote(page).first()).toContainText("等 agent-a（准备环境中");
});

test("Agent 在线、槽位占满：写明占着槽位的任务", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId: waitingRun } = await queuedSlotsFull(controlPlane, connectAgent, clock);
	await openFailedOverview(page, clock, waitingRun);

	const note = waitNote(page).first();
	await expect(note).toHaveAttribute("data-state", "slots_full");
	await expect(note).toContainText("等 agent-a（槽位占满，1 / 1）· 排队 10s · 4m 50s 后超时");
	await expect(note.getByTestId("queue-wait-holders")).toHaveText(
		"；占着槽位的任务：准备环境场景 的 准备环境（a）",
	);
});

test("运行还没结束、已有节点失败：概览里是失败区域，顶栏不重复；看不到失败区域的详情里顶栏就显示失败的节点和原因", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await failedRun(controlPlane, connectAgent, clock, { cleanupDone: false });
	await openFailedOverview(page, clock, runId);

	// 概览：失败区域写着失败，顶栏不再写一遍摘要（同一屏上同一件事只说一次）。
	await expect(header(page).getByTestId("run-status")).toHaveText("运行中");
	await expect(page.getByTestId("failure-area")).toBeVisible();
	await expect(header(page).getByTestId("run-failure")).toHaveCount(0);

	// 详情：运行还没结束，没有失败横幅，顶栏的摘要在（运行中已有节点失败就显示，不等运行结束）；点它打开失败节点的「尝试」页签。
	await page.goto(`/runs/${runId}?view=detail`);
	await expect(page.getByRole("region", { name: "运行失败" })).toHaveCount(0);
	await expect(header(page).getByTestId("run-failure")).toHaveText(
		`失败于 ${FAILED_NAME}（${FAILED_NODE}）（第 1 次尝试）· ${FAILURE_HEADLINE}`,
	);
	await header(page).getByTestId("run-failure").click();
	await expect(
		page.getByRole("region", { name: "底部面板" }).getByRole("tab", { name: "尝试" }),
	).toHaveAttribute("aria-selected", "true");
});
