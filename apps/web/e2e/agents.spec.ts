import { AgentUpdateState } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import {
	createScenario,
	failApi,
	holdApi,
	publishPackage,
	scenarioUsing,
	triggerRun,
} from "./support";

// Agent 管理页（原型 #/agents）。

// 控制面版本固定为 1.2.3：与它一致的 Agent 才会被派任务（ADR 0014）。
test.use({ controlPlaneOptions: { version: "1.2.3" } });

test("列出 Agent：在线状态、槽位占用、版本、系统、已安装节点包、被引用场景数、最后在线", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const busy = await connectAgent({
		name: "agent-busy",
		agentVersion: "1.2.3",
		os: "linux",
		arch: "x86_64",
		slots: 2,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const gone = await connectAgent({
		name: "agent-gone",
		agentVersion: "1.0.0",
		os: "macos",
		arch: "aarch64",
	});
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent-busy"));
	await createScenario(controlPlane, "巡检副本", scenarioUsing("agent-busy"));
	clock.advance(90_000);
	await gone.disconnect();
	await triggerRun(controlPlane, scenario);
	await busy.nextAssign();

	await page.goto("/agents");
	const busyRow = page.getByRole("row", { name: /agent-busy/ });
	await expect(busyRow.getByRole("cell")).toHaveText([
		"agent-busy",
		"在线",
		"1/2",
		"1.2.3",
		"linux/x86_64",
		"demo-checks@1.2.0",
		"2 个场景",
		"—",
		"",
	]);
	// 离线时间按浏览器时区（测试固定为 Asia/Shanghai）显示。
	await expect(page.getByRole("row", { name: /agent-gone/ }).getByRole("cell")).toHaveText([
		"agent-gone",
		"离线",
		"0/4",
		"1.0.0",
		"macos/aarch64",
		"无",
		"未被引用",
		"01-01 08:01",
		"",
	]);
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
});

test.describe("版本不一致", () => {
	test.use({ controlPlaneOptions: { version: "2.0.0" } });

	test("显示更新状态和 Agent、控制面各自的版本号；版本一致的 Agent 照常显示在线", async ({
		page,
		connectAgent,
	}) => {
		const report = async (
			name: string,
			update: { state: AgentUpdateState; remainingTasks?: number; reason?: string },
		) => {
			const agent = await connectAgent({ name, agentVersion: "1.0.0" });
			agent.send({ case: "heartbeat", value: { runningTasks: [], update } });
			await agent.sync();
		};
		await connectAgent({ name: "agent-current" });
		await connectAgent({ name: "agent-old", agentVersion: "1.0.0" });
		await report("agent-waiting", { state: AgentUpdateState.WAITING_FOR_TASKS, remainingTasks: 2 });
		await report("agent-manual", {
			state: AgentUpdateState.MANUAL_UPGRADE_REQUIRED,
			reason: "已指定 --no-auto-update，不自动更新",
		});
		await report("agent-failed", { state: AgentUpdateState.FAILED, reason: "sha256 不匹配" });
		await report("agent-downloading", { state: AgentUpdateState.DOWNLOADING });

		await page.goto("/agents");
		const cells = (name: string) =>
			page.getByRole("row", { name: new RegExp(name) }).getByRole("cell");
		await expect(cells("agent-current").nth(1)).toHaveText("在线");
		await expect(cells("agent-current").nth(3)).toHaveText("2.0.0");
		await expect(cells("agent-old").nth(1)).toHaveText("版本不一致");
		await expect(cells("agent-old").nth(3)).toHaveText("1.0.0控制面 2.0.0");
		await expect(cells("agent-waiting").nth(1)).toHaveText("更新中等待 2 个任务结束");
		await expect(cells("agent-manual").nth(1)).toHaveText(
			"需要手动升级已指定 --no-auto-update，不自动更新",
		);
		await expect(cells("agent-failed").nth(1)).toHaveText("更新失败sha256 不匹配");
		await expect(cells("agent-failed").nth(3)).toHaveText("1.0.0控制面 2.0.0");
		// 「立即更新」只给确实在更新流程中（下载中、等待任务结束）的 Agent：
		// 更新失败、需要手动升级、没有上报更新状态的旧 Agent 都没有。
		const updateNow = (name: string) =>
			page.getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "立即更新" });
		await expect(updateNow("agent-waiting")).toBeVisible();
		await expect(updateNow("agent-downloading")).toBeVisible();
		await expect(updateNow("agent-old")).toHaveCount(0);
		await expect(updateNow("agent-failed")).toHaveCount(0);
		await expect(updateNow("agent-current")).toHaveCount(0);
		await expect(updateNow("agent-manual")).toHaveCount(0);
	});

	test("立即更新：确认框列出会被终止的任务；取消不产生影响，确认后状态变为替换中", async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		await publishPackage(controlPlane);
		const current = await connectAgent({ name: "agent-a", slots: 2 });
		const first = await triggerRun(
			controlPlane,
			await createScenario(controlPlane, "巡检", scenarioUsing("agent-a")),
		);
		const second = await triggerRun(
			controlPlane,
			await createScenario(controlPlane, "拨测", scenarioUsing("agent-a")),
		);
		const held = [await current.nextAssign(), await current.nextAssign()];
		// 控制面升级后，旧版本的 Agent 带着手上的任务重新连上，等它们结束。
		await current.disconnect();
		const old = await connectAgent({
			name: "agent-a",
			agentVersion: "1.0.0",
			slots: 2,
			runningTasks: held.map((t) => ({ taskId: t.taskId, attempt: t.attempt, started: true })),
		});
		old.send({
			case: "heartbeat",
			value: {
				runningTasks: [],
				update: { state: AgentUpdateState.WAITING_FOR_TASKS, remainingTasks: 2 },
			},
		});
		await old.sync();

		await page.goto("/agents");
		const row = page.getByRole("row", { name: /agent-a/ });
		const status = row.getByRole("cell").nth(1);
		await expect(status).toContainText("等待 2 个任务结束");
		const open = async () => {
			await row.getByRole("button", { name: "立即更新" }).click();
			const dialog = page.getByRole("dialog", { name: "立即更新 agent-a？" });
			await expect(dialog).toBeVisible();
			return dialog;
		};

		// 确认框列出会被终止的任务。
		let dialog = await open();
		const terminated = dialog.getByRole("list", { name: "会被终止的任务" }).getByRole("listitem");
		await expect(terminated).toHaveCount(2);
		await expect(terminated.nth(0)).toContainText("ping");
		await expect(terminated.nth(0)).toContainText(first.slice(0, 8));
		await expect(terminated.nth(1)).toContainText(second.slice(0, 8));
		await expect(dialog).toContainText("agent_lost");
		await expect(dialog).toContainText("2.0.0");

		// 取消：任务照常运行，Agent 没有收到指令。
		await dialog.getByRole("button", { name: "取消" }).click();
		await expect(dialog).toBeHidden();
		await old.sync();
		expect(old.received.some((m) => m.body.case === "updateNow")).toBe(false);
		const runStatus = async (runId: string) => {
			const res = await controlPlane.fetch(`/runs/${runId}`);
			return ((await res.json()) as { status: string }).status;
		};
		expect(await runStatus(first)).toBe("running");
		expect(await runStatus(second)).toBe("running");
		await expect(status).toContainText("等待 2 个任务结束");

		// 确认：Agent 收到指令，任务以 agent_lost 失败；Agent 上报替换中。
		dialog = await open();
		await dialog.getByRole("button", { name: "立即更新" }).click();
		await expect(dialog).toBeHidden();
		await old.next("updateNow");
		// 没有配置重试：节点以 agent_lost 失败，运行失败。
		await expect.poll(() => runStatus(first)).toBe("failed");
		old.send({
			case: "heartbeat",
			value: { runningTasks: [], update: { state: AgentUpdateState.REPLACING } },
		});
		await old.sync();
		// 确认后的刷新可能早于这次心跳，下一次轮询（5 秒）又和断言超时打平：重新加载，不依赖轮询时机。
		await page.reload();
		await expect(status).toHaveText("更新中替换并重新启动");
		await expect(row.getByRole("button", { name: "立即更新" })).toHaveCount(0);
	});

	test("新版本连续启动失败、恢复旧版本后显示「更新失败」及原因", async ({ page, connectAgent }) => {
		const reason =
			"新版本 2.0.0 连续 3 次启动失败（退出，或连上控制面后握手失败），已恢复到 1.0.0；控制面换成其他版本之前不再自动尝试";
		const agent = await connectAgent({ name: "agent-rolled-back", agentVersion: "1.0.0" });
		agent.send({
			case: "heartbeat",
			value: { runningTasks: [], update: { state: AgentUpdateState.FAILED, reason } },
		});
		await agent.sync();

		await page.goto("/agents");
		const cells = page.getByRole("row", { name: /agent-rolled-back/ }).getByRole("cell");
		await expect(cells.nth(1)).toHaveText(`更新失败${reason}`);
		await expect(cells.nth(3)).toHaveText("1.0.0控制面 2.0.0");
	});
});

