import type { Page } from "@playwright/test";
import { LogLevel } from "../../server/test/support/fake-agent.js";
import { addMenu, dock, editorDocument, inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { FAILED_NODE, failedRun } from "./monitor-failure-scenario";
import { logLine, metricPackage, openMonitor } from "./monitor-scenario";
import { createScenario, publishPackage, triggerRun } from "./support";
import {
	copiedTextOf,
	expectNoUnsafeText,
	failRequests,
	HOSTILE,
	hostile,
	writtenOutOn,
} from "./untrusted-support";

// 控制台里显示「别人写的、平台不保证内容」的文字（#699）：Agent 报的、节点写的、节点包的元信息里带着改变文字方向的控制字符、
// 零宽字符、转义字符，页面上不能有任何一个原样留下（文字节点和属性值里都不能有），都写成看得见的样子；正常的中文、表情、
// 从右到左的文字显示不变。每个区域一条：逐页、逐个页签查整页（`expectNoUnsafeText`），不只是查某一处。

const BIDI = "U+202E";
const ZERO_WIDTH = "U+200B";
const ESCAPE = "U+001B";

/** 一段别人写的话：方向控制字符、零宽字符、转义序列（后面的 `[31m` 是普通的字）。 */
const hostileText = (label: string) =>
	`${label}${HOSTILE.bidi}gpj.exe ${HOSTILE.zeroWidth}隐藏${HOSTILE.escape}[31m`;

/** 写出来的字符里有这几个（按出现的顺序不限）。 */
async function expectWrittenOut(page: Page, ...labels: string[]) {
	const written = await writtenOutOn(page);
	for (const label of labels) {
		expect(written, `页面上写出来的字符：${written.join(" ")}`).toContain(label);
	}
}

test("失败原因、出错位置、日志里的警告：概览、详情的各个页签、顶栏、控制台，都写出来而不是原样留下", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	// 运行还在进行、已有节点失败：顶栏有失败摘要；失败原因的全文是多行的（第一行、堆栈）。
	const message = `${hostileText("AssertionError")}：成功率低于阈值\n\nTraceback (most recent call last):\n  File "x.py", line 1\n${hostileText("boom")}`;
	const location = hostileText("check.py 第 42 行");
	const { runId } = await failedRun(controlPlane, connectAgent, clock, {
		cleanupDone: false,
		message,
		location,
		warn: hostileText("重试间隔偏长"),
	});

	// 概览：失败区域（原因一行、出错位置、展开全文）、需要注意（日志里的警告）。
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}?view=overview`);
	await expect(page.getByRole("heading", { name: "链路", level: 2, exact: true })).toBeVisible();
	await expectNoUnsafeText(page, undefined, "概览：");
	await expectWrittenOut(page, BIDI, ZERO_WIDTH, ESCAPE);

	// 详情：选中失败的节点，逐个页签（尝试里有失败原因和位置、日志里有 ERROR 和 WARN 行）。
	for (const tab of ["attempts", "logs", "actions", "io", "artifacts"] as const) {
		await openMonitor(page, clock, runId, FAILED_NODE, tab);
		await expect(page.getByRole("region", { name: "底部面板" })).toBeVisible();
		await expectNoUnsafeText(page, undefined, `详情的${tab}页签：`);
	}
	await openMonitor(page, clock, runId, FAILED_NODE, "attempts");
	await expectWrittenOut(page, BIDI, ZERO_WIDTH);
	await openMonitor(page, clock, runId, FAILED_NODE, "logs");
	await expect(
		page.getByRole("region", { name: "底部面板" }).getByRole("button").first(),
	).toBeVisible();
	await expectWrittenOut(page, BIDI);

	// 顶栏的失败摘要（运行还在进行）：文字里和悬停提示里都没有。
	const summary = page.getByRole("banner").getByTestId("run-failure");
	await expect(summary).toBeVisible();
	await expectNoUnsafeText(page, page.getByRole("banner"), "顶栏：");

	// 控制台：运行块里正在做的节点。
	await page.goto("/");
	await expect(page.getByRole("region", { name: "正在运行" })).toBeVisible();
	await expectNoUnsafeText(page, undefined, "控制台：");
});

test("任务的进度说明、动作的名称和字段和原因、日志、输入输出、产物的名称：详情的各个页签和概览", async ({
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
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "别人写的文字", {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{
				id: "probe",
				kind: "package",
				package: "demo-checks",
				node: "ping",
				inputs: { host: "p" },
			},
		],
		edges: [{ from: "entry", to: "probe", kind: "chain" }],
		packages: { "demo-checks": "1.2.0" },
	});
	const runId = await triggerRun(controlPlane, scenarioId);
	const probe = await agent.nextAssign({ start: false });
	clock.advance(2000);
	await agent.started(probe);

	// 进度说明、动作（名称、字段、失败的原因）、日志（INFO 和一条带换行的）。
	agent.progress(probe, 1, 3, hostileText("正在拉取"));
	const now = clock.now().getTime();
	agent.actions(probe, [
		agent.actionStart(1, hostileText("下单"), now - 3000, {
			fields: { [hostileText("订单")]: hostileText("P-1") },
		}),
		agent.actionEnd(1, "failed", now - 2000, { reason: `${hostileText("拒单")}\n第二行` }),
		agent.actionMark(2, hostileText("收到成交"), now - 1000),
	]);
	agent.logs(probe, [
		logLine(clock, 1, hostileText("开始执行"), LogLevel.INFO),
		logLine(clock, 2, `${hostileText("第一段")}\t制表符`, LogLevel.INFO),
	]);
	await agent.sync();
	// 产物：名字里带零宽字符和方向控制字符（控制面不拦的话）。
	const artifactName = `report${HOSTILE.zeroWidth}${HOSTILE.bidi}.html`;
	const put = await controlPlane.fetch(
		`/tasks/${probe.taskId}/artifacts/${encodeURIComponent(artifactName)}`,
		{ method: "PUT", body: "<html>x</html>" },
	);
	clock.advance(1000);

	// 概览：进行中的节点（动作的名称、进度说明）。
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}?view=overview`);
	await expect(page.getByRole("heading", { name: "链路", level: 2, exact: true })).toBeVisible();
	await expectNoUnsafeText(page, undefined, "概览：");

	// 详情：各个页签。
	for (const tab of ["logs", "actions", "attempts", "io", "artifacts"] as const) {
		await openMonitor(page, clock, runId, "probe", tab);
		await expect(page.getByRole("region", { name: "底部面板" })).toBeVisible();
		await expectNoUnsafeText(page, undefined, `详情的${tab}页签：`);
	}
	await openMonitor(page, clock, runId, "probe", "logs");
	await expect(
		page.getByRole("region", { name: "底部面板" }).getByRole("button").first(),
	).toBeVisible();
	await expectWrittenOut(page, BIDI, ZERO_WIDTH, ESCAPE);
	await openMonitor(page, clock, runId, "probe", "actions");
	await expect(page.getByTestId("action-table")).toBeVisible();
	await expectWrittenOut(page, BIDI, ZERO_WIDTH);
	if (put.status === 201) {
		await openMonitor(page, clock, runId, "probe", "artifacts");
		await expect(page.getByRole("list", { name: "产物" })).toBeVisible();
		await expectWrittenOut(page, ZERO_WIDTH);
	}

	// 任务成功：输出里的字符串带着控制字符（JSON 不会转义它们）。
	await agent.succeed(probe, {
		note: hostileText("完成"),
		nested: { list: [hostileText("一"), `${HOSTILE.bidi}只有控制字符`] },
	});
	clock.advance(1000);
	await openMonitor(page, clock, runId, "probe", "io");
	await expect(page.getByRole("region", { name: "底部面板" })).toContainText("note");
	await expectNoUnsafeText(page, undefined, "输入输出：");
	await expectWrittenOut(page, BIDI, ZERO_WIDTH);
});

