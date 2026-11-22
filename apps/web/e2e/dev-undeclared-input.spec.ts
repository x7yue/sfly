import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario } from "./support";

// 开发版本（包名@dev）的节点：画布上的检查（检查器里的警告、参数页的「没有声明 / 移除」）和控制面是同一套取法——
// 只看节点派发到的 Agent，都在线、都加载了、内容相同才用，查不到、对不齐时不报（照常触发，运行时仍会拦）。
// 不然画布会叫人「删掉这个输入」，而节点派发到的那台 Agent 其实声明了它（#444 的评审）。

const HOST = { type: "string" };
const EXTRA = { type: "string" };

/** 开发包 tuner-dev 的节点类型 tune：旧源码只有 host，新源码多了 extra。 */
const metadata = (properties: Record<string, unknown>) =>
	JSON.stringify({
		name: "tuner-dev",
		version: "dev",
		requires_python: ">=3.10",
		nodes: [
			{
				name: "tune",
				title: "调参",
				entry: "tuner_dev:tune",
				inputs: { type: "object", properties, required: ["host"], order: Object.keys(properties) },
				outputs: { type: "object", properties: {} },
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

/** 检查器的参数页：没有「没有声明」的提示和「移除」，节点卡片上没有警告，表单也没有停在「加载中」。 */
async function expectNoUndeclaredNotes(page: Page, panel: ReturnType<typeof inspector>) {
	await expect(panel.locator("label", { hasText: "host" })).toBeVisible();
	await expect(panel.getByText("加载中")).toHaveCount(0);
	await expect(panel.getByText("没有在节点类型中声明")).toHaveCount(0);
	await expect(panel.getByRole("button", { name: "移除" })).toHaveCount(0);
	await expect(nodeCard(page, "t")).not.toContainText("警告");
}

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

	// 检查跳过：没有警告、没有「移除」；表单有字段（旧源码只有 host，extra 没有表单字段，也不提示没声明）。
	await expectNoUndeclaredNotes(page, panel);
	await expect(panel.locator("label", { hasText: "extra" })).toHaveCount(0);
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
