import type { Locator, Page } from "@playwright/test";
import {
	AgentUpdateState,
	type AssignedTask,
	agentClock,
} from "../../server/test/support/fake-agent.js";
import { setAgentDisabled, setAuthKind } from "./agent-admin-support";
import { expect, test } from "./fixtures";
import { createFocusScenario, saveVersion, setFocusItems } from "./focus-support";
import {
	advance,
	httpCheckPoints,
	MONITOR_SCENARIO,
	metricPackage,
	runningScenario,
} from "./monitor-scenario";
import {
	createScenario,
	elapseWithHeartbeats,
	failApi,
	holdApi,
	publishPackage,
	scenarioUsing,
	triggerRun,
	withSubflow,
} from "./support";

// Agent 管理页（原型 #agents）：每台 Agent 是一个机架面板，头部一行是状态和告警，主体是槽位格。

// 控制面版本固定为 1.2.3：与它一致的 Agent 才会被派任务（ADR 0014）。
test.use({ controlPlaneOptions: { version: "1.2.3" } });

const NAMES = { probe: "探测主机", subflow: "巡检子流程" };

/** 一台 Agent 的机架（面板的名称是 Agent 名称）。 */
const rack = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
/** 机架头部：状态、告警、名称、版本、系统、对外地址、最后在线。 */
const header = (page: Page, name: string) => rack(page, name).locator("header");
/** 机架里的槽位格：占用的格子和合并的空闲条（格子里的关注项列表不算）。 */
const slotCells = (page: Page, name: string) =>
	rack(page, name).getByRole("list", { name: "槽位" }).locator(":scope > li");
/** 一个槽位格里这个任务的关注项（没设关注项时是主指标）。 */
const slotFocus = (cell: Locator, what: "关注项" | "主指标" = "关注项") =>
	cell.getByRole("list", { name: `这个任务的${what}` }).getByRole("listitem");
const queued = (page: Page, name: string) =>
	rack(page, name).getByRole("list", { name: "排队的任务" }).getByRole("listitem");

test("机架头部：状态、名称、版本、系统、对外地址、最后在线，右侧是被引用的场景数；节点包与能力在底部", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await connectAgent({
		name: "agent-busy",
		agentVersion: "1.2.3",
		os: "linux",
		arch: "x86_64",
		slots: 2,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
		capabilities: [{ name: "files", version: 1 }],
		peer: { port: 50052 },
	});
	// 不上报端口和能力的旧版本 Agent。
	const gone = await connectAgent({
		name: "agent-gone",
		agentVersion: "1.0.0",
		os: "macos",
		arch: "aarch64",
	});
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-busy"));
	await createScenario(controlPlane, "巡检副本", scenarioUsing("agent-busy"));
	clock.advance(90_000);
	await gone.disconnect();

	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理", level: 1 })).toBeVisible();
	const busy = header(page, "agent-busy");
	await expect(busy.locator("[data-status]")).toHaveText("在线");
	await expect(busy.getByRole("heading", { name: "agent-busy", level: 2 })).toBeVisible();
	await expect(busy).toContainText("1.2.3");
	await expect(busy).toContainText("linux/x86_64");
	await expect(busy).toContainText("对外地址 127.0.0.1:50052");
	await expect(busy).toContainText("最后在线 现在");
	await expect(busy).toContainText("被 2 个场景引用");
	await expect(rack(page, "agent-busy").locator("dl")).toHaveText(
		"节点包demo-checks@1.2.0能力files v1",
	);

	// 离线时间按浏览器时区（测试固定为 Asia/Shanghai）显示；离线的 Agent 不提示版本与控制面不一致。
	const offline = header(page, "agent-gone");
	await expect(offline.locator("[data-status]")).toHaveText("离线");
	await expect(offline).toContainText("1.0.0");
	await expect(offline).not.toContainText("控制面 1.2.3");
	await expect(offline).toContainText("macos/aarch64");
	await expect(offline).toContainText("最后在线 01-01 08:01");
	await expect(offline).toContainText("未被引用");
	await expect(rack(page, "agent-gone").locator("dl")).toHaveText("节点包无能力无");
	// 离线的 Agent 接不了任务：槽位不算空闲，没有任务时不画槽位一栏，也不写占用数。
	await expect(slotCells(page, "agent-gone")).toHaveCount(0);
	await expect(rack(page, "agent-gone").getByRole("heading", { name: "槽位" })).toHaveCount(0);
	await expect(rack(page, "agent-gone")).not.toContainText("占用");
	await expect(rack(page, "agent-gone")).not.toContainText("空闲");
});