test("正常的中文、表情、从右到左的文字显示不变，只多一层方向隔离", async ({
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
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "正常的文字", {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "probe", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "p" } },
		],
		edges: [{ from: "entry", to: "probe", kind: "chain" }],
		packages: { "demo-checks": "1.2.0" },
	});
	const runId = await triggerRun(controlPlane, scenarioId);
	const probe = await agent.nextAssign({ start: false });
	clock.advance(2000);
	await agent.started(probe);
	const arabic = "مرحبا بالعالم：تم الاتصال";
	const mixed = "拉取完成 👩‍💻 🇨🇳 ❤️ café — 100%";
	agent.progress(probe, 1, 3, arabic);
	agent.logs(probe, [logLine(clock, 1, arabic), logLine(clock, 2, mixed)]);
	await agent.sync();
	clock.advance(1000);

	await openMonitor(page, clock, runId, "probe", "logs");
	const logs = page.getByRole("region", { name: "底部面板" });
	await expect(logs).toContainText(arabic);
	await expect(logs).toContainText(mixed);
	// 一个字符也没有被写出来，也没有不合格的字符；方向隔离在 <bdi> 里（阿拉伯文那一行按自己的方向排）。
	expect(await writtenOutOn(page)).toEqual([]);
	await expectNoUnsafeText(page);
	const arabicRow = logs.locator("bdi", { hasText: arabic }).first();
	await expect(arabicRow).toBeVisible();
	const direction = await arabicRow.evaluate((element) => ({
		isolate: getComputedStyle(element).unicodeBidi,
		dir: element.getAttribute("dir"),
	}));
	expect(direction.isolate).toMatch(/isolate/);
	// 旁边的文字不受影响：同一行里别的格子（级别、来源）还是从左到右。
	const row = logs.getByRole("button").first();
	expect(await row.evaluate((element) => getComputedStyle(element).direction)).toBe("ltr");
});