test.describe("接入命令", () => {
	// 控制面配置了对外地址：命令里用它，而不是浏览器访问的地址。
	test.use({ controlPlaneOptions: { publicHttpUrl: "http://sfly.internal:8080" } });
	const command = "curl -fsSL http://sfly.internal:8080/install.sh | sh -s -- --name <名称>";

	test("没有 Agent 时显示空状态和填好控制面地址的 install.sh 命令", async ({ page }) => {
		await page.goto("/agents");
		const empty = page.getByRole("region", { name: "还没有 Agent 连接" });
		await expect(empty).toBeVisible();
		await expect(empty.locator('[data-slot="code-block"]')).toHaveText(command);
	});

	test("「如何接入 Agent」弹窗显示填好控制面地址的 install.sh 命令", async ({
		page,
		connectAgent,
	}) => {
		await connectAgent({ name: "agent-a" });
		await page.goto("/agents");
		await page.getByRole("button", { name: "如何接入 Agent" }).click();
		const dialog = page.getByRole("dialog", { name: "接入 Agent" });
		await expect(dialog.locator('[data-slot="code-block"]')).toHaveText(command);

		await dialog.getByRole("link", { name: "安装 Agent" }).click();
		await expect(page).toHaveURL(/\/docs\/install-agent$/);
		await expect(page.getByRole("article", { name: "安装 Agent" })).toBeVisible();
	});
});