test("槽位格：占用的格子写节点、场景、运行编号、所在链、尝试号、节点类型和已执行时长；空闲的槽位合并成一行矮条，没有槽位编号", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-busy", slots: 4 });
	await publishPackage(controlPlane);
	const named = scenarioUsing("agent-busy");
	const runId = await triggerRun(
		controlPlane,
		await createScenario(controlPlane, "巡检", {
			...named,
			nodes: named.nodes.map((n) => (n.id === "ping" ? { ...n, display_name: "探测主机" } : n)),
		}),
	);
	await agent.nextAssign();
	await elapseWithHeartbeats(clock, [agent], 90_000);

	await page.goto("/agents");
	const cells = slotCells(page, "agent-busy");
	await expect(cells).toHaveCount(2);
	const cell = cells.first();
	await expect(cell).toContainText("探测主机（ping）");
	await expect(cell).toContainText("巡检");
	await expect(cell).toContainText(runId.slice(0, 8));
	await expect(cell).toContainText("主链 · 第 1 次尝试 · demo-checks/ping");
	await expect(cell).toContainText("1m 30s");
	// 连续的空闲槽合并成一行，不随旁边的格子拉伸。
	const idle = cells.nth(1);
	await expect(idle).toHaveText("3 个槽位空闲");
	const cellHeight = (await cell.boundingBox())?.height ?? 0;
	const idleHeight = (await idle.boundingBox())?.height ?? 0;
	expect(idleHeight).toBeGreaterThan(0);
	expect(idleHeight).toBeLessThan(cellHeight);
	await expect(rack(page, "agent-busy")).toContainText("1 / 4 占用 · 排队 0");
	// 系统里没有槽位身份，不写「槽 1」这样的编号。
	await expect(rack(page, "agent-busy")).not.toContainText(/槽 ?\d/);

	// 已执行时长跟着控制面时间走。
	await elapseWithHeartbeats(clock, [agent], 60_000);
	await expect(cell).toContainText("2m 30s", { timeout: 15_000 });
});

test("槽位格：槽位占满时没有空闲条；还在准备的任务写「准备中」，不写时长", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-small", slots: 2 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent-small"));
	await triggerRun(controlPlane, scenario);
	await triggerRun(controlPlane, scenario);
	await agent.nextAssign();
	await agent.nextAssign({ start: false });

	await page.goto("/agents");
	const cells = slotCells(page, "agent-small");
	await expect(cells).toHaveCount(2);
	await expect(cells.nth(0)).not.toContainText("准备中");
	await expect(cells.nth(1)).toContainText("准备中");
	await expect(rack(page, "agent-small")).toContainText("2 / 2 占用 · 排队 0");
	await expect(rack(page, "agent-small")).not.toContainText("槽位空闲");
});

test("槽位格：Agent 断线后租约到期前还占着槽位的任务照常列出，但不写空闲条和占用数", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-busy", slots: 4 });
	await publishPackage(controlPlane);
	await triggerRun(
		controlPlane,
		await createScenario(controlPlane, "巡检", scenarioUsing("agent-busy")),
	);
	await agent.nextAssign();
	await agent.disconnect();

	await page.goto("/agents");
	await expect(header(page, "agent-busy").locator("[data-status]")).toHaveText("离线");
	await expect(slotCells(page, "agent-busy")).toHaveCount(1);
	await expect(slotCells(page, "agent-busy").first()).toContainText("巡检");
	await expect(rack(page, "agent-busy")).not.toContainText("空闲");
	await expect(rack(page, "agent-busy")).not.toContainText("占用");
});

test("槽位格：子流程里的任务写子流程名称，主链的任务写「主链」；可访问名称写出节点和场景", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-busy", slots: 4 });
	await publishPackage(controlPlane);
	await triggerRun(
		controlPlane,
		await createScenario(controlPlane, "撮合", withSubflow("agent-busy", NAMES)),
	);
	await agent.nextAssign();
	await agent.nextAssign();

	await page.goto("/agents");
	const main = slotCells(page, "agent-busy").filter({ hasText: "探测主机" });
	await expect(main).toContainText("主链 · 第 1 次尝试");
	await expect(main).toHaveAccessibleName("节点 探测主机（probe），场景 撮合");
	const inside = slotCells(page, "agent-busy").filter({ hasText: "子流程 巡检子流程" });
	await expect(inside).toContainText("子流程 巡检子流程 · 第 1 次尝试 · demo-checks/ping");
	await expect(inside).toHaveAccessibleName("节点 verify，场景 撮合");
});

test("排队的任务：列在格子下面，写排队了多久、多久后排队超时；开始执行后离开队列", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-small", slots: 1 });
	await publishPackage(controlPlane);
	const first = await triggerRun(
		controlPlane,
		await createScenario(controlPlane, "巡检", scenarioUsing("agent-small")),
	);
	const held = await agent.nextAssign();
	const waiting = await triggerRun(
		controlPlane,
		await createScenario(controlPlane, "拨测", scenarioUsing("agent-small")),
	);
	await elapseWithHeartbeats(clock, [agent], 90_000);

	await page.goto("/agents");
	await expect(rack(page, "agent-small")).toContainText("1 / 1 占用 · 排队 1");
	await expect(slotCells(page, "agent-small")).toHaveCount(1);
	await expect(slotCells(page, "agent-small").first()).toContainText(first.slice(0, 8));
	const row = queued(page, "agent-small");
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("ping");
	await expect(row).toContainText("拨测");
	await expect(row).toContainText(waiting.slice(0, 8));
	// 排队超时默认 10 分钟：排队了 1 分 30 秒，还剩 8 分 30 秒。
	await expect(row).toContainText("排队 1m 30s · 8m 30s 后超时");

	// 槽位空出来，排队的任务开始执行。
	await agent.succeed(held, {});
	await agent.nextAssign();
	await expect(queued(page, "agent-small")).toHaveCount(0, { timeout: 15_000 });
	await expect(slotCells(page, "agent-small").first()).toContainText(waiting.slice(0, 8));
	await expect(rack(page, "agent-small")).toContainText("1 / 1 占用 · 排队 0");
});

