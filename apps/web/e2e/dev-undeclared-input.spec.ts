import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { headOf, inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario } from "./support";

// 开发版本（包名@dev）的节点：画布上的检查（检查器里的警告、参数页的「没有声明 / 移除」）和控制面是同一套取法——
// 只看节点派发到的 Agent，都在线、都加载了、内容相同才用，查不到、对不齐时不报（照常触发，运行时仍会拦）。
// 不然画布会叫人「删掉这个输入」，而节点派发到的那台 Agent 其实声明了它（#444 的评审）。

const HOST = { type: "string" };
const EXTRA = { type: "string" };

/** 开发包 tuner-dev 的节点类型（默认 tune）：旧源码只有 host，新源码多了 extra；`outputs` 是声明的输出。 */
const metadata = (
	properties: Record<string, unknown>,
	{ node = "tune", outputs = {} }: { node?: string; outputs?: Record<string, unknown> } = {},
) =>
	JSON.stringify({
		name: "tuner-dev",
		version: "dev",
		requires_python: ">=3.10",
		nodes: [
			{
				name: node,
				title: "调参",
				entry: `tuner_dev:${node}`,
				inputs: { type: "object", properties, required: ["host"], order: Object.keys(properties) },
				outputs: { type: "object", properties: outputs },
			},
		],
	});
const OLD = metadata({ host: HOST });
const NEW = metadata({ host: HOST, extra: EXTRA });
const loaded = (json: string) => [
	{ name: "tuner-dev", source: "/src/tuner-dev", metadataJson: json },
];

/** 节点 t（开发版本）写了 host 和 extra；`agent` 是节点另选的 Agent，默认 Agent 是 agent-a。 */
const scenario = (agent?: string) => ({
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", position: { x: 0, y: 0 } },
		{
			id: "t",
			kind: "package",
			package: "tuner-dev",
			node: "tune",
			position: { x: 300, y: 0 },
			inputs: { host: "h", extra: "x" },
			...(agent === undefined ? {} : { agent }),
		},
	],
	edges: [{ from: "entry", to: "t", kind: "chain" }],
	packages: { "tuner-dev": "dev" },
});

/** 等控制面看到这台 Agent 离线了（编辑器打开时读到的 Agent 列表里它就是离线的）。 */
async function offline(controlPlane: TestControlPlane, name: string) {
	await expect
		.poll(async () => {
			const res = await controlPlane.fetch("/agents");
			const { agents } = (await res.json()) as { agents: { name: string; status: string }[] };
			return agents.find((a) => a.name === name)?.status;
		})
		.toBe("offline");
}

/** 打开场景、选中节点 t，返回检查器。 */
async function openNode(page: Page, id: string) {
	await openEditor(page, id, "t");
	await nodeCard(page, "t").click();
	const panel = inspector(page);
	await panel.getByRole("tab", { name: "参数" }).click();
	return panel;
}

/**
 * 检查器的参数页：没有「没有声明」的警告，节点卡片上没有警告，表单也没有停在「加载中」。
 * `unchecked`：检查跳过、表单那份里没有的输入，列成中性的「没有检查」行（每行一个「移除」）；默认没有。
 */
async function expectNoUndeclaredNotes(
	page: Page,
	panel: ReturnType<typeof inspector>,
	unchecked: string[] = [],
) {
	await expect(panel.locator("label", { hasText: "host" })).toBeVisible();
	await expect(panel.getByText("加载中")).toHaveCount(0);
	await expect(panel.getByText("没有在节点类型中声明")).toHaveCount(0);
	for (const name of unchecked) await expect(uncheckedRow(panel, name)).toBeVisible();
	await expect(panel.getByRole("button", { name: "移除" })).toHaveCount(unchecked.length);
	await expect(nodeCard(page, "t")).not.toContainText("警告");
}

