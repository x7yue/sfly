// 切入点 A：保存编排版本时的静态检查（包版本锁定、引用）与节点执行配置。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import {
	packageArchive,
	packageMetadata,
	publishInit,
	publishPackage,
} from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 发布 checks@<version>：节点 fetch（输入 url，输出 outputs 里的键）和 verify。 */
function checksPackage(version: string, fetchOutputs: string[]) {
	return packageArchive(
		packageMetadata({
			name: "checks",
			version,
			nodes: [
				{
					name: "fetch",
					title: "抓取",
					entry: "checks.nodes:fetch",
					inputs: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
					outputs: {
						type: "object",
						properties: Object.fromEntries(fetchOutputs.map((k) => [k, {}])),
					},
				},
				{
					name: "verify",
					title: "校验",
					entry: "checks.nodes:verify",
					inputs: { type: "object", properties: { value: {} } },
					outputs: { type: "object", properties: {} },
				},
			],
		}),
		{ [`checks-${version}-py3-none-any.whl`]: strToU8("wheel") },
	);
}

/** entry(url) → fetch → verify(value = 引用)。 */
function document(value: unknown, packages: Record<string, string> = { checks: "1.0.0" }) {
	return {
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry", params: [{ name: "url", type: "string" }] },
			{
				id: "fetch",
				kind: "package",
				package: "checks",
				node: "fetch",
				inputs: { url: "${{ params.url }}" },
			},
			{ id: "verify", kind: "package", package: "checks", node: "verify", inputs: { value } },
		],
		edges: [
			{ from: "entry", to: "fetch", kind: "chain" },
			{ from: "fetch", to: "verify", kind: "chain" },
		],
		packages,
	};
}

describe("保存时的静态检查", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		for (const [version, outputs] of [
			["1.0.0", ["body", "status"]],
			["2.0.0", ["content", "status"]],
		] as const) {
			const res = await cp.fetch("/packages", publishInit(checksPackage(version, [...outputs])));
			expect(res.status).toBe(201);
		}
	});
	afterAll(async () => {
		await cp.close();
	});

	const save = async (doc: unknown) => {
		const id = await api.createOrchestration("检查");
		const res = await api.post(`/orchestrations/${id}/versions`, {
			base_version: 0,
			document: doc,
		});
		expect(res.status).toBe(201);
		return { id, warnings: ((await res.json()) as { warnings: unknown[] }).warnings };
	};

	it("引用本链入口参数和前面节点已声明的输出键时没有警告", async () => {
		const { warnings } = await save(document("${{ nodes.fetch.outputs.body }}"));
		expect(warnings).toEqual([]);
	});

	it("引用未声明的输出键、不存在的节点、不在前面的节点时仍然保存，但返回警告", async () => {
		const { id, warnings } = await save(
			document([
				"${{ nodes.fetch.outputs.bdoy }}",
				"${{ nodes.ghost.outputs.x }}",
				"${{ nodes.verify.outputs.x }}",
			]),
		);
		expect(warnings).toEqual([
			{
				code: "reference_unknown_output",
				node_id: "verify",
				input: "value",
				message: "节点 verify 的输入 value 引用的输出键 bdoy 没有在节点 fetch 的节点类型中声明",
			},
			{
				code: "reference_unknown_node",
				node_id: "verify",
				input: "value",
				message: "节点 verify 的输入 value 引用了不存在的节点 ghost",
			},
			{
				code: "reference_not_earlier",
				node_id: "verify",
				input: "value",
				message: "节点 verify 的输入 value 引用的节点 verify 不在本链上它的前面",
			},
		]);
		expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ head_version: 1 });
	});

	it("包节点没有锁定版本、锁定的版本不存在时返回警告", async () => {
		const unlocked = await save(document(null, {}));
		expect(unlocked.warnings).toMatchObject([
			{ code: "package_not_locked", node_id: "fetch" },
			{ code: "package_not_locked", node_id: "verify" },
		]);
		const missing = await save(document(null, { checks: "0.0.1" }));
		expect(missing.warnings).toMatchObject([
			{ code: "package_version_missing", node_id: "fetch" },
			{ code: "package_version_missing", node_id: "verify" },
		]);
	});

	it("锁定的版本随版本内容保存；升级到新版本后重新校验", async () => {
		const { id, warnings } = await save(document("${{ nodes.fetch.outputs.body }}"));
		expect(warnings).toEqual([]);

		// 2.0.0 把输出键 body 改名为 content：升级后原来的引用产生警告。
		const upgraded = await api.post(`/orchestrations/${id}/versions`, {
			base_version: await api.headVersion(id),
			document: document("${{ nodes.fetch.outputs.body }}", { checks: "2.0.0" }),
		});
		expect(((await upgraded.json()) as { warnings: unknown }).warnings).toMatchObject([
			{ code: "reference_unknown_output", node_id: "verify" },
		]);

		const fixed = await api.post(`/orchestrations/${id}/versions`, {
			base_version: await api.headVersion(id),
			document: document("${{ nodes.fetch.outputs.content }}", { checks: "2.0.0" }),
		});
		expect(((await fixed.json()) as { warnings: unknown }).warnings).toEqual([]);

		const v1 = await api.getJson<{ document: { packages: unknown } }>(
			`/orchestrations/${id}/versions/1`,
		);
		expect(v1.document.packages).toEqual({ checks: "1.0.0" });
		const v3 = await api.getJson<{ document: { packages: unknown } }>(
			`/orchestrations/${id}/versions/3`,
		);
		expect(v3.document.packages).toEqual({ checks: "2.0.0" });
	});
});

