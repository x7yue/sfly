// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
// 切入点 A：删除飞书机器人之前列出引用它的场景（#229，ADR 0020）。真实控制面 + 真实 PostgreSQL。
import { feishuBotsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const notify = (id: string, bot: string | undefined) => ({
	id,
	kind: "feishu_notify",
	...(bot === undefined ? {} : { bot }),
	text: id,
});

/** 入口 + 若干飞书通知节点串成的单链。 */
const flow = (nodes: Array<Record<string, unknown>>, params: unknown[] = []) => {
	const all = [{ id: "entry", kind: "entry", params }, ...nodes];
	return {
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: {},
	};
};

describe("删除飞书机器人之前列出引用它的场景", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		await api.createFeishuBot("ops", "http://127.0.0.1:9/hook/a");
		await api.createFeishuBot("dev", "http://127.0.0.1:9/hook/b");
	});
	afterEach(async () => {
		await cp.close();
	});

	const references = async (bot: string) =>
		feishuBotsApi.references.response.parse(
			await api.getJson(`/feishu-bots/${encodeURIComponent(bot)}/references`),
		).scenarios;

	it("列出最新场景版本里选了这个机器人的飞书通知节点所在的场景，按场景名排序，每个场景列出各个节点", async () => {
		await api.orchestrationWith(flow([notify("n1", "ops"), notify("n2", "dev")]), "scenario-b");
		await api.orchestrationWith(flow([notify("a", "ops"), notify("b", "ops")]), "scenario-a");
		await api.orchestrationWith(flow([notify("only-dev", "dev")]), "scenario-c");

		const found = await references("ops");
		expect(found.map((s) => s.name)).toEqual(["scenario-a", "scenario-b"]);
		expect(found.find((s) => s.name === "scenario-a")?.references).toEqual([
			{ kind: "feishu_notify_node", node_id: "a" },
			{ kind: "feishu_notify_node", node_id: "b" },
		]);
		expect(found.find((s) => s.name === "scenario-b")?.references).toEqual([
			{ kind: "feishu_notify_node", node_id: "n1" },
		]);
		expect((await references("dev")).map((s) => s.name)).toEqual(["scenario-b", "scenario-c"]);
	});

	it("只看最新版本：旧版本里引用过、现在不引用的场景不列", async () => {
		const id = await api.orchestrationWith(flow([notify("n", "ops")]), "场景");
		expect(await references("ops")).toHaveLength(1);
		await api.saveVersion(id, flow([notify("n", "dev")]));
		expect(await references("ops")).toEqual([]);
		expect(await references("dev")).toHaveLength(1);
	});

	it("引用入口参数的机器人、没有选择机器人的节点、已归档的场景都不列", async () => {
		await api.orchestrationWith(
			flow([notify("n", "${{ params.channel }}")], [{ name: "channel", type: "string" }]),
			"引用参数",
		);
		await api.orchestrationWith(flow([notify("n", undefined)]), "没选");
		const archived = await api.orchestrationWith(flow([notify("n", "ops")]), "已归档");
		expect((await api.post(`/orchestrations/${archived}/archive`, {})).status).toBe(200);

		expect(await references("ops")).toEqual([]);
	});

	it("场景的运行通知设置选了这个机器人的也列出来：没有版本的场景也在，和节点引用在同一个场景下一起列，已归档的不列", async () => {
		const bare = await api.createOrchestration("只有运行通知");
		await api.patch(`/orchestrations/${bare}`, { run_notification: { bot: "ops" } });
		const both = await api.orchestrationWith(flow([notify("n", "ops")]), "节点加运行通知");
		await api.patch(`/orchestrations/${both}`, { run_notification: { bot: "ops" } });
		const other = await api.createOrchestration("选了别的机器人");
		await api.patch(`/orchestrations/${other}`, { run_notification: { bot: "dev" } });
		await api.createOrchestration("没开运行通知");
		const archived = await api.createOrchestration("已归档");
		await api.patch(`/orchestrations/${archived}`, { run_notification: { bot: "ops" } });
		expect((await api.post(`/orchestrations/${archived}/archive`, {})).status).toBe(200);

		const found = await references("ops");
		expect(found.map((s) => s.name)).toEqual(["只有运行通知", "节点加运行通知"]);
		expect(found.find((s) => s.name === "只有运行通知")?.references).toEqual([
			{ kind: "run_notification" },
		]);
		expect(found.find((s) => s.name === "节点加运行通知")?.references).toEqual([
			{ kind: "feishu_notify_node", node_id: "n" },
			{ kind: "run_notification" },
		]);
		expect((await references("dev")).map((s) => s.name)).toEqual(["选了别的机器人"]);
	});

	it("没有场景引用时是空列表；机器人不存在时 404", async () => {
		expect(await references("ops")).toEqual([]);
		const res = await api.get("/feishu-bots/ghost/references");
		expect(res.status).toBe(404);
	});

	it("引用不拦截删除：删除后场景里的节点保持原样，保存警告指出机器人没有登记", async () => {
		const id = await api.orchestrationWith(flow([notify("n", "ops")]), "场景");
		const res = await cp.fetch("/feishu-bots/ops", {
			method: "DELETE",
			headers: { "x-sfly-nickname": "tester" },
		});
		expect(res.status).toBe(204);
		expect((await api.trigger(id)).status).toBe(400);
	});
});
