import { orchestrationsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { ManualClock } from "./support/manual-clock.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const docV1 = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "url", type: "string", required: true }] },
		{ id: "check", kind: "package", package: "http", node: "check", inputs: { url: "x" } },
	],
	edges: [{ from: "entry", to: "check", kind: "chain" }],
	packages: { http: "1.0.0" },
};

describe("编排版本", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
	});
	afterAll(async () => {
		await cp.close();
	});

	it("新建编排后还没有版本", async () => {
		const res = await api.post("/orchestrations", { name: "冒烟" }, "alice");
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: string };
		expect(created).toMatchObject({ name: "冒烟", head_version: 0 });

		const got = await api.get(`/orchestrations/${created.id}`);
		expect(got.status).toBe(200);
		expect(await got.json()).toMatchObject({ id: created.id, name: "冒烟", head_version: 0 });
	});

	it("每次保存生成编号递增、带作者昵称的新版本，旧版本内容不变", async () => {
		const id = await api.createOrchestration("版本测试");

		const v1 = await api.post(
			`/orchestrations/${id}/versions`,
			{ base_version: 0, document: docV1 },
			"alice",
		);
		expect(v1.status).toBe(201);
		expect(await v1.json()).toMatchObject({
			orchestration_id: id,
			number: 1,
			author: "alice",
			created_at: "2026-01-01T00:00:00.000Z",
		});

		const docV2 = { ...docV1, default_agent: "agent-b" };
		const v2 = await api.post(
			`/orchestrations/${id}/versions`,
			{ base_version: 1, document: docV2 },
			"小明",
		);
		expect(await v2.json()).toMatchObject({ number: 2, author: "小明" });

		const head = (await (await api.get(`/orchestrations/${id}`)).json()) as {
			head_version: number;
		};
		expect(head.head_version).toBe(2);

		const old = (await (await api.get(`/orchestrations/${id}/versions/1`)).json()) as {
			number: number;
			author: string;
			document: { default_agent: string };
		};
		expect(old).toMatchObject({ number: 1, author: "alice" });
		expect(old.document.default_agent).toBe("agent-a");

		const latest = (await (await api.get(`/orchestrations/${id}/versions/2`)).json()) as {
			document: { default_agent: string };
		};
		expect(latest.document.default_agent).toBe("agent-b");
	});

	it("编排、编辑起点与保存版本的响应符合接口契约", async () => {
		const id = await api.createOrchestration("契约");
		const initial = orchestrationsApi.head.response.parse(
			await api.getJson(`/orchestrations/${id}/head`),
		);
		expect(initial).toMatchObject({ number: 0, author: null, created_at: null });

		const saved = await api.post(
			`/orchestrations/${id}/versions`,
			{ base_version: 0, document: docV1 },
			"alice",
		);
		expect(saved.status).toBe(201);
		const version = orchestrationsApi.saveVersion.response.parse(await saved.json());
		// 包 http 没有发布：保存成功，但带上包版本的警告。
		expect(version.warnings.map((w) => w.code)).toContain("package_version_missing");

		const head = orchestrationsApi.head.response.parse(
			await api.getJson(`/orchestrations/${id}/head`),
		);
		expect(head).toMatchObject({ number: 1, author: "alice" });
		expect(head.document).toEqual(version.document);
		const got = orchestrationsApi.get.response.parse(await api.getJson(`/orchestrations/${id}`));
		expect(got).toMatchObject({ id, name: "契约", head_version: 1 });

		const missing = await api.get("/orchestrations/not-a-uuid/head");
		expect(missing.status).toBe(404);
	});

	it("编排版本没有修改接口", async () => {
		const id = await api.createOrchestration("不可变");
		await api.saveVersion(id, docV1);
		for (const method of ["PUT", "PATCH"]) {
			const res = await cp.fetch(`/orchestrations/${id}/versions/1`, {
				method,
				headers: { "content-type": "application/json", "x-sfly-nickname": "alice" },
				body: JSON.stringify({ base_version: 0, document: docV1 }),
			});
			expect(res.status).toBe(404);
		}
		const del = await cp.fetch(`/orchestrations/${id}/versions/1`, { method: "DELETE" });
		expect(del.status).toBe(404);
	});

	it("文档格式不对时拒绝保存", async () => {
		const id = await api.createOrchestration("坏文档");
		const res = await api.post(
			`/orchestrations/${id}/versions`,
			{ base_version: 0, document: { nodes: [{ id: "x", kind: "nope" }] } },
			"alice",
		);
		expect(res.status).toBe(400);
		expect(
			((await (await api.get(`/orchestrations/${id}`)).json()) as { head_version: number })
				.head_version,
		).toBe(0);
	});

	it("保存版本必须带昵称", async () => {
		const id = await api.createOrchestration("无昵称");
		const res = await cp.fetch(`/orchestrations/${id}/versions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ base_version: 0, document: docV1 }),
		});
		expect(res.status).toBe(400);
	});

	it("编排列表按新建时间从新到旧排列，带最新版本号", async () => {
		const clock = new ManualClock();
		const local = await startTestControlPlane({ clock });
		try {
			const localApi = new ApiClient(local);
			const older = await localApi.createOrchestration("较早");
			await localApi.saveVersion(older, docV1);
			clock.advance(1000);
			const newer = await localApi.createOrchestration("较新");

			expect(await localApi.getJson("/orchestrations")).toEqual({
				orchestrations: [
					{ id: newer, name: "较新", head_version: 0, created_at: "2026-01-01T00:00:01.000Z" },
					{ id: older, name: "较早", head_version: 1, created_at: "2026-01-01T00:00:00.000Z" },
				],
			});
		} finally {
			await local.close();
		}
	});

	it("新建的编排从一个只有入口节点的文档开始编辑；保存后编辑起点是最新版本", async () => {
		const id = await api.createOrchestration("编辑起点");
		expect(await api.getJson(`/orchestrations/${id}/head`)).toEqual({
			orchestration_id: id,
			number: 0,
			author: null,
			created_at: null,
			document: {
				nodes: [{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } }],
				edges: [],
				packages: {},
			},
		});

		await api.saveVersion(id, docV1, "alice");
		await api.saveVersion(id, { ...docV1, default_agent: "agent-b" }, "bob");
		const head = await api.getJson<{ number: number; author: string; document: unknown }>(
			`/orchestrations/${id}/head`,
		);
		expect(head).toMatchObject({ orchestration_id: id, number: 2, author: "bob" });
		expect(head.document).toMatchObject({ default_agent: "agent-b" });

		expect(
			(await api.get("/orchestrations/00000000-0000-0000-0000-000000000000/head")).status,
		).toBe(404);
	});

	it("可以复制编排并取新名字：新编排的第 1 版是源编排最新版本的内容", async () => {
		const source = await api.createOrchestration("源");
		await api.saveVersion(source, { ...docV1, default_agent: "old" });
		await api.saveVersion(source, docV1);

		const res = await api.post(
			`/orchestrations/${source}/copy`,
			{ name: "源（测试环境 B）" },
			"小红",
		);
		expect(res.status).toBe(201);
		const copy = (await res.json()) as { id: string };
		expect(copy).toMatchObject({ name: "源（测试环境 B）", head_version: 1 });
		expect(copy.id).not.toBe(source);

		const v1 = await api.getJson<{ author: string; document: unknown }>(
			`/orchestrations/${copy.id}/versions/1`,
		);
		expect(v1.author).toBe("小红");
		const sourceHead = await api.getJson<{ document: unknown }>(`/orchestrations/${source}/head`);
		expect(v1.document).toEqual(sourceHead.document);

		// 源编排不受影响。
		expect(await api.getJson(`/orchestrations/${source}`)).toMatchObject({
			name: "源",
			head_version: 2,
		});
	});

	it("新建编排需要昵称", async () => {
		const res = await cp.fetch("/orchestrations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "无昵称" }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "nickname_required" } });
	});

	it("复制还没有版本的编排得到同样没有版本的新编排", async () => {
		const source = await api.createOrchestration("空源");
		const res = await api.post(`/orchestrations/${source}/copy`, { name: "空副本" });
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ name: "空副本", head_version: 0 });
	});

	it("复制编排需要昵称和非空名字，源编排不存在时返回 404", async () => {
		const source = await api.createOrchestration("复制校验");
		const noNick = await cp.fetch(`/orchestrations/${source}/copy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		expect(noNick.status).toBe(400);
		expect(await noNick.json()).toMatchObject({ error: { code: "nickname_required" } });

		const noName = await api.post(`/orchestrations/${source}/copy`, { name: "  " });
		expect(noName.status).toBe(400);
		expect(await noName.json()).toMatchObject({ error: { code: "invalid_request" } });

		const missing = await api.post("/orchestrations/00000000-0000-0000-0000-000000000000/copy", {
			name: "x",
		});
		expect(missing.status).toBe(404);
	});

	it("结构有问题时仍然保存，响应里带结构警告", async () => {
		const id = await api.createOrchestration("画到一半");
		const half = {
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "a", kind: "package", package: "http", node: "check" },
			],
			edges: [],
		};
		const res = await api.post(
			`/orchestrations/${id}/versions`,
			{ base_version: 0, document: half },
			"alice",
		);
		expect(res.status).toBe(201);
		expect(((await res.json()) as { warnings: unknown }).warnings).toEqual([
			{ code: "orphan_node", node_id: "a", message: "节点 a 不在任何链上" },
			{
				code: "missing_agent",
				node_id: "a",
				message: "节点 a 没有选择 Agent，编排也没有默认 Agent",
			},
			{ code: "package_not_locked", node_id: "a", message: "节点 a 的节点包 http 没有锁定版本" },
		]);
		expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ head_version: 1 });

		const published = await cp.fetch(
			"/packages",
			publishInit(
				packageArchive(
					packageMetadata({
						name: "http",
						version: "1.0.0",
						nodes: [{ ...(packageMetadata().nodes as object[])[0], name: "check" }],
					}),
				),
			),
		);
		expect(published.status).toBe(201);
		const ok = await api.post(
			`/orchestrations/${id}/versions`,
			{ base_version: 1, document: docV1 },
			"alice",
		);
		expect(((await ok.json()) as { warnings: unknown }).warnings).toEqual([]);
	});

	it("编排或版本不存在时返回 404", async () => {
		expect((await api.get("/orchestrations/00000000-0000-0000-0000-000000000000")).status).toBe(
			404,
		);
		const id = await api.createOrchestration("空");
		expect((await api.get(`/orchestrations/${id}/versions/1`)).status).toBe(404);
		const res = await api.post(
			"/orchestrations/00000000-0000-0000-0000-000000000000/versions",
			{ base_version: 0, document: docV1 },
			"alice",
		);
		expect(res.status).toBe(404);
	});
});
