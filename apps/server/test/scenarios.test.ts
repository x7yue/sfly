// 切入点 A：场景的说明、改名、归档与恢复，以及场景列表（卡片数据、搜索与筛选）。
import { orchestrationsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 入口 → a → b，b 另选 Agent；a 是异步任务节点，调度一个两节点的子流程。 */
const withSubflow = (defaultAgent: string, other: string) => ({
	default_agent: defaultAgent,
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "async" },
		{ id: "b", kind: "package", package: "stub", node: "echo", agent: other },
		{ id: "sub", kind: "subflow_entry" },
		{ id: "s1", kind: "package", package: "stub", node: "echo" },
	],
	edges: [
		{ from: "entry", to: "a", kind: "chain" },
		{ from: "a", to: "b", kind: "chain" },
		{ from: "a", to: "sub", kind: "dispatch" },
		{ from: "sub", to: "s1", kind: "chain" },
	],
	packages: { stub: "1.0.0" },
});

/** 入口 → echo 的单链。 */
const single = (agent: string, node = "one") => ({
	default_agent: agent,
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: node, kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: node, kind: "chain" }],
	packages: { stub: "1.0.0" },
});

describe("场景", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;
	const agents: FakeAgent[] = [];
	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};
	const patch = (path: string, body: unknown, nickname = "tester") =>
		cp.fetch(path, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				"x-sfly-nickname": encodeURIComponent(nickname),
			},
			body: JSON.stringify(body),
		});
	const list = async (query = "") => {
		const body = await api.getJson(`/orchestrations${query}`);
		return orchestrationsApi.list.response.parse(body);
	};

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	describe("说明与改名", () => {
		it("新建时可以写说明；不写时说明为空", async () => {
			const res = await api.post("/orchestrations", { name: "日终", description: "每日 18:00" });
			expect(res.status).toBe(201);
			expect(await res.json()).toMatchObject({
				name: "日终",
				description: "每日 18:00",
				archived_at: null,
			});
			const id = await api.createOrchestration("无说明");
			expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ description: "" });
		});

		it("名称和说明可以修改，不产生新的场景版本", async () => {
			const id = await api.orchestrationWith(single("agent-a"), "旧名");
			const res = await patch(`/orchestrations/${id}`, { name: "新名", description: "新的说明" });
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				id,
				name: "新名",
				description: "新的说明",
				head_version: 1,
			});
			// 只改说明时名称不变。
			await patch(`/orchestrations/${id}`, { description: "" });
			expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({
				name: "新名",
				description: "",
				head_version: 1,
			});
			expect(
				(await api.getJson<{ versions: unknown[] }>(`/orchestrations/${id}/versions`)).versions,
			).toHaveLength(1);
		});

		it("修改需要昵称、非空名称，场景不存在时返回 404", async () => {
			const id = await api.createOrchestration("校验");
			const noNick = await cp.fetch(`/orchestrations/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "x" }),
			});
			expect(noNick.status).toBe(400);
			expect(await noNick.json()).toMatchObject({ error: { code: "nickname_required" } });
			const blank = await patch(`/orchestrations/${id}`, { name: "  " });
			expect(blank.status).toBe(400);
			expect(await blank.json()).toMatchObject({ error: { code: "invalid_request" } });
			expect(
				(await patch("/orchestrations/00000000-0000-0000-0000-000000000000", { name: "x" })).status,
			).toBe(404);
		});

		it("复制场景时带上说明", async () => {
			const res = await api.post("/orchestrations", { name: "源", description: "说明" });
			const { id } = (await res.json()) as { id: string };
			const copy = await api.post(`/orchestrations/${id}/copy`, { name: "副本" });
			expect(await copy.json()).toMatchObject({ name: "副本", description: "说明" });
		});
	});

	describe("归档与恢复", () => {
		it("归档后不出现在默认列表、不能触发；只看已归档时出现；恢复后回到默认列表", async () => {
			await (await connect({ name: "agent-a" })).disconnect();
			const kept = await api.orchestrationWith(single("agent-a"), "保留");
			const archived = await api.orchestrationWith(single("agent-a"), "归档");

			clock.advance(5_000);
			const res = await api.post(`/orchestrations/${archived}/archive`, {});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				id: archived,
				archived_at: "2026-01-01T00:00:05.000Z",
			});

			const active = await list();
			expect(active.orchestrations.map((o) => o.id)).toEqual([kept]);
			expect(active.archived_count).toBe(1);
			const onlyArchived = await list("?archived=true");
			expect(onlyArchived.orchestrations.map((o) => o.name)).toEqual(["归档"]);

			const trigger = await api.trigger(archived);
			expect(trigger.status).toBe(409);
			expect(await trigger.json()).toMatchObject({ error: { code: "archived" } });
			expect(await api.getJson(`/orchestrations/${archived}/preflight`)).toMatchObject({
				problems: [{ code: "archived" }],
			});

			const restored = await api.post(`/orchestrations/${archived}/unarchive`, {});
			expect(restored.status).toBe(200);
			expect(await restored.json()).toMatchObject({ archived_at: null });
			expect((await list()).orchestrations.map((o) => o.name).sort()).toEqual(["保留", "归档"]);
			expect((await list()).archived_count).toBe(0);
			expect((await api.trigger(archived)).status).toBe(201);
		});

		it("归档后历史运行照常可以回看", async () => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(single("agent-a"));
			const runId = await api.triggerOk(id);
			const task = await agent.nextAssign();
			await agent.succeed(task);
			await api.post(`/orchestrations/${id}/archive`, {});

			expect(await api.run(runId)).toMatchObject({ id: runId, status: "success" });
			expect(
				(await api.getJson<{ runs: { id: string }[] }>(`/orchestrations/${id}/runs`)).runs,
			).toMatchObject([{ id: runId }]);
			expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ id });
		});

		it("有运行中的运行时拒绝归档并给出原因", async () => {
			await connect({ name: "agent-a" });
			const id = await api.orchestrationWith(single("agent-a"));
			await api.triggerOk(id);

			const res = await api.post(`/orchestrations/${id}/archive`, {});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { error: { code: string; message: string } };
			expect(body.error.code).toBe("run_in_progress");
			expect(body.error.message).toContain("1 个运行中的运行");
			expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ archived_at: null });
		});

		it("归档与恢复需要昵称；场景不存在时返回 404；不提供物理删除", async () => {
			const id = await api.createOrchestration("x");
			const noNick = await cp.fetch(`/orchestrations/${id}/archive`, { method: "POST" });
			expect(noNick.status).toBe(400);
			expect(
				(await api.post("/orchestrations/00000000-0000-0000-0000-000000000000/archive", {})).status,
			).toBe(404);
			expect(
				(await api.post("/orchestrations/00000000-0000-0000-0000-000000000000/unarchive", {}))
					.status,
			).toBe(404);
			const del = await cp.fetch(`/orchestrations/${id}`, {
				method: "DELETE",
				headers: { "x-sfly-nickname": "tester" },
			});
			expect(del.status).toBe(404);
			expect(await api.getJson(`/orchestrations/${id}`)).toMatchObject({ id });
		});
	});

	describe("场景列表", () => {
		it("返回卡片所需的数据：说明、版本、节点与子流程数、结构、引用的 Agent 与在线状态", async () => {
			await connect({ name: "agent-a" });
			await (await connect({ name: "agent-b" })).disconnect();
			const res = await api.post("/orchestrations", { name: "压测", description: "高并发下单" });
			const { id } = (await res.json()) as { id: string };
			clock.advance(60_000);
			await api.saveVersion(id, withSubflow("agent-a", "agent-b"));

			const [item] = (await list()).orchestrations;
			expect(item).toEqual({
				id,
				name: "压测",
				description: "高并发下单",
				head_version: 1,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:01:00.000Z",
				archived_at: null,
				node_count: 5,
				subflow_count: 1,
				structure: {
					nodes: [
						{ id: "entry", kind: "entry" },
						{ id: "a", kind: "async" },
						{ id: "b", kind: "package" },
						{ id: "sub", kind: "subflow_entry" },
						{ id: "s1", kind: "package" },
					],
					edges: [
						{ from: "entry", to: "a", kind: "chain" },
						{ from: "a", to: "b", kind: "chain" },
						{ from: "a", to: "sub", kind: "dispatch" },
						{ from: "sub", to: "s1", kind: "chain" },
					],
				},
				default_agent: "agent-a",
				agents: [
					{ name: "agent-a", default: true, status: "online" },
					{ name: "agent-b", default: false, status: "offline" },
				],
				last_run: null,
			});
		});

		it("还没有版本的新场景只有入口节点；未注册的 Agent 状态为 unknown", async () => {
			const fresh = await api.createOrchestration("新场景");
			const [item] = (await list()).orchestrations;
			expect(item).toMatchObject({
				id: fresh,
				head_version: 0,
				updated_at: "2026-01-01T00:00:00.000Z",
				node_count: 1,
				subflow_count: 0,
				structure: { nodes: [{ id: "entry", kind: "entry" }], edges: [] },
				default_agent: null,
				agents: [],
			});

			await api.saveVersion(fresh, single("nobody"));
			expect((await list()).orchestrations[0]?.agents).toEqual([
				{ name: "nobody", default: true, status: "unknown" },
			]);
		});

		it("带最近一次运行的状态与各节点状态", async () => {
			const agent = await connect({ name: "agent-a" });
			const id = await api.orchestrationWith({
				default_agent: "agent-a",
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "one", kind: "package", package: "stub", node: "echo" },
					{ id: "two", kind: "package", package: "stub", node: "echo" },
				],
				edges: [
					{ from: "entry", to: "one", kind: "chain" },
					{ from: "one", to: "two", kind: "chain" },
				],
				packages: { stub: "1.0.0" },
			});
			const first = await api.triggerOk(id);
			await agent.fail(await agent.nextAssign());
			expect((await api.run(first)).status).toBe("failed");

			clock.advance(1_000);
			const second = await api.triggerOk(id);
			await agent.nextAssign();

			const [item] = (await list()).orchestrations;
			expect(item?.last_run).toEqual({
				id: second,
				status: "running",
				cancelling: false,
				version: 1,
				triggered_by: "tester",
				started_at: "2026-01-01T00:00:01.000Z",
				ended_at: null,
				node_states: { entry: "success", one: "running", two: "pending" },
			});

			// 取消后等待任务结束的运行标为取消中（不显示成「运行中」）。
			await api.cancelOk(second);
			expect((await list()).orchestrations[0]?.last_run).toMatchObject({
				status: "running",
				cancelling: true,
			});
		});

		it("按名称、说明或 Agent 搜索；按最近运行状态和 Agent 筛选", async () => {
			const agent = await connect({ name: "agent-a" });
			await (await connect({ name: "agent-b" })).disconnect();
			const daily = (
				(await (
					await api.post("/orchestrations", { name: "日终数据处理", description: "每日跑批" })
				).json()) as { id: string }
			).id;
			await api.saveVersion(daily, single("agent-a"));
			const stress = await api.orchestrationWith(single("agent-b"), "撮合压测");
			const idle = await api.orchestrationWith(withSubflow("agent-a", "agent-b"), "巡检");

			await api.triggerOk(daily);
			await agent.succeed(await agent.nextAssign());
			await api.triggerOk(stress);

			const names = async (query: string) =>
				(await list(query)).orchestrations.map((o) => o.name).sort();
			expect(await names("?q=跑批")).toEqual(["日终数据处理"]);
			expect(await names("?q=压测")).toEqual(["撮合压测"]);
			expect(await names("?q=AGENT-B")).toEqual(["巡检", "撮合压测"]);
			expect(await names("?status=success")).toEqual(["日终数据处理"]);
			expect(await names("?status=running")).toEqual(["撮合压测"]);
			expect(await names("?status=failed")).toEqual([]);
			expect(await names("?agent=agent-a")).toEqual(["巡检", "日终数据处理"]);
			expect(await names("?agent=agent-a&status=success")).toEqual(["日终数据处理"]);
			expect(await names("?q=巡检&archived=true")).toEqual([]);
			expect(idle).toBeTruthy();

			const bad = await api.get("/orchestrations?status=nope");
			expect(bad.status).toBe(400);
		});
	});
});