test("Agent 的名称、版本、系统：控制台的 Agent 列、Agent 管理页（库里的旧值）", async ({
	page,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a", slots: 2 });
	// 库里的旧值（写入时没有过表的）：拦下接口的响应，把名称、版本、系统换成带控制字符的。
	const taint = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(taint);
		if (value && typeof value === "object") {
			const object = value as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const [key, inner] of Object.entries(object)) {
				const isAgent = "agent_version" in object;
				out[key] =
					typeof inner === "string" && isAgent && ["agent_version", "os", "arch"].includes(key)
						? hostile(inner)
						: key === "name" &&
								typeof inner === "string" &&
								typeof object.status === "string" &&
								"info" in object
							? hostile(inner)
							: taint(inner);
			}
			return out;
		}
		return value;
	};
	for (const pattern of ["**/api/agents", "**/api/dashboard*"]) {
		await page.route(pattern, async (route) => {
			const response = await route.fetch();
			await route.fulfill({ response, json: taint(await response.json()) });
		});
	}
	await page.goto("/agents");
	await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
	await expectNoUnsafeText(page, undefined, "Agent 管理页：");
	await expectWrittenOut(page, BIDI);
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Agent", exact: false }).first()).toBeVisible();
	await expectNoUnsafeText(page, undefined, "控制台：");
});

test("节点包的元信息：节点包页、添加节点的菜单、检查器里节点类型的标题、说明、输入输出的名称和说明", async ({
	page,
	controlPlane,
}) => {
	const base = metricPackage() as { nodes: Record<string, unknown>[] };
	// 作者写的元信息：标题、说明（多行）、输入的键和说明、输出的键和说明。
	await publishPackage(controlPlane, {
		nodes: base.nodes.map((node) => ({
			...node,
			title: hostile(String(node.title)),
			description: `${hostileText("第一段说明")}\n\n${hostileText("第二段说明")}`,
		})),
	});
	const id = await createScenario(controlPlane, "日终数据处理", editorDocument);

	// 节点包页。
	await page.goto("/packages");
	await expect(page.getByRole("heading", { name: "节点包", level: 1 })).toBeVisible();
	await expectNoUnsafeText(page, undefined, "节点包页：");
	await expectWrittenOut(page, BIDI);

	// 编辑器：添加节点的菜单、选中一个节点之后的检查器。
	await openEditor(page, id);
	await dock(page).getByRole("button", { name: "添加节点" }).click();
	await expect(addMenu(page)).toBeVisible();
	await expectNoUnsafeText(page, addMenu(page), "添加节点的菜单：");
	await expectWrittenOut(page, BIDI);
	await page.keyboard.press("Escape");
	await nodeCard(page, "fetch").click();
	await expect(inspector(page)).toBeVisible();
	await expectNoUnsafeText(page, inspector(page), "检查器：");
	await expectNoUnsafeText(page, undefined, "编辑器整页：");
});

