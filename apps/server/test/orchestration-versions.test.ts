import { orchestrationsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { ManualClock } from "./support/manual-clock.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const doc = (defaultAgent: string) => ({
	default_agent: defaultAgent,
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "check", kind: "package", package: "http", node: "check", inputs: { url: "x" } },
	],
	edges: [{ from: "entry", to: "check", kind: "chain" }],
	packages: { http: "1.0.0" },
});

describe("编排版本：冲突、历史与恢复", () => {
	const clock = new ManualClock();
	let cp: TestControlPlane;
	let api: ApiClient;
	beforeAll(async () => {
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
	});
	afterAll(async () => {
		await cp.close();
	});

	const save = (id: string, body: unknown, nickname = "alice") =>
		api.post(`/orchestrations/${id}/versions`, body, nickname);

	it("base_version 是最新版本时保存成功", async () => {
		const id = await api.createOrchestration("基于最新");
		const first = await save(id, { base_version: 0, document: doc("a") });
		expect(first.status).toBe(201);
		const second = await save(id, { base_version: 1, document: doc("b") });
		expect(second.status).toBe(201);
		expect(await second.json()).toMatchObject({ number: 2 });
	});

	it("别人先保存了新版本时返回 409，给出最新版本的作者和时间，且不生成新版本", async () => {
		const id = await api.createOrchestration("冲突");
		clock.set(new Date("2026-02-01T08:00:00Z"));
		await save(id, { base_version: 0, document: doc("a") }, "alice");
		clock.set(new Date("2026-02-01T09:30:00Z"));
		await save(id, { base_version: 1, document: doc("b") }, "bob");

		// alice 仍基于版本 1 编辑。
		const res = await save(id, { base_version: 1, document: doc("c") }, "alice");
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: {
				code: "version_conflict",
				message: expect.any(String),
				details: {
					base_version: 1,
					head: { number: 2, author: "bob", created_at: "2026-02-01T09:30:00.000Z" },
				},
			},
		});
		expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ head_version: 2 });

		// 新编排还没有版本时，基于“第 1 版”保存同样冲突。
		const fresh = await api.createOrchestration("没有版本");
		const stale = await save(fresh, { base_version: 1, document: doc("a") });
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({
			error: { code: "version_conflict", details: { base_version: 1, head: null } },
		});
	});

	it("两个人基于同一版本同时保存时只有一个成功", async () => {
		const id = await api.createOrchestration("并发");
		await save(id, { base_version: 0, document: doc("a") });
		const results = await Promise.all(
			["alice", "bob", "carol"].map((who) =>
				save(id, { base_version: 1, document: doc(who) }, who),
			),
		);
		expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
		expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ head_version: 2 });
	});

	it("版本历史按版本号从新到旧列出版本号、作者和时间", async () => {
		const id = await api.createOrchestration("历史");
		expect(await api.getJson(`/orchestrations/${id}/versions`)).toEqual({ versions: [] });

		clock.set(new Date("2026-03-01T00:00:00Z"));
		await save(id, { base_version: 0, document: doc("a") }, "alice");
		clock.set(new Date("2026-03-02T00:00:00Z"));
		await save(id, { base_version: 1, document: doc("b") }, "小明");

		const history = await api.getJson(`/orchestrations/${id}/versions`);
		expect(orchestrationsApi.versions.response.parse(history)).toEqual(history);
		expect(history).toEqual({
			versions: [
				{ number: 2, author: "小明", created_at: "2026-03-02T00:00:00.000Z" },
				{ number: 1, author: "alice", created_at: "2026-03-01T00:00:00.000Z" },
			],
		});
		expect(
			(await api.get("/orchestrations/00000000-0000-0000-0000-000000000000/versions")).status,
		).toBe(404);
	});

	it("恢复历史版本：用旧内容生成一个新版本，历史不变", async () => {
		const id = await api.createOrchestration("恢复");
		clock.set(new Date("2026-04-01T00:00:00Z"));
		await save(id, { base_version: 0, document: doc("a") }, "alice");
		await save(id, { base_version: 1, document: doc("b") }, "bob");
		const v1 = await api.getJson<{ document: unknown }>(`/orchestrations/${id}/versions/1`);
		const v2 = await api.getJson<{ document: unknown }>(`/orchestrations/${id}/versions/2`);

		clock.set(new Date("2026-04-02T00:00:00Z"));
		const res = await api.post(`/orchestrations/${id}/versions/1/restore`, {}, "carol");
		expect(res.status).toBe(201);
		const restored = (await res.json()) as { document: unknown };
		expect(restored).toMatchObject({
			orchestration_id: id,
			number: 3,
			author: "carol",
			created_at: "2026-04-02T00:00:00.000Z",
			// 恢复与保存返回同一套静态检查（#8）：这里引用的节点包没有发布过。
			warnings: [expect.objectContaining({ code: "package_version_missing", node_id: "check" })],
		});
		expect(restored.document).toEqual(v1.document);
		expect(orchestrationsApi.restoreVersion.response.parse(restored)).toEqual(restored);
		expect(orchestrationsApi.version.response.parse(v1)).toEqual(v1);

		// 历史版本保持原样，最新版本变为恢复出的版本 3。
		expect(await api.getJson(`/orchestrations/${id}/versions/1`)).toEqual(v1);
		expect(await api.getJson(`/orchestrations/${id}/versions/2`)).toEqual(v2);
		const head = await api.getJson<{ number: number; document: unknown }>(
			`/orchestrations/${id}/head`,
		);
		expect(head.number).toBe(3);
		expect(head.document).toEqual(v1.document);
		expect(
			(await api.getJson<{ versions: unknown[] }>(`/orchestrations/${id}/versions`)).versions,
		).toHaveLength(3);

		// 恢复后，基于版本 2 的保存会冲突。
		const stale = await save(id, { base_version: 2, document: doc("c") }, "bob");
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({
			error: { details: { head: { number: 3, author: "carol" } } },
		});
	});

	it("恢复需要昵称；版本不存在时返回 404", async () => {
		const id = await api.createOrchestration("恢复校验");
		await save(id, { base_version: 0, document: doc("a") });
		const noNick = await cp.fetch(`/orchestrations/${id}/versions/1/restore`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(noNick.status).toBe(400);
		expect(await noNick.json()).toMatchObject({ error: { code: "nickname_required" } });

		for (const path of [
			`/orchestrations/${id}/versions/9/restore`,
			`/orchestrations/${id}/versions/x/restore`,
			"/orchestrations/00000000-0000-0000-0000-000000000000/versions/1/restore",
		]) {
			expect((await api.post(path, {})).status, path).toBe(404);
		}
		expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ head_version: 1 });
	});

	it("缺少 base_version 时拒绝保存（400），不生成版本", async () => {
		const id = await api.createOrchestration("无基线");
		const res = await save(id, { document: doc("a") });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "base_version_required" } });
		expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ head_version: 0 });
	});

	it("base_version 不是非负整数时拒绝保存", async () => {
		const id = await api.createOrchestration("坏基线");
		const res = await save(id, { base_version: -1, document: doc("a") });
		expect(res.status).toBe(400);
	});
});