test("加载中：骨架是每台 Agent 一个面板，外面没有再套一层面板", async ({ page }) => {
	await holdApi(page, "/projects/default/agents");
	await page.goto("/agents");
	const skeleton = page.getByRole("status", { name: "加载中" });
	await expect(skeleton).toBeVisible();
	await expect(skeleton.locator("xpath=ancestor::section")).toHaveCount(0);
});

test("排队的任务：Agent 不在线时照样列在它名下", async ({ page, controlPlane, connectAgent }) => {
	const away = await connectAgent({ name: "agent-away" });
	await away.disconnect();
	await publishPackage(controlPlane);
	await triggerRun(
		controlPlane,
		await createScenario(controlPlane, "巡检", scenarioUsing("agent-away")),
	);

	await page.goto("/agents");
	await expect(header(page, "agent-away").locator("[data-status]")).toHaveText("离线");
	await expect(queued(page, "agent-away")).toHaveCount(1);
	await expect(queued(page, "agent-away")).toContainText("10m 00s 后超时");
	// 离线又没有任务占着槽位：没有槽位一栏，也不写「占用」。
	await expect(rack(page, "agent-away").getByRole("heading", { name: "槽位" })).toHaveCount(0);
	await expect(slotCells(page, "agent-away")).toHaveCount(0);
	await expect(rack(page, "agent-away")).not.toContainText("占用");
});

test("准备环境中：状态后面写「准备环境中 · 2m 10s」（时长与槽位格、排队行同一种写法），版本、最后在线照常，还接不了任务所以不写占用、不画空闲槽；发出心跳后「准备环境中」消失", async ({
	page,
	connectAgent,
	clock,
}) => {
	const preparing = await connectAgent(
		{ name: "agent-prep", agentVersion: "1.2.3", slots: 2 },
		{ preparing: true },
	);
	await connectAgent({ name: "agent-ready", agentVersion: "1.2.3" });
	clock.advance(130_000);

	await page.goto("/agents");
	const status = (name: string) => header(page, name).locator("[data-status]");
	await expect(header(page, "agent-prep")).toContainText("在线准备环境中 · 2m 10s");
	await expect(status("agent-ready")).toHaveText("在线");
	await expect(header(page, "agent-ready")).not.toContainText("准备环境中");
	// 准备期间照常显示版本和最后在线；还不接任务，槽位不算空闲。
	await expect(header(page, "agent-prep")).toContainText("1.2.3");
	await expect(header(page, "agent-prep")).toContainText("最后在线 现在");
	await expect(rack(page, "agent-prep")).not.toContainText("占用");
	await expect(rack(page, "agent-prep")).not.toContainText("槽位空闲");

	// 时长按控制面时间走：控制面时间过了一分钟，页面不用刷新列表就变了。
	clock.advance(60_000);
	await expect(header(page, "agent-prep")).toContainText("准备环境中 · 3m 10s", {
		timeout: 15_000,
	});

	// 准备好（发出第一次心跳）：列表刷新后「准备环境中」消失，仍然在线。
	await preparing.ready();
	await expect(header(page, "agent-prep")).not.toContainText("准备环境中", { timeout: 15_000 });
	await expect(status("agent-prep")).toHaveText("在线");
	await expect(rack(page, "agent-prep")).toContainText("0 / 2 占用");
	await expect(rack(page, "agent-prep")).toContainText("2 个槽位空闲");
});