test("「如何接入 Agent」弹窗：Esc 关闭后焦点回到按钮", async ({ page, connectAgent }) => {
	await connectAgent({ name: "agent-a" });
	await page.goto("/agents");
	const help = page.getByRole("button", { name: "如何接入 Agent" });
	await help.click();
	const dialog = page.getByRole("dialog", { name: "接入 Agent" });
	await expect(dialog).toContainText("install.sh");
	await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(help).toBeFocused();
});

test("加载中显示骨架，加载失败显示错误详情，重试后恢复", async ({ page, connectAgent }) => {
	await connectAgent({ name: "agent-a" });
	const hold = await holdApi(page, "/agents");
	await page.goto("/agents");
	await expect(page.getByRole("status", { name: "加载中" })).toBeVisible();
	hold.release();
	await expect(page.getByRole("row", { name: /agent-a/ })).toBeVisible();

	await page.unrouteAll();
	const outage = await failApi(page, "/agents");
	await page.reload();
	const error = page.getByRole("alert");
	await expect(error).toContainText("无法加载 Agent");
	await expect(error).toContainText("控制面暂时不可用");
	await expect(error).toContainText("GET /api/agents → 503 unavailable");

	await outage.restore();
	await error.getByRole("button", { name: "重试" }).click();
	await expect(page.getByRole("row", { name: /agent-a/ })).toBeVisible();
	await expect(error).toBeHidden();
});
