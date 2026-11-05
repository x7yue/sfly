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
	]);
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
});

test("没有 Agent 时显示空状态和接入命令", async ({ page }) => {
	await page.goto("/agents");
	const empty = page.getByRole("region", { name: "还没有 Agent 连接" });
	await expect(empty).toBeVisible();
	await expect(empty).toContainText("sfly-agent --name <名称>");
	await expect(empty).toContainText("--server http://127.0.0.1:50051");
});

test("「如何接入 Agent」弹窗显示接入命令，Esc 关闭后焦点回到按钮", async ({
	page,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await page.goto("/agents");
	const help = page.getByRole("button", { name: "如何接入 Agent" });
	await help.click();
	const dialog = page.getByRole("dialog", { name: "接入 Agent" });
	await expect(dialog).toContainText("sfly-agent --name <名称>");
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