test.describe("凭据种类和停用（#492）", () => {
	test("最近一次连接用的凭据：Agent 自己的凭据什么都不写；共享令牌写「用共享令牌连接」并提示换成 Agent 凭据；没有凭据告警本版本内仍可连接、下一个版本起拒绝；没记过的不写", async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		// 假 Agent 默认用 Agent 凭据连接（auth_kind 为 agent）。
		for (const name of ["agent-own", "agent-shared", "agent-none", "agent-unknown"]) {
			await connectAgent({ name, agentVersion: "1.2.3" });
		}
		await setAuthKind(controlPlane, "agent-shared", "shared");
		await setAuthKind(controlPlane, "agent-none", "none");
		// 升级之前连接的 Agent 还没有记过它用的凭据。
		await setAuthKind(controlPlane, "agent-unknown", null);

		await page.goto("/agents");
		await expect(header(page, "agent-shared")).toContainText(
			"用共享令牌连接 · 请换成这台 Agent 自己的凭据",
		);
		await expect(header(page, "agent-none")).toContainText(
			"没有凭据 · 本版本内仍可连接，下一个版本起拒绝",
		);
		// 共享令牌只是提示，没有凭据才是告警（颜色不同）。
		await expect(header(page, "agent-shared").getByText("用共享令牌连接")).not.toHaveClass(
			/text-warn-fg/,
		);
		await expect(header(page, "agent-none").getByText("没有凭据", { exact: true })).toHaveClass(
			/text-warn-fg/,
		);
		for (const name of ["agent-own", "agent-unknown"]) {
			await expect(header(page, name)).not.toContainText("凭据");
			await expect(header(page, name)).not.toContainText("共享令牌");
		}
	});

	test("已停用：状态写「已停用」和停用时间（不写离线），槽位不算空闲、不写占用；恢复、重新连上之后回到在线", async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		const agent = await connectAgent({ name: "agent-off", agentVersion: "1.2.3", slots: 2 });
		await connectAgent({ name: "agent-on", agentVersion: "1.2.3", slots: 2 });
		// 最近一次连接没有带凭据（过渡期里的旧方式）：在线的时候告警，停用之后不写（它带什么都连不上）。
		await setAuthKind(controlPlane, "agent-off", "none");
		clock.advance(60_000);

		await page.goto("/agents");
		await expect(header(page, "agent-off").locator("[data-status]")).toHaveText("在线");
		await expect(header(page, "agent-off")).toContainText("没有凭据 · 本版本内仍可连接");
		await expect(slotCells(page, "agent-off")).toHaveCount(1);

		// 管理员停用：控制面立即断开它的连接；页面按轮询更新。
		await setAgentDisabled(controlPlane, "agent-off", true);
		await expect.poll(() => agent.ended).toBe(true);
		await expect(header(page, "agent-off").locator("[data-status]")).toHaveText("已停用", {
			timeout: 15_000,
		});
		await expect(header(page, "agent-off")).toContainText("停用于");
		await expect(header(page, "agent-off")).not.toContainText("离线");
		// 停用的 Agent 不写凭据提示：「本版本内仍可连接」是假的。
		await expect(header(page, "agent-off")).not.toContainText("没有凭据");
		await expect(header(page, "agent-off")).not.toContainText("本版本内仍可连接");
		await expect(rack(page, "agent-off")).not.toContainText("占用");
		await expect(slotCells(page, "agent-off")).toHaveCount(0);
		// 别的 Agent 不受影响。
		await expect(header(page, "agent-on").locator("[data-status]")).toHaveText("在线");
		await expect(header(page, "agent-on")).not.toContainText("已停用");

		// 恢复之后它重新连上：回到在线，停用的字样消失。
		await setAgentDisabled(controlPlane, "agent-off", false);
		await connectAgent({ name: "agent-off", agentVersion: "1.2.3", slots: 2 });
		// 页面每 5 秒重新读一次 Agent 列表。
		await expect(header(page, "agent-off").locator("[data-status]")).toHaveText("在线", {
			timeout: 15_000,
		});
		await expect(header(page, "agent-off")).not.toContainText("停用于");
		await expect(slotCells(page, "agent-off")).toHaveCount(1);
	});
});

test("时钟偏差：Agent 时间比控制面快 613 天时显示，只差 1 秒时不显示，心跳测到新的偏差后更新", async ({
	page,
	connectAgent,
	clock,
}) => {
	const DAY = 86_400_000;
	const now = () => clock.now().getTime();
	await connectAgent({
		name: "agent-ahead",
		...agentClock(now() + 613 * DAY + 3 * 3_600_000, 5_000),
	});
	const synced = await connectAgent({ name: "agent-synced", ...agentClock(now() + 1_000, 5_000) });
	// 不上报时间的旧版本 Agent：偏差未知，不显示。
	await connectAgent({ name: "agent-old" }, { clock: false });

	await page.goto("/agents");
	await expect(header(page, "agent-ahead")).toContainText("在线时间比控制面快 613 天");
	await expect(header(page, "agent-synced").locator("[data-status]")).toHaveText("在线");
	await expect(header(page, "agent-synced")).not.toContainText("时间比控制面");
	await expect(header(page, "agent-old")).not.toContainText("时间比控制面");

	// 这台机器的时间被往回改了 90 秒：下一次心跳后显示出来。
	clock.advance(10_000);
	await synced.heartbeat([], agentClock(now() - 90_000, 15_000));
	// 列表每 STATUS_POLL_MS（5 秒）才重新拉取一次，默认的 5 秒等不到下一次。
	await expect(header(page, "agent-synced")).toContainText("在线时间比控制面慢 1 分钟", {
		timeout: 15_000,
	});
});

test("对外地址与能力：显式配置的地址标明来源；端口被占用时说明能力不能被其它 Agent 调用及原因", async ({
	page,
	connectAgent,
}) => {
	await connectAgent({
		name: "agent-nat",
		capabilities: [
			{ name: "files", version: 2 },
			{ name: "exec", version: 1 },
		],
		peer: { port: 6000, publicAddress: "10.20.30.40" },
	});
	await connectAgent({
		name: "agent-busy-port",
		capabilities: [{ name: "files", version: 2 }],
		peer: { port: 50052, listenError: "端口 50052 已被占用" },
	});
	await connectAgent({ name: "agent-old" });

	await page.goto("/agents");
	await expect(header(page, "agent-nat")).toContainText("对外地址 10.20.30.40:6000 · 安装时配置");
	await expect(rack(page, "agent-nat").locator("dl")).toHaveText("节点包无能力files v2、exec v1");
	await expect(header(page, "agent-busy-port")).toContainText("对外地址 127.0.0.1:50052");
	await expect(header(page, "agent-busy-port")).toContainText(
		"不能被其它 Agent 调用 · 端口 50052 已被占用",
	);
	// 不监听端口的旧版本 Agent：只有地址，没有能力，也不重复说明为什么不能调用。
	await expect(header(page, "agent-old")).toContainText("对外地址 127.0.0.1");
	await expect(header(page, "agent-old")).not.toContainText("对外地址 127.0.0.1:");
	await expect(header(page, "agent-old")).not.toContainText("不能被其它 Agent 调用");
	await expect(rack(page, "agent-old").locator("dl")).toHaveText("节点包无能力无");
	// 端口被占用不影响执行任务：状态照常是在线。
	await expect(header(page, "agent-busy-port").locator("[data-status]")).toHaveText("在线");
});

