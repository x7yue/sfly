// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
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

/** 画布上的节点卡片（按节点 ID）。 */
export const nodeCard = (page: Page, id: string) => page.locator(`[data-node-id="${id}"]`);

/** 控制面上的最新版本（编辑起点）。 */
export async function headOf(cp: TestControlPlane, id: string) {
	const res = await cp.fetch(`/orchestrations/${id}/head`);
	return (await res.json()) as {
		number: number;
		document: { nodes: { id: string; inputs?: Record<string, unknown>; params?: unknown }[] };
	};
}