/** 检查跳过时节点上填了、表单里没有的输入：参数页上中性的一行。 */
const uncheckedRow = (panel: ReturnType<typeof inspector>, name: string) =>
	panel.getByText(`输入 ${name}：节点派发到的 Agent 的声明查不到，没有检查`);

test("节点派到离线的 agent-b（新源码声明了 extra），在线的 agent-a 是旧源码：画布没有警告，参数页没有「移除」", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a", devPackages: loaded(OLD) });
	const b = await connectAgent({ name: "agent-b", devPackages: loaded(NEW) });
	await b.disconnect();
	await offline(controlPlane, "agent-b");
	const id = await createScenario(controlPlane, "派到离线的", scenario("agent-b"));
	const panel = await openNode(page, id);

	await expectNoUndeclaredNotes(page, panel);
	// 表单取节点自己派发到的 agent-b（离线也用）上次上报的：extra 是它的字段。
	await expect(panel.locator("label", { hasText: "extra" })).toBeVisible();
});

test("两台都在线，节点派到 agent-b（新源码），旧源码的 agent-a 排在前面：画布没有警告，表单取 agent-b 的", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	// agent-a 排在前面（按名字）：原来画布取列表里第一台，会拿旧的去查新的。
	await connectAgent({ name: "agent-a", devPackages: loaded(OLD) });
	await connectAgent({ name: "agent-b", devPackages: loaded(NEW) });
	const id = await createScenario(controlPlane, "两台都在线", scenario("agent-b"));
	const panel = await openNode(page, id);

	await expectNoUndeclaredNotes(page, panel);
	await expect(panel.locator("label", { hasText: "extra" })).toBeVisible();
});

test("只有离线的 agent-a 加载过（旧源码），节点派到它：画布不检查，没有警告，表单用它上次上报的", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const a = await connectAgent({ name: "agent-a", devPackages: loaded(OLD) });
	await a.disconnect();
	await offline(controlPlane, "agent-a");
	const id = await createScenario(controlPlane, "只有离线的", scenario());
	const panel = await openNode(page, id);

	// 检查跳过：没有警告、不说「没有声明」；表单有字段（旧源码只有 host，extra 没有表单字段）；节点上填了的 extra
	// 不能看不见：列成中性的一行（声明查不到，没有检查），可以移除。
	await expectNoUndeclaredNotes(page, panel, ["extra"]);
	await expect(panel.locator("label", { hasText: "extra" })).toHaveCount(0);
	// 表单取的就是节点派发到的 agent-a 的声明：没有「表单按 … 生成」的说明。
	await expect(panel.getByText(/表单按 .* 上报的声明生成/)).toHaveCount(0);
	await panel.getByRole("button", { name: "移除" }).click();
	await expect(uncheckedRow(panel, "extra")).toHaveCount(0);
	await expect(nodeCard(page, "t")).not.toContainText("警告");
	// 移除真的写进了保存的版本：保存后读回，t 只剩 host。
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.number).toBe(2);
	expect(head.document.nodes.find((n) => n.id === "t")?.inputs).toEqual({ host: "h" });
});

test("Agent 列表还没拿到时：参数页不列「没有检查」（节点上的每个输入都会被列出来，还带「移除」），拿到之后才列", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const a = await connectAgent({ name: "agent-a", devPackages: loaded(OLD) });
	await a.disconnect();
	await offline(controlPlane, "agent-a");
	const id = await createScenario(controlPlane, "列表加载中", scenario());
	// Agent 列表的请求挂住，等检查了再放行。
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/agents", async (route) => {
		await held;
		await route.continue();
	});
	const panel = await openNode(page, id);

	await expect(panel.getByText("加载中")).toBeVisible();
	await expect(panel.getByText(/没有检查/)).toHaveCount(0);
	await expect(panel.getByRole("button", { name: "移除" })).toHaveCount(0);
	release();
	// 拿到之后：表单有 host 字段，extra 列成「没有检查」，只有这一行有「移除」。
	await expect(uncheckedRow(panel, "extra")).toBeVisible();
	await expect(panel.getByText("加载中")).toHaveCount(0);
	await expect(panel.getByRole("button", { name: "移除" })).toHaveCount(1);
});

