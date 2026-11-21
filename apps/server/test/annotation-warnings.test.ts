// 注释框的警告（#316，docs/SEMANTICS.md §1.6）：保存时返回、带 annotation_id，只警告，不阻断触发。
// HTTP API + 真实 PostgreSQL。
import { orchestrationsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { echo } from "./support/chains.js";
import { FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const baseDocument = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ ...echo("pause"), display_name: "等灰度" },
		{ id: "spawn", kind: "async" },
		{ id: "sub", kind: "subflow_entry", name: "report", params: [] },
		echo("wait"),
	],
	edges: [
		{ from: "entry", to: "pause", kind: "chain" },
		{ from: "pause", to: "spawn", kind: "chain" },
		{ from: "spawn", to: "sub", kind: "dispatch" },
		{ from: "sub", to: "wait", kind: "chain" },
	],
	packages: { stub: "1.0.0" },
};

const annotations = [
	{
		id: "annotation_1",
		title: "造测试数据",
		nodes: ["pause", "http_request_9", "pause"],
		subflows: ["nowhere"],
	},
	{ id: "annotation_2", title: "还没想好", nodes: [], subflows: [] },
	{ id: "annotation_3", title: "正常", nodes: ["entry"], subflows: ["sub"] },
];

const EXPECTED = [
	{
		code: "annotation_duplicate_member",
		message: "注释框「造测试数据」（annotation_1）把节点 等灰度（pause） 写了 2 次",
		annotation_id: "annotation_1",
		target: "nodes/pause",
	},
	{
		code: "annotation_unknown_node",
		message: "注释框「造测试数据」（annotation_1）引用了不存在的节点 http_request_9",
		annotation_id: "annotation_1",
		target: "nodes/http_request_9",
	},
	{
		code: "annotation_unknown_subflow",
		message:
			"注释框「造测试数据」（annotation_1）引用了不存在的子流程 nowhere（子流程成员写子流程入口节点的节点 ID，不是子流程名称）",
		annotation_id: "annotation_1",
		target: "subflows/nowhere",
	},
	{
		code: "annotation_no_members",
		message: "注释框「还没想好」（annotation_2）没有成员",
		annotation_id: "annotation_2",
	},
];

describe("注释框的警告", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		// 触发前的预检要求节点包已发布、Agent 已注册（不必在线）。
		await publishPackage(cp, "stub", "1.0.0", { echo: ["v"] });
		await (await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" })).disconnect();
	}, 120_000);
	afterAll(async () => {
		await cp?.close();
	});

	const save = async (document: unknown) => {
		const id = await api.createOrchestration("有注释框");
		const res = await api.post(`/orchestrations/${id}/versions`, { base_version: 0, document });
		expect(res.status, await res.clone().text()).toBe(201);
		return { id, saved: orchestrationsApi.saveVersion.response.parse(await res.json()) };
	};

	it("保存成功，返回三种警告：指出注释框和成员，带 annotation_id，没有 node_id", async () => {
		const { saved } = await save({ ...baseDocument, annotations });
		expect(saved.warnings).toEqual(EXPECTED);
	});

	it("恢复历史版本时返回同样的警告", async () => {
		const { id } = await save({ ...baseDocument, annotations });
		const res = await api.postEmpty(`/orchestrations/${id}/versions/1/restore`);
		expect(res.status).toBe(201);
		expect(orchestrationsApi.restoreVersion.response.parse(await res.json()).warnings).toEqual(
			EXPECTED,
		);
	});

	it("没有这些问题的注释框没有警告", async () => {
		const { saved } = await save({ ...baseDocument, annotations: [annotations[2]] });
		expect(saved.warnings).toEqual([]);
	});

	it("不阻断触发：预检没有问题，触发成功", async () => {
		const { id } = await save({ ...baseDocument, annotations });
		const preflight = await api.getJson<{ problems: unknown[] }>(`/orchestrations/${id}/preflight`);
		expect(preflight.problems).toEqual([]);
		const runId = await api.triggerOk(id);
		await api.cancelOk(runId);
	});

	it("同时有真正阻断触发的问题时，触发被拒绝，原因里只有那一个，没有注释框的警告", async () => {
		const stray = echo("stray");
		const { id } = await save({
			...baseDocument,
			nodes: [...baseDocument.nodes, stray],
			annotations,
		});
		const preflight = await api.getJson<{ problems: { code: string }[] }>(
			`/orchestrations/${id}/preflight`,
		);
		expect(preflight.problems.map((p) => p.code)).toEqual(["orphan_node"]);
		const res = await api.trigger(id);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; details: { code: string }[] } };
		expect(body.error.details.map((p) => p.code)).toEqual(["orphan_node"]);
	});
});