describe("节点执行配置", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	});
	afterAll(async () => {
		await cp.close();
	});

	const node = (extra: Record<string, unknown>) => ({
		id: "a",
		kind: "package",
		package: "stub",
		node: "echo",
		...extra,
	});
	const doc = (a: Record<string, unknown>) => ({
		default_agent: "agent-a",
		nodes: [{ id: "entry", kind: "entry" }, a],
		edges: [{ from: "entry", to: "a", kind: "chain" }],
		packages: { stub: "1.0.0" },
	});

	it("超时、重试次数、排队超时、always 随版本保存；不配置时不写入文档", async () => {
		const configured = node({ timeout: 120, retries: 2, queue_timeout: 30, always: true });
		const id = await api.orchestrationWith(doc(configured));
		await api.saveVersion(id, doc(node({})));
		const v1 = await api.getJson<{ document: { nodes: unknown[] } }>(
			`/orchestrations/${id}/versions/1`,
		);
		expect(v1.document.nodes[1]).toMatchObject({
			timeout: 120,
			retries: 2,
			queue_timeout: 30,
			always: true,
		});
		const v2 = await api.getJson<{ document: { nodes: Record<string, unknown>[] } }>(
			`/orchestrations/${id}/versions/2`,
		);
		expect(v2.document.nodes[1]).not.toHaveProperty("timeout");
		expect(v2.document.nodes[1]).not.toHaveProperty("retries");
		expect(v2.document.nodes[1]).not.toHaveProperty("queue_timeout");
		expect(v2.document.nodes[1]).toMatchObject({ always: false });
	});

	it("超时和排队超时必须是正整数秒，重试次数必须是非负整数", async () => {
		const id = await api.createOrchestration("坏配置");
		for (const bad of [{ timeout: 0 }, { timeout: 1.5 }, { queue_timeout: -1 }, { retries: -1 }]) {
			const res = await api.post(`/orchestrations/${id}/versions`, {
				base_version: await api.headVersion(id),
				document: doc(node(bad)),
			});
			expect(res.status, JSON.stringify(bad)).toBe(400);
		}
	});

	it("异步任务节点不能标记为 always；定时、Sleep 节点可以", async () => {
		const id = await api.createOrchestration("always");
		const withNode = (n: Record<string, unknown>) => ({
			nodes: [{ id: "entry", kind: "entry" }, n],
			edges: [{ from: "entry", to: n.id, kind: "chain" }],
		});
		const asyncAlways = await api.post(`/orchestrations/${id}/versions`, {
			base_version: await api.headVersion(id),
			document: withNode({ id: "x", kind: "async", always: true }),
		});
		expect(asyncAlways.status).toBe(400);
		for (const n of [
			{ id: "t", kind: "timer", at: "09:00:00", always: true },
			{ id: "s", kind: "sleep", duration: "1s", always: true },
		]) {
			const res = await api.post(`/orchestrations/${id}/versions`, {
				base_version: await api.headVersion(id),
				document: withNode(n),
			});
			expect(res.status).toBe(201);
		}
	});

	it("不配置超时时，派发给 Agent 的任务使用默认的 1 小时；配置了则用配置值", async () => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name: "agent-a" });
		try {
			const unset = await api.orchestrationWith(doc(node({})));
			await api.triggerOk(unset);
			expect((await agent.nextAssign()).timeoutSeconds).toBe(3600);

			const set = await api.orchestrationWith(doc(node({ timeout: 90 })));
			await api.triggerOk(set);
			expect((await agent.nextAssign()).timeoutSeconds).toBe(90);
		} finally {
			await agent.disconnect();
		}
	});
});
