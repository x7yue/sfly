import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
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

		const v1 = await api.post(`/orchestrations/${id}/versions`, { document: docV1 }, "alice");
		expect(v1.status).toBe(201);
		expect(await v1.json()).toMatchObject({
			orchestration_id: id,
			number: 1,
			author: "alice",
			created_at: "2026-01-01T00:00:00.000Z",
		});

		const docV2 = { ...docV1, default_agent: "agent-b" };
		const v2 = await api.post(`/orchestrations/${id}/versions`, { document: docV2 }, "小明");
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

	it("编排版本没有修改接口", async () => {
		const id = await api.createOrchestration("不可变");
		await api.saveVersion(id, docV1);
		for (const method of ["PUT", "PATCH"]) {
			const res = await cp.fetch(`/orchestrations/${id}/versions/1`, {
				method,
				headers: { "content-type": "application/json", "x-sfly-nickname": "alice" },
				body: JSON.stringify({ document: docV1 }),
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
			{ document: { nodes: [{ id: "x", kind: "nope" }] } },
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
			body: JSON.stringify({ document: docV1 }),
		});
		expect(res.status).toBe(400);
	});

	it("编排或版本不存在时返回 404", async () => {
		expect((await api.get("/orchestrations/00000000-0000-0000-0000-000000000000")).status).toBe(
			404,
		);
		const id = await api.createOrchestration("空");
		expect((await api.get(`/orchestrations/${id}/versions/1`)).status).toBe(404);
		const res = await api.post(
			"/orchestrations/00000000-0000-0000-0000-000000000000/versions",
			{ document: docV1 },
			"alice",
		);
		expect(res.status).toBe(404);
	});
});