test("节点包安装：安装中的 Agent 状态写「安装中」和包名；安装失败在状态后面写哪个包失败，Agent 仍然在线", async ({
	page,
	connectAgent,
}) => {
	const installing = await connectAgent({ name: "agent-installing" });
	installing.send({
		case: "install",
		value: {
			package: "demo-checks",
			version: "1.2.0",
			state: 1, // INSTALLING
			taskId: "t-1",
			installedPackages: [],
		},
	});
	const failed = await connectAgent({ name: "agent-failed-install" });
	failed.send({
		case: "install",
		value: {
			package: "demo-checks",
			version: "1.3.0",
			state: 3, // FAILED
			taskId: "t-2",
			output: "依赖冲突",
			installedPackages: [],
		},
	});
	await installing.sync();
	await failed.sync();

	await page.goto("/agents");
	await expect(header(page, "agent-installing").locator("[data-status]")).toHaveText("安装中");
	await expect(header(page, "agent-installing")).toContainText("demo-checks@1.2.0");
	await expect(header(page, "agent-failed-install").locator("[data-status]")).toHaveText("在线");
	await expect(header(page, "agent-failed-install")).toContainText("安装 demo-checks@1.3.0 失败");
});

test("状态后面的告警按固定顺序排：时钟偏差、能力不可调用、节点包安装失败", async ({
	page,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-all-warnings",
		capabilities: [{ name: "files", version: 2 }],
		peer: { port: 50052, listenError: "端口 50052 已被占用" },
		...agentClock(clock.now().getTime() + 3_600_000, 5_000),
	});
	agent.send({
		case: "install",
		value: {
			package: "demo-checks",
			version: "1.3.0",
			state: 3, // FAILED
			taskId: "t-3",
			output: "依赖冲突",
			installedPackages: [],
		},
	});
	await agent.sync();

	await page.goto("/agents");
	const text = (await header(page, "agent-all-warnings").innerText()).replaceAll(/\s+/g, " ");
	const positions = ["时间比控制面", "不能被其它 Agent 调用", "安装 demo-checks@1.3.0 失败"].map(
		(warning) => text.indexOf(warning),
	);
	expect(positions.every((position) => position >= 0)).toBe(true);
	expect(positions).toEqual([...positions].sort((a, b) => a - b));
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
		const status = (name: string) => header(page, name).locator("[data-status]");
		await expect(status("agent-current")).toHaveText("在线");
		await expect(header(page, "agent-current")).toContainText("2.0.0");
		await expect(header(page, "agent-current")).not.toContainText("控制面 2.0.0");
		await expect(status("agent-old")).toHaveText("版本不一致");
		await expect(header(page, "agent-old")).toContainText("1.0.0");
		await expect(header(page, "agent-old")).toContainText("控制面 2.0.0");
		await expect(status("agent-waiting")).toHaveText("更新中");
		await expect(header(page, "agent-waiting")).toContainText("等待 2 个任务结束");
		await expect(status("agent-manual")).toHaveText("需要手动升级");
		await expect(header(page, "agent-manual")).toContainText("已指定 --no-auto-update，不自动更新");
		await expect(status("agent-failed")).toHaveText("更新失败");
		await expect(header(page, "agent-failed")).toContainText("sha256 不匹配");
		await expect(header(page, "agent-failed")).toContainText("1.0.0");
		await expect(header(page, "agent-failed")).toContainText("控制面 2.0.0");
		await expect(status("agent-downloading")).toHaveText("更新中");
		await expect(header(page, "agent-downloading")).toContainText("下载新版本");
		// 「立即更新」放在头部右侧，只给确实在更新流程中（下载中、等待任务结束）的 Agent：
		// 更新失败、需要手动升级、没有上报更新状态的旧 Agent 都没有。
		const updateNow = (name: string) =>
			header(page, name).getByRole("button", { name: "立即更新" });
		await expect(updateNow("agent-waiting")).toBeVisible();
		await expect(updateNow("agent-downloading")).toBeVisible();
		await expect(updateNow("agent-old")).toHaveCount(0);
		await expect(updateNow("agent-failed")).toHaveCount(0);
		await expect(updateNow("agent-current")).toHaveCount(0);
		await expect(updateNow("agent-manual")).toHaveCount(0);
		// 状态和告警在同一行（头部是一行，不换行成几块）。
		// 按各元素的竖直中线比：按 8px 分桶的写法在页面上方的版面一变、中线跨过桶边界时会误报。
		const middles = await header(page, "agent-waiting")
			.locator("[data-status], h2, button")
			.evaluateAll((all) =>
				all.map((el) => {
					const box = el.getBoundingClientRect();
					return box.top + box.height / 2;
				}),
			);
		expect(Math.max(...middles) - Math.min(...middles)).toBeLessThan(8);
	});

	test("立即更新：确认框列出会被终止的任务；取消不产生影响，确认后状态变为替换中", async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		await publishPackage(controlPlane);
		const current = await connectAgent({ name: "agent-a", slots: 2 });
		const named = scenarioUsing("agent-a");
		const first = await triggerRun(
			controlPlane,
			await createScenario(controlPlane, "巡检", {
				...named,
				nodes: named.nodes.map((n) => (n.id === "ping" ? { ...n, display_name: "探测主机" } : n)),
			}),
		);
		const second = await triggerRun(
			controlPlane,
			await createScenario(controlPlane, "拨测", scenarioUsing("agent-a")),
		);
		const held = [await current.nextAssign(), await current.nextAssign()];
		// 控制面升级后，旧版本 Agent 带着手上的任务重新连上，等它们结束。
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
		const top = header(page, "agent-a");
		await expect(top).toContainText("等待 2 个任务结束");
		// 机架里这两个任务各占一格，槽位占满没有空闲条。
		await expect(slotCells(page, "agent-a")).toHaveCount(2);
		const open = async () => {
			await top.getByRole("button", { name: "立即更新" }).click();
			const dialog = page.getByRole("dialog", { name: "立即更新 agent-a？" });
			await expect(dialog).toBeVisible();
			return dialog;
		};

		// 确认框列出会被终止的任务。
		let dialog = await open();
		const terminated = dialog.getByRole("list", { name: "会被终止的任务" }).getByRole("listitem");
		await expect(terminated).toHaveCount(2);
		// 有显示名称的节点写成「显示名称（节点 ID）」，没有的只写节点 ID。
		await expect(terminated.nth(0)).toContainText("探测主机（ping）");
		await expect(terminated.nth(0)).toContainText(first.slice(0, 8));
		await expect(terminated.nth(1)).toContainText("ping");
		await expect(terminated.nth(1)).not.toContainText("（");
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
		await expect(top).toContainText("等待 2 个任务结束");

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
		await expect(top).toContainText("更新中替换并重新启动");
		await expect(top.getByRole("button", { name: "立即更新" })).toHaveCount(0);
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
		const top = header(page, "agent-rolled-back");
		await expect(top.locator("[data-status]")).toHaveText("更新失败");
		await expect(top).toContainText(reason);
		await expect(top).toContainText("1.0.0");
		await expect(top).toContainText("控制面 2.0.0");
	});
});