test("对照：节点派到的在线 agent-a 确实没有声明 extra：警告、「移除」都在，说明写明是哪台 Agent", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a", devPackages: loaded(OLD) });
	await connectAgent({ name: "agent-b", devPackages: loaded(NEW) });
	const id = await createScenario(controlPlane, "确实没声明", scenario("agent-a"));
	await openEditor(page, id, "t");
	await expect(nodeCard(page, "t")).toContainText("1 警告");
	await page.getByRole("button", { name: "1 条警告" }).click();
	const panel = inspector(page);
	const found = panel.getByRole("listitem").filter({ hasText: "输入 extra" });
	await expect(found).toContainText("没有声明");
	await expect(found).toContainText("节点派发到的 Agent agent-a");
	await found.getByRole("button", { name: "前往" }).click();
	await panel.getByRole("tab", { name: "参数" }).click();
	await expect(panel.getByText("输入 extra 没有在节点类型中声明")).toBeVisible();
	await panel.getByRole("button", { name: "移除" }).click();
	await expect(panel.getByText("输入 extra 没有在节点类型中声明")).toHaveCount(0);
	await expect(nodeCard(page, "t")).not.toContainText("警告");
});

test("目标（离线）上次加载的源码里还没有这个节点类型，别的 agent 上有：表单用别的 agent 的，不停在「找不到这个节点类型的元信息」", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	// agent-b（节点派到它）上次加载的源码里只有 other；在线的 agent-a 上有 tune（新源码，多了 extra）。
	await connectAgent({ name: "agent-a", devPackages: loaded(NEW) });
	const b = await connectAgent({
		name: "agent-b",
		devPackages: loaded(metadata({ host: HOST }, { node: "other" })),
	});
	await b.disconnect();
	await offline(controlPlane, "agent-b");
	const id = await createScenario(controlPlane, "目标没有这个节点", scenario("agent-b"));
	const panel = await openNode(page, id);

	await expect(panel.getByText("找不到这个节点类型的元信息")).toHaveCount(0);
	await expect(panel.locator("label", { hasText: "host" })).toBeVisible();
	await expect(panel.locator("label", { hasText: "extra" })).toBeVisible();
	await expect(nodeCard(page, "t")).not.toContainText("警告");
	// 字段取自 agent-a、而「Agent」一栏选的是 agent-b：说明字段是哪台上报的、agent-b 的声明为什么没有检查。
	await expect(
		panel.getByText("表单按 agent-a 上报的声明生成；节点派发到的 agent-b 的声明查不到，没有检查。"),
	).toBeVisible();
});

/**
 * 同一个包、同一个节点类型的三个节点，链是 entry → t → u → w：t 派到 agent-b（离线，声明了输出 out），u、w 派到在线的
 * agent-a（旧源码，没有输出）；内容不同，检查整包跳过。`nodes` 数组里 t、u 的先后由 `order` 决定（「下游的节点先建」时 u 在前）。
 */
const withOutput = (
	order: "t-first" | "u-first",
): { scenario: Record<string, unknown>; agentA: string; agentB: string } => {
	const pkg = (id: string, x: number, agent: string) => ({
		id,
		kind: "package",
		package: "tuner-dev",
		node: "tune",
		position: { x, y: 0 },
		inputs: { host: "h" },
		agent,
	});
	const t = pkg("t", 300, "agent-b");
	const u = pkg("u", 600, "agent-a");
	const w = pkg("w", 900, "agent-a");
	return {
		scenario: {
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry", position: { x: 0, y: 0 } },
				...(order === "t-first" ? [t, u] : [u, t]),
				w,
			],
			edges: [
				{ from: "entry", to: "t", kind: "chain" },
				{ from: "t", to: "u", kind: "chain" },
				{ from: "u", to: "w", kind: "chain" },
			],
			packages: { "tuner-dev": "dev" },
		},
		agentA: metadata({ host: HOST }),
		agentB: metadata({ host: HOST }, { outputs: { out: { type: "string" } } }),
	};
};