/** 节点包里的一个节点：标题、说明、输入和输出的键和说明里都带着有害字符（作者写的元信息，没有校验）。 */
const hostilePackageNodes = () => {
	const input = hostile("release_file");
	const output = hostile("url", "zeroWidth");
	return {
		input,
		output,
		nodes: [
			{
				name: "upload",
				title: hostile("上传"),
				description: hostileText("上传发布包"),
				entry: "demo_checks.upload:run",
				inputs: {
					type: "object",
					properties: {
						[input]: { type: "string", description: hostileText("要上传的发布包") },
						mode: { enum: ["fast", "safe"], description: hostileText("模式") },
					},
					required: [input],
					order: [input, "mode"],
				},
				outputs: {
					type: "object",
					properties: { [output]: { description: hostileText("上传之后的地址") } },
					order: [output],
				},
			},
		],
	};
};

test("编辑器和画布：Agent 的名称（卡片的标签、检查器、下拉）、输入名、节点包的说明和检查警告（卡片徽标的提示、检查器）", async ({
	page,
	controlPlane,
}) => {
	const { nodes } = hostilePackageNodes();
	await publishPackage(controlPlane, { nodes });
	// 场景文档里存着的 Agent 名（写入时没有校验）：默认 Agent 和节点自己的 Agent；没有必填的输入，检查会有警告，
	// 警告是控制面拼好的整句，里面有输入键、Agent 名。
	const defaultAgent = hostile("agent-default");
	const nodeAgent = hostile("agent-node", "zeroWidth");
	const id = await createScenario(controlPlane, "上传发布", {
		default_agent: defaultAgent,
		nodes: [
			{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
			{
				id: "upload",
				kind: "package",
				package: "demo-checks",
				node: "upload",
				agent: nodeAgent,
				position: { x: 300, y: 0 },
				inputs: {},
			},
		],
		edges: [{ from: "entry", to: "upload", kind: "chain" }],
		packages: { "demo-checks": "1.2.0" },
	});
	await openEditor(page, id, "upload");
	const card = nodeCard(page, "upload");

	// 画布卡片：Agent 的标签、节点包里节点的标题；警告徽标的提示（提示：悬停打开一次）。
	await expectNoUnsafeText(page, card, "卡片：");
	expect(await writtenOutOn(page, card)).toContain(BIDI);
	const badge = card.getByText(/警告/).first();
	await expect(badge).toBeVisible();
	await badge.hover();
	const tip = page.getByRole("tooltip").first();
	await expect(tip).toBeVisible();
	await expectNoUnsafeText(page, tip, "卡片警告的提示：");
	await page.mouse.move(5, 5);

	// 检查器：参数页（输入名、说明、顶部的检查警告）、下拉里的 Agent 名（「跟随默认（…）」和每一项）。
	await card.click();
	await expect(inspector(page)).toBeVisible();
	await expectNoUnsafeText(page, inspector(page), "检查器：");
	const options = await inspector(page).locator("select option").allTextContents();
	expect(options.join("\n"), "下拉里的选项").toContain("⟨U+202E⟩");
	expect(
		options.some((option) => option.startsWith("跟随默认") && option.includes("⟨U+202E⟩")),
	).toBe(true);
	await expectNoUnsafeText(page, undefined, "编辑器整页：");
});

test("提示、下拉、加载失败：节点包页的输入说明提示、运行切换的下拉、列表页的加载失败，各打开一次", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	// 提示：节点包页悬停有说明的输入名，提示里是说明的全文（多行的正文）。
	const { nodes } = hostilePackageNodes();
	await publishPackage(controlPlane, { nodes });
	await page.goto("/packages?name=demo-checks");
	const row = page.getByRole("table", { name: "节点类型" }).getByRole("row", { name: /上传/ });
	await row.locator('[tabindex="0"]').first().hover();
	const tip = page.locator('[data-slot="tooltip-content"]');
	await expect(tip).toBeVisible();
	await expectNoUnsafeText(page, tip, "输入说明的提示：");
	expect(await writtenOutOn(page, tip)).toContain(BIDI);
	await page.mouse.move(5, 5);

	// 下拉：运行监控顶栏的运行切换，列表读不出来时（接口的错误信息里带着有害字符）下拉里写错误。
	const { runId } = await failedRun(controlPlane, connectAgent, clock, { cleanupDone: true });
	await failRequests(page, "**/api/orchestrations/*/runs", "GET", hostileText("读运行列表失败"));
	await openMonitor(page, clock, runId);
	await page.getByRole("button", { name: /切换运行/ }).click();
	const menu = page.getByRole("menu");
	await expect(menu).toContainText("无法加载");
	await expectNoUnsafeText(page, menu, "运行切换的下拉：");
	expect(await writtenOutOn(page, menu)).toContain(BIDI);
	await page.keyboard.press("Escape");

	// 加载失败：列表页整页的错误状态（标题、原因、错误详情）。
	await failRequests(page, "**/api/agents", "GET", hostileText("读 Agent 列表失败"));
	await page.goto("/agents");
	const alert = page.getByRole("alert").first();
	await expect(alert).toBeVisible();
	await expectNoUnsafeText(page, undefined, "加载失败的页面：");
	expect(await writtenOutOn(page, alert)).toContain(BIDI);
});

