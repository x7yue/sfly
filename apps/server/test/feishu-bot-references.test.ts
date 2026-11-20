// 切入点 A：删除飞书机器人之前列出引用它的场景（#229，ADR 0020）。真实控制面 + 真实 PostgreSQL。
// 场景里引用机器人的地方有两种：节点的「飞书机器人」类型的输入（#233）和场景设置里的运行通知。
// 「飞书机器人」类型的输入的细节（只看最新版本、引用入口参数、没有填写、已归档、引用不拦截删除）见 feishu-bot-inputs.test.ts，
// 这里只看列表的组织：按场景名排序、每个场景列出各个引用、各种引用在同一个场景下一起列。
import { feishuBotsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** alert(bot: FeishuBot)：sfly build 生成的元信息。 */
const metadata = packageMetadata({
	name: "alerts",
	version: "1.0.0",
	nodes: [
		{
			name: "alert",
			title: "告警",
			entry: "alerts:alert",
			inputs: {
				type: "object",
				properties: { bot: { type: "string", "x-sfly-type": "feishu_bot" } },
				required: ["bot"],
				order: ["bot"],
			},
			outputs: { type: "object", properties: {} },
		},
	],
});

/** 选了这个机器人的 alert 节点。 */
const alert = (id: string, bot: string) => ({
	id,
	kind: "package",
	package: "alerts",
	node: "alert",
	inputs: { bot },
});

/** 入口 + 若干 alert 节点串成的单链。 */
const flow = (nodes: Array<Record<string, unknown>>) => {
	const all = [{ id: "entry", kind: "entry", params: [] }, ...nodes];
	return {
		default_agent: "runner",
		nodes: all,
		edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		packages: { alerts: "1.0.0" },
	};
};

describe("删除飞书机器人之前列出引用它的场景", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
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

	it("列出最新场景版本里选了这个机器人的节点所在的场景，按场景名排序，每个场景列出各个节点的输入", async () => {
		await api.orchestrationWith(flow([alert("n1", "ops"), alert("n2", "dev")]), "scenario-b");
		await api.orchestrationWith(flow([alert("a", "ops"), alert("b", "ops")]), "scenario-a");
		await api.orchestrationWith(flow([alert("only-dev", "dev")]), "scenario-c");

		const found = await references("ops");
		expect(found.map((s) => s.name)).toEqual(["scenario-a", "scenario-b"]);
		expect(found.find((s) => s.name === "scenario-a")?.references).toEqual([
			{ kind: "feishu_bot_input", node_id: "a", input: "bot" },
			{ kind: "feishu_bot_input", node_id: "b", input: "bot" },
		]);
		expect(found.find((s) => s.name === "scenario-b")?.references).toEqual([
			{ kind: "feishu_bot_input", node_id: "n1", input: "bot" },
		]);
		expect((await references("dev")).map((s) => s.name)).toEqual(["scenario-b", "scenario-c"]);
	});

	it("场景的运行通知设置选了这个机器人的也列出来：没有版本的场景也在，和节点的引用在同一个场景下一起列，已归档的不列", async () => {
		const bare = await api.createOrchestration("只有运行通知");
		await api.patch(`/orchestrations/${bare}`, { run_notification: { bot: "ops" } });
		const both = await api.orchestrationWith(flow([alert("n", "ops")]), "节点加运行通知");
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
			{ kind: "feishu_bot_input", node_id: "n", input: "bot" },
			{ kind: "run_notification" },
		]);
		expect((await references("dev")).map((s) => s.name)).toEqual(["选了别的机器人"]);
	});

	it("没有场景引用时是空列表；机器人不存在时 404", async () => {
		expect(await references("ops")).toEqual([]);
		const res = await api.get("/feishu-bots/ghost/references");
		expect(res.status).toBe(404);
	});
});