for (const order of ["t-first", "u-first"] as const) {
	test(`检查跳过的开发版本包，同一个节点类型的节点派到不同的 Agent：引用补全和「复制输出引用」各列各的输出，和 nodes 的顺序无关（${order}）`, async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		const fixture = withOutput(order);
		await connectAgent({ name: "agent-a", devPackages: loaded(fixture.agentA) });
		const b = await connectAgent({ name: "agent-b", devPackages: loaded(fixture.agentB) });
		await b.disconnect();
		await offline(controlPlane, "agent-b");
		const id = await createScenario(controlPlane, "补全", fixture.scenario);
		await openEditor(page, id, "w");

		// 节点 w 的输入里输入 $：补全里有 t（agent-b 的声明）的输出 out，没有 u（agent-a 的声明，没有输出）的。
		await nodeCard(page, "w").click();
		const panel = inspector(page);
		await panel.getByRole("tab", { name: "参数" }).click();
		const host = panel.getByRole("combobox", { name: "输入 host" });
		await host.click();
		await page.keyboard.press("End");
		await page.keyboard.type("$");
		const list = page.getByRole("listbox", { name: "可引用的值" });
		await expect(list.getByRole("option").filter({ hasText: "nodes.t.outputs.out" })).toBeVisible();
		await expect(list.getByRole("option").filter({ hasText: "nodes.u.outputs" })).toHaveCount(0);
		await page.keyboard.press("Escape");

		// t 的节点菜单：「复制输出引用」列出 out。
		await nodeCard(page, "t").click({ button: "right" });
		const menu = page.getByRole("menu").first();
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: /复制输出引用/ })).toBeEnabled();
		await menu.getByRole("menuitem", { name: /复制输出引用/ }).click();
		await expect(page.getByRole("menu", { name: "复制输出引用" }).getByRole("menuitem")).toHaveText(
			["out"],
		);
		await page.keyboard.press("Escape");

		// u 的节点菜单：agent-a 的声明里没有输出，「复制输出引用」不能点。
		await nodeCard(page, "u").click({ button: "right" });
		const uMenu = page.getByRole("menu").first();
		await expect(uMenu).toBeVisible();
		await expect(uMenu.getByRole("menuitem", { name: /复制输出引用/ })).toBeDisabled();
	});
}

test("保存之后马上刷新 Agent 列表：编辑器打开之后 agent-b 才上线并加载了新源码，保存后不用等下一轮轮询（十秒），参数页就取到它的声明", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a", devPackages: loaded(OLD) });
	// agent-b 先加载旧源码再离线：编辑器打开时它是离线的、声明里没有 extra。
	const before = await connectAgent({ name: "agent-b", devPackages: loaded(OLD) });
	await before.disconnect();
	await offline(controlPlane, "agent-b");
	const id = await createScenario(controlPlane, "保存刷新", scenario("agent-b"));
	const panel = await openNode(page, id);
	await expect(panel.locator("label", { hasText: "extra" })).toHaveCount(0);
	await expect(uncheckedRow(panel, "extra")).toBeVisible();

	// agent-b 上线、加载了新源码（编辑器的 Agent 列表要等下一轮轮询，这里不等）。
	await connectAgent({ name: "agent-b", devPackages: loaded(NEW) });
	// 改一个输入、保存：保存成功后刷新一次 Agent 列表，agent-b 的新声明马上取到，extra 有了表单字段，「没有检查」的行没了。
	const host = panel.getByRole("combobox", { name: "输入 host" });
	await host.click();
	await page.keyboard.press("End");
	await page.keyboard.type("1");
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	await expect(panel.locator("label", { hasText: "extra" })).toBeVisible({ timeout: 5_000 });
	await expect(uncheckedRow(panel, "extra")).toHaveCount(0);
});