test("小块选中复制出去是带尖括号的 ⟨U+202E⟩，和原文里本来就写着的「U+202E」分得开", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const message = `前面${HOSTILE.bidi}后面`;
	const { runId } = await failedRun(controlPlane, connectAgent, clock, {
		cleanupDone: false,
		message,
		location: "原文就写着 U+202E",
	});
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}?view=overview`);
	const chip = page.locator('[data-slot="hidden-character"]').first();
	await expect(chip).toBeVisible();
	// 显示的还是 U+202E（括号不占位置），复制出去的是带尖括号的。
	const bracketWidths = await chip
		.locator(".sr-only")
		.evaluateAll((brackets) => brackets.map((bracket) => (bracket as HTMLElement).clientWidth));
	expect(bracketWidths, "括号只给复制用，不占位置").toEqual([1, 1]);
	const copied = await copiedTextOf(chip.locator("xpath=.."));
	expect(copied).toContain("前面⟨U+202E⟩后面");
	expect(await page.getByText("原文就写着 U+202E").count()).toBeGreaterThan(0);
	expect(await copiedTextOf(page.getByText("原文就写着 U+202E").first())).toBe("原文就写着 U+202E");
});

test("从右到左的文字（希伯来文开头的混排、纯希伯来文、纯阿拉伯文、阿拉伯文夹英文）：和不经过方向隔离时逐像素一样", async ({
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
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "从右到左", {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "probe", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "p" } },
		],
		edges: [{ from: "entry", to: "probe", kind: "chain" }],
		packages: { "demo-checks": "1.2.0" },
	});
	const runId = await triggerRun(controlPlane, scenarioId);
	const probe = await agent.nextAssign({ start: false });
	clock.advance(2000);
	await agent.started(probe);
	const samples = [
		"שלום עולם 拉取完成 👩‍💻 🎉",
		"שלום עולם",
		"مرحبا بالعالم",
		"Result: مرحبا (تم) — done 100%",
	];
	for (const [index, text] of samples.entries()) {
		agent.progress(probe, index + 1, samples.length, text);
		await agent.sync();
		clock.advance(1000);
		await page.clock.setFixedTime(clock.now());
		await page.goto(`/runs/${runId}?view=overview`);
		// 进度说明那一格：文字所在的截断层（`data-truncate-clip`）。
		const clip = page.locator("[data-truncate-clip]", { hasText: text }).first();
		await expect(clip).toBeVisible();
		const withIsolation = await clip.screenshot({ animations: "disabled" });
		// 去掉方向隔离（拆开 <bdi>、截断层的 dir 和 unicode-bidi）：剩下的就是没有这个功能时的 DOM。
		await clip.evaluate((element) => {
			for (const bdi of element.querySelectorAll("bdi")) bdi.replaceWith(...bdi.childNodes);
			element.removeAttribute("dir");
			(element as HTMLElement).style.unicodeBidi = "normal";
		});
		const without = await clip.screenshot({ animations: "disabled" });
		expect(
			Buffer.compare(withIsolation, without),
			`「${text}」经过方向隔离之后和不隔离时的显示不一样`,
		).toBe(0);
	}
});