test.describe("接入命令", () => {
	// 控制面配置了对外地址：命令里用它，而不是浏览器访问的地址。
	test.use({ controlPlaneOptions: { publicHttpUrl: "http://sfly.internal:8080" } });
	const command =
		"(read -rs SFLY_TOKEN && export SFLY_TOKEN && curl -fsSL http://sfly.internal:8080/install.sh | sh -s -- --name <名称>)";

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
	const hold = await holdApi(page, "/projects/default/agents");
	await page.goto("/agents");
	await expect(page.getByRole("status", { name: "加载中" })).toBeVisible();
	hold.release();
	await expect(rack(page, "agent-a")).toBeVisible();

	await page.unrouteAll();
	const outage = await failApi(page, "/projects/default/agents");
	await page.reload();
	const error = page.getByRole("alert");
	await expect(error).toContainText("无法加载 Agent");
	await expect(error).toContainText("控制面暂时不可用");
	await expect(error).toContainText("GET /api/projects/default/agents → 503 unavailable");

	await outage.restore();
	await error.getByRole("button", { name: "重试" }).click();
	await expect(rack(page, "agent-a")).toBeVisible();
	await expect(error).toBeHidden();
});

const ITEMS = [
	"files.write v1",
	"files.watch v1",
	"demo-checks@1.2.0",
	"sfly-stub@0.1.0",
	"sfly-std@0.3.1",
];

test("能力与节点包的每一项不拆开（不在连字符处折行），很长时在机架里折行，不撑出横向滚动", async ({
	page,
	connectAgent,
}) => {
	await connectAgent({
		name: "agent-linux",
		agentVersion: "1.2.3",
		os: "linux",
		arch: "x86_64",
		capabilities: [
			{ name: "files", version: 1 },
			{ name: "files.write", version: 1 },
			{ name: "files.read", version: 1 },
			{ name: "files.watch", version: 1 },
			{ name: "exec", version: 1 },
		],
		installedPackages: [
			{ name: "demo-checks", version: "1.2.0" },
			{ name: "sfly-stub", version: "0.1.0" },
			{ name: "sfly-std", version: "0.3.1" },
		],
		peer: { port: 50052, publicAddress: "10.20.30.40" },
	});

	for (const width of [1280, 1920]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/agents");
		await expect(rack(page, "agent-linux")).toBeVisible();
		const broken = await rack(page, "agent-linux")
			.locator("dd")
			.evaluateAll((cells, items) => {
				const lineOf = (cell: Element, index: number) => {
					const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
					let seen = 0;
					for (let node = walker.nextNode(); node; node = walker.nextNode()) {
						const text = node as Text;
						if (index < seen + text.length) {
							const range = document.createRange();
							range.setStart(text, index - seen);
							range.setEnd(text, index - seen + 1);
							return range.getBoundingClientRect().top;
						}
						seen += text.length;
					}
					return Number.NaN;
				};
				return items.filter((item) =>
					cells.some((cell) => {
						const at = (cell.textContent ?? "").indexOf(item);
						return at >= 0 && lineOf(cell, at) !== lineOf(cell, at + item.length - 1);
					}),
				);
			}, ITEMS);
		expect(broken, `${width}px 宽时被拆开的项`).toEqual([]);
		const scrolls = await page.locator("#main").evaluate((el) => el.scrollWidth > el.clientWidth);
		expect(scrolls, `${width}px 宽时横向滚动`).toBe(false);
	}
});

