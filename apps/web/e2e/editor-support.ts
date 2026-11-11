// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { expect, type Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { createScenario, publishPackage } from "./support";

/**
 * 编排画布测试用的场景：主链 entry → fetch(http_check) → dispatch(异步任务) → ping，
 * dispatch 调度子流程 sub_entry → sub_ping。入口参数 biz_date（必填）、api_token（敏感，有默认值）。
 */
export const editorDocument = {
	default_agent: "agent-linux",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			position: { x: 0, y: 0 },
			params: [
				{ name: "biz_date", type: "string", required: true },
				{ name: "api_token", type: "string", secret: true, default: "s3cr3t" },
			],
		},
		{
			id: "fetch",
			kind: "package",
			package: "demo-checks",
			node: "http_check",
			position: { x: 252, y: 0 },
			inputs: { url: "https://example.test/snap" },
		},
		{
			id: "dispatch",
			kind: "async",
			position: { x: 504, y: 0 },
			params: { date: "${{ params.biz_date }}" },
		},
		{
			id: "ping",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			position: { x: 756, y: 0 },
			inputs: { host: "${{ nodes.fetch.outputs.status }}" },
		},
		{
			id: "sub_entry",
			kind: "subflow_entry",
			position: { x: 660, y: 230 },
			params: [{ name: "date", type: "string", required: true }],
		},
		{
			id: "sub_ping",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			position: { x: 912, y: 230 },
			inputs: { host: "${{ params.date }}" },
		},
	],
	edges: [
		{ from: "entry", to: "fetch", kind: "chain" },
		{ from: "fetch", to: "dispatch", kind: "chain" },
		{ from: "dispatch", to: "ping", kind: "chain" },
		{ from: "dispatch", to: "sub_entry", kind: "dispatch" },
		{ from: "sub_entry", to: "sub_ping", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
};

/** 发布 demo-checks@1.2.0，新建「日终数据处理」并保存为第 1 版；返回场景 ID。 */
export async function createEditorScenario(cp: TestControlPlane): Promise<string> {
	await publishPackage(cp);
	return createScenario(cp, "日终数据处理", editorDocument);
}

/** demo-checks 的节点类型：probe 有一个输出，typed 的输入覆盖整数、数字、布尔、枚举、JSON。 */
export const typedNodes = [
	{
		name: "probe",
		title: "探测",
		entry: "demo_checks.http:probe",
		inputs: { type: "object", properties: {} },
		outputs: { type: "object", properties: { status: { type: "integer" } } },
	},
	{
		name: "typed",
		title: "各种类型",
		entry: "demo_checks.http:typed",
		inputs: {
			type: "object",
			properties: {
				count: { type: "integer" },
				ratio: { type: "number" },
				strict: { type: "boolean" },
				level: { enum: ["low", "high"] },
				options: { type: "object" },
				payload: { type: "array" },
			},
		},
		outputs: { type: "object", properties: {} },
	},
];

/** 主链 entry → probe → typed：typed.count 是整值引用（旧场景的写法），其余是常量。配合 typedNodes 发布的包使用。 */
export const typedDocument = {
	default_agent: "agent-linux",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			position: { x: 0, y: 0 },
			params: [
				{ name: "n", type: "number" },
				{ name: "flag", type: "boolean" },
			],
		},
		{
			id: "probe",
			kind: "package",
			package: "demo-checks",
			node: "probe",
			position: { x: 252, y: 0 },
			inputs: {},
		},
		{
			id: "typed",
			kind: "package",
			package: "demo-checks",
			node: "typed",
			position: { x: 504, y: 0 },
			inputs: {
				count: "${{ nodes.probe.outputs.status }}",
				ratio: 0.5,
				strict: true,
				level: "low",
				options: { retries: 2 },
			},
		},
	],
	edges: [
		{ from: "entry", to: "probe", kind: "chain" },
		{ from: "probe", to: "typed", kind: "chain" },
	],
	packages: { "demo-checks": "1.2.0" },
};

/** 画布上的节点卡片（按节点 ID）。 */
export const nodeCard = (page: Page, id: string) => page.locator(`[data-node-id="${id}"]`);

/** 画布底部的工具条。 */
export const dock = (page: Page) => page.getByRole("toolbar", { name: "画布工具" });
/** 添加节点菜单。 */
export const addMenu = (page: Page) => page.getByRole("dialog", { name: "添加节点" });
/** 右侧的检查器。 */
export const inspector = (page: Page) => page.getByRole("complementary", { name: "检查器" });
/** 节点的右键菜单。 */
export const nodeMenu = (page: Page) => page.getByRole("menu", { name: "节点菜单" });
/** 画布空白处的右键菜单。 */
export const paneMenu = (page: Page) => page.getByRole("menu", { name: "画布菜单" });

/** 画布上的一条连线（`chain:a->b`、`dispatch:a->b`）。 */
export const edge = (page: Page, id: string) => page.locator(`[data-edge="${id}"]`);
/** 画布上全部连线的 ID，排好序。 */
export const edges = (page: Page) =>
	page
		.locator("[data-edge]")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-edge") ?? "").sort());

/** 节点在画布坐标里的位置（React Flow 写在节点外层的 transform 上）。 */
export const nodePosition = (page: Page, id: string) =>
	page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => {
		const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(
			(el as HTMLElement).style.transform,
		);
		return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
	});

/** 系统剪贴板里的文字（测试需要先授权 clipboard-read）。 */
export const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** 打开场景的编排画布，等节点 `lastNode` 和工具条出现、打开时的适配视图落定（节点位置不再变化）。 */
export async function openEditor(page: Page, id: string, lastNode = "sub_ping") {
	await page.goto(`/orchestrations/${id}`);
	await expect(nodeCard(page, lastNode)).toBeVisible();
	await expect(dock(page)).toBeVisible();
	await expect
		.poll(async () => JSON.stringify(await nodeCard(page, "entry").boundingBox()))
		.toBe(JSON.stringify(await nodeCard(page, "entry").boundingBox()));
}

/**
 * 本地草稿（localStorage，写入有 300ms 防抖）里的某个节点；还没有草稿或没有这个节点时为 undefined。
 * 刷新页面前用 `expect.poll` 等草稿写进去，不用固定等待。
 */
export const draftNode = (page: Page, scenarioId: string, nodeId: string) =>
	page.evaluate(
		([key, node]) => {
			const raw = localStorage.getItem(key);
			const draft = raw
				? (JSON.parse(raw) as { document: { nodes: ({ id: string } & Record<string, unknown>)[] } })
				: null;
			return draft?.document.nodes.find((n) => n.id === node);
		},
		[`sfly.draft.${scenarioId}`, nodeId] as const,
	);

/** 控制面上的最新版本（编辑起点）。 */
export async function headOf(cp: TestControlPlane, id: string) {
	const res = await cp.fetch(`/orchestrations/${id}/head`);
	return (await res.json()) as {
		number: number;
		document: { nodes: { id: string; inputs?: Record<string, unknown>; params?: unknown }[] };
	};
}