test("立即更新失败时，原因写在确认框里，不发通知", async ({ page, connectAgent }) => {
	const agent = await connectAgent({
		name: "agent-waiting",
		agentVersion: "1.2.2",
		os: "linux",
		arch: "x86_64",
	});
	agent.send({
		case: "heartbeat",
		value: {
			runningTasks: [],
			update: { state: AgentUpdateState.WAITING_FOR_TASKS, remainingTasks: 2 },
		},
	});
	await agent.sync();
	await page.route("**/api/projects/default/agents/agent-waiting/update-now", (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({ error: { code: "unavailable", message: "Agent 没有应答" } }),
		}),
	);
	await page.goto("/agents");
	await page.getByRole("button", { name: "立即更新" }).click();
	const dialog = page.getByRole("dialog", { name: /立即更新/ });
	await dialog.getByRole("button", { name: "立即更新" }).click();
	await expect(dialog.getByRole("alert")).toHaveText("立即更新失败：Agent 没有应答");
	await expect(dialog).toBeVisible();
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

const HOUR_43 = (60 + 43) * 60_000;
/** 「已 57s 无新数据」「已 1m 02s 无新数据」：多久取决于最后一个点和读数生成时刻的差。 */
const STALE = /已 (?:\d+m )?\d+s 无新数据/;

test("槽位格：正在做的动作和已持续多久；没有动作时写进度的说明；随列表刷新，动作结束后撤掉", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
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

	await page.goto("/agents");
	const withAction = slotCells(page, "agent-a").filter({ hasText: "verify" });
	const activity = withAction.getByTestId("slot-activity");
	await expect(activity).toContainText("正在");
	await expect(activity).toContainText("保持 4 小时");
	await expect(activity).toContainText("1h 43m");
	await expect(activity).not.toContainText("下单");
	await expect(withAction).toHaveAccessibleName(/，正在做 保持 4 小时(，|$)/);

	// 没有动作时写进度的说明：不写「正在」，也没有时长。
	const withProgress = slotCells(page, "agent-a").filter({ hasText: "probe" });
	await expect(withProgress.getByTestId("slot-activity")).toHaveText("第 3 批");
	await expect(withProgress).toHaveAccessibleName(/，正在做 第 3 批(，|$)/);

	// 最外层的动作换了：列表刷新后跟着变；时长随控制面时间走。
	agent.actionSummary(verify, {
		total: 3,
		reported: 3,
		running: [{ id: 3, parent: null, depth: 0, name: "收尾", fields: {}, ...agent.stamp(now) }],
	});
	await expect(activity).toContainText("收尾", { timeout: 15_000 });
	await expect(activity).not.toContainText("保持 4 小时");
	await expect(withAction).toHaveAccessibleName(/，正在做 收尾(，|$)/);

	// 动作都结束了、也没有进度：这一行撤掉。
	agent.actionSummary(verify, { total: 3, reported: 3 });
	await expect(activity).toHaveCount(0, { timeout: 15_000 });
	await expect(withAction).not.toHaveAccessibleName(/正在做/);
});

test("槽位格：只显示前两个关注项，有异常的排前、带三角和原因，多出的写「还有 N 个关注项」；可访问名称写出有异常的项", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const scenarioId = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, scenarioId, [
		{ node_id: "fetch", chart: "延迟" },
		{ node_id: "fetch", chart: "吞吐" },
		{ node_id: "fetch", chart: "请求数" },
		{ node_id: "fetch", chart: "errors", title: "错误数" },
	]);
	const clock0 = clock.now().getTime();
	await triggerRun(controlPlane, scenarioId);
	const fetch = await agent.nextAssign();
	agent.metrics(fetch, httpCheckPoints(clock0, 0, 3));
	await agent.sync();
	// 之后只有延迟还在上报：吞吐、请求数、错误数都超过 30 秒没有新数据。
	await advance(clock, agent, 60_000, () => {
		const s = Math.floor(clock.now().getTime() / 1000);
		agent.metrics(fetch, [
			["latency_ms", s, 45],
			["p99_ms", s, 90],
		]);
	});

	await page.goto("/agents");
	const cell = slotCells(page, "agent-a").first();
	const rows = slotFocus(cell);
	// 作者的顺序是延迟、吞吐、请求数、错误数；有异常的排前，所以前两项是吞吐和请求数。
	await expect(rows).toHaveCount(3);
	await expect(rows.nth(0)).toContainText("吞吐");
	await expect(rows.nth(0)).toContainText("165");
	await expect(rows.nth(0)).toContainText("req/s");
	await expect(rows.nth(0)).toContainText(STALE);
	await expect(rows.nth(0).locator('[data-status-dot="warn"]')).toHaveCount(1);
	await expect(rows.nth(1)).toContainText("请求数");
	await expect(rows.nth(1)).toContainText("520");
	await expect(rows.nth(1).locator('[data-status-dot="warn"]')).toHaveCount(1);
	await expect(rows.nth(2)).toHaveText("还有 2 个关注项");
	await expect(cell).not.toContainText("延迟");
	await expect(cell).not.toContainText("错误数");
	// 可访问名称写出有异常的项（不只是显示出来的两项）。
	await expect(cell).toHaveAccessibleName(
		new RegExp(
			`^节点 fetch，场景 撮合浸泡，3 项需要注意：吞吐 ${STALE.source}；请求数 ${STALE.source}；错误数 ${STALE.source}$`,
		),
	);
});

test("槽位格：场景没设关注项时显示这个节点的主指标并写明原因；主指标有异常时右侧写异常的原因", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await runningScenario(controlPlane, connectAgent, clock);

	await page.goto("/agents");
	// probe 是子流程里的 ping，主指标 level 现在是 3；verify 是第 2 次尝试，10 分钟以内开始的重试算异常。
	const probe = slotCells(page, "agent-a").filter({ hasText: "probe" });
	const probeRows = slotFocus(probe, "主指标");
	await expect(probeRows).toHaveCount(1);
	await expect(probeRows).toContainText("主指标 level");
	await expect(probeRows).toContainText("3");
	await expect(probeRows).toContainText("场景没有设置关注项");
	// 右侧的说明是中文，不用等宽字体（等宽只给数值，例如「2s 前」）。
	await expect(probeRows.getByText("场景没有设置关注项")).not.toHaveCSS(
		"font-family",
		/JetBrains Mono/,
	);
	await expect(probeRows.locator('[data-status-dot="warn"]')).toHaveCount(0);

	const verify = slotCells(page, "agent-a").filter({ hasText: "verify" });
	const verifyRows = slotFocus(verify, "主指标");
	await expect(verifyRows).toContainText("主指标 level");
	await expect(verifyRows).toContainText("重试（第 2 次尝试）");
	await expect(verifyRows).not.toContainText("场景没有设置关注项");
	await expect(verifyRows.locator('[data-status-dot="warn"]')).toHaveCount(1);
	await expect(verify).toHaveAccessibleName(
		/，1 项需要注意：主指标 level 重试（第 2 次尝试）· \d\d:\d\d:\d\d$/,
	);
	// 没有主指标的节点（这里没有）不写关注项；别的任务的主指标不会出现在这个格子里。
	await expect(slotFocus(probe, "关注项")).toHaveCount(0);
});

test("槽位格：这次运行的节点包版本里没有这张图表时，写明原因，不显示数值", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	// 之后的版本升到 1.3.0，ping 多了一张图表「水位」，作者把它设为关注项；这次运行锁定的是 1.2.0，没有这张图表。
	const nodes = metricPackage().nodes.map((node) =>
		node.name === "ping"
			? { ...node, charts: [{ title: "水位", type: "line", metrics: ["level"] }] }
			: node,
	);
	await publishPackage(controlPlane, { version: "1.3.0", nodes });
	await saveVersion(controlPlane, scenarioId, 1, {
		...MONITOR_SCENARIO,
		packages: { "demo-checks": "1.3.0" },
	});
	await setFocusItems(controlPlane, scenarioId, [{ node_id: "probe", chart: "水位" }]);

	await page.goto("/agents");
	const row = slotFocus(slotCells(page, "agent-a").filter({ hasText: "probe" })).first();
	await expect(row).toContainText("水位");
	await expect(row).toContainText("这个版本的节点没有图表 水位");
	await expect(row).not.toContainText("还没有数据");
	await expect(row.locator('[data-status-dot="warn"]')).toHaveCount(0);
});

test("同一个运行的几个槽位只读一次关注项，每个运行各读一次，只要最新值（points=0）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent } = await runningScenario(controlPlane, connectAgent, clock);
	// 第二个运行也在这台 Agent 上占一个槽位：页面上共三个槽位格，来自两个运行。
	const other = await triggerRun(
		controlPlane,
		await createScenario(controlPlane, "拨测", scenarioUsing("agent-a")),
	);
	await agent.nextAssign();
	const requested: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		const run = /^\/api\/runs\/([^/]+)\/focus$/.exec(url.pathname)?.[1];
		if (run) requested.push(`${run}${url.search}`);
	});

	await page.goto("/agents");
	await expect(slotCells(page, "agent-a")).toHaveCount(4);
	await expect(rack(page, "agent-a").getByRole("list", { name: "这个任务的主指标" })).toHaveCount(
		3,
	);
	expect([...requested].sort()).toEqual([`${runId}?points=0`, `${other}?points=0`].sort());
});

test("关注项读不到时，槽位格仍写正在做的动作，关注项的位置写「无法加载关注项」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	agent.progress(tasks.probe as AssignedTask, 3, 10, "第 3 批");
	await agent.sync();
	await page.route(/\/api\/runs\/[^/]+\/focus/, (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({ error: { code: "unavailable", message: "控制面暂时不可用" } }),
		}),
	);

	await page.goto("/agents");
	const probe = slotCells(page, "agent-a").filter({ hasText: "probe" });
	await expect(probe.getByTestId("slot-activity")).toHaveText("第 3 批");
	await expect(probe).toContainText("无法加载关注项", { timeout: 15_000 });
	await expect(slotFocus(probe, "主指标")).toHaveCount(0);
});
