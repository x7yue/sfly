// 「飞书机器人」类型的输入（#233，ADR 0020）：节点开发者用 sfly.FeishuBot 标注的参数，值是飞书机器人的名称。
// 常量必须是已登记的机器人（保存时警告，触发时阻断，指出节点和参数）；引用入口参数时触发时按实际值检查
// （子流程里经异步任务节点传入的也一样）。派发时控制面把任务引用的机器人名单随任务下发，节点收到的参数值仍是名称。
// 删除机器人之前列出的引用包含这种参数的常量值。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { feishuBotsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** alert(bot: FeishuBot, backup: FeishuBot | None = None, text: str = "")、pick()：sfly build 生成的元信息。 */
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
				properties: {
					bot: { type: "string", "x-sfly-type": "feishu_bot" },
					backup: {
						anyOf: [{ type: "string", "x-sfly-type": "feishu_bot" }, { type: "null" }],
						default: null,
					},
					text: { type: "string", default: "" },
				},
				required: ["bot"],
				order: ["bot", "backup", "text"],
			},
			outputs: { type: "object", properties: {} },
		},
		{
			name: "pick",
			title: "选择",
			entry: "alerts:pick",
			inputs: { type: "object", properties: {} },
			outputs: { type: "object", properties: { bot: { type: "string" } } },
		},
	],
});

interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

const document = (inputs: Record<string, unknown>, extra: { pick?: boolean } = {}) => ({
	default_agent: "runner",
	nodes: [
		{ id: "entry", kind: "entry", params: [{ name: "channel", type: "string" }] },
		...(extra.pick
			? [{ id: "pick", kind: "package", package: "alerts", node: "pick", inputs: {} }]
			: []),
		{ id: "a", kind: "package", package: "alerts", node: "alert", inputs },
	],
	edges: extra.pick
		? [
				{ from: "entry", to: "pick", kind: "chain" },
				{ from: "pick", to: "a", kind: "chain" },
			]
		: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { alerts: "1.0.0" },
});

describe("「飞书机器人」类型的输入", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let runner: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		runner = await FakeAgent.connect(cp.grpcUrl, { name: "runner" });
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
		await api.createFeishuBot("ops", "http://127.0.0.1:9/hook/ops");
		await api.createFeishuBot("dev", "http://127.0.0.1:9/hook/dev");
	});

	afterEach(async () => {
		await runner.disconnect();
		await cp.close();
	});

	const save = async (doc: unknown) => {
		const id = await api.createOrchestration("t");
		const res = await api.post(`/orchestrations/${id}/versions`, {
			base_version: 0,
			document: doc,
		});
		expect(res.status).toBe(201);
		const { warnings } = (await res.json()) as { warnings: Problem[] };
		return { id, warnings: warnings.filter((w) => w.code.startsWith("feishu_")) };
	};
	const preflight = async (id: string) =>
		(await api.getJson<{ problems: Problem[] }>(`/orchestrations/${id}/preflight`)).problems;

	it("常量不是已登记的机器人：保存时警告，预检阻断并指出节点和参数，不能触发", async () => {
		const { id, warnings } = await save(document({ bot: "ghost" }));

		const message = "节点 a 的输入 bot 选择的飞书机器人「ghost」还没有登记";
		expect(warnings).toEqual([
			{ code: "feishu_bot_not_registered", message, node_id: "a", input: "bot" },
		]);
		expect(await preflight(id)).toEqual([
			{ code: "feishu_bot_not_registered", message, node_id: "a" },
		]);
		const res = await api.trigger(id);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message);
		await runner.expectNoAssign();
	});

	it("已登记的机器人不警告、不阻断：派发的任务带有被引用的机器人名单，节点收到的值是名称", async () => {
		const { id, warnings } = await save(document({ bot: "ops", text: "ghost" }));

		expect(warnings).toEqual([]);
		expect(await preflight(id)).toEqual([]);
		await api.triggerOk(id);
		const assign = await runner.nextAssign();
		expect(assign.inputs).toEqual({ bot: "ops", text: "ghost" });
		expect(assign.referencedFeishuBots).toEqual(["ops"]);
	});

	it("引用入口参数时，触发时按实际值检查", async () => {
		const { id, warnings } = await save(document({ bot: "${{ params.channel }}" }));
		expect(warnings).toEqual([]);
		expect(await preflight(id)).toEqual([]);

		const rejected = await api.trigger(id, { channel: "ghost" });
		expect(rejected.status).toBe(400);
		expect(((await rejected.json()) as { error: unknown }).error).toMatchObject({
			code: "invalid_params",
			message: "节点 a 的输入 bot 选择的飞书机器人「ghost」还没有登记（取自入口参数）",
			details: [{ code: "feishu_bot_not_registered", node_id: "a" }],
		});
		await runner.expectNoAssign();

		await api.triggerOk(id, { channel: "dev" });
		const assign = await runner.nextAssign();
		expect(assign.inputs).toEqual({ bot: "dev" });
		expect(assign.referencedFeishuBots).toEqual(["dev"]);
	});

	it("子流程里引用入口参数的也在触发时按实际值检查：经异步任务节点的参数映射传入", async () => {
		const doc = {
			default_agent: "runner",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "channel", type: "string" }] },
				{ id: "spawn", kind: "async", params: { bot: "${{ params.channel }}" } },
				{ id: "sub", kind: "subflow_entry", params: [{ name: "bot", type: "string" }] },
				{
					id: "a",
					kind: "package",
					package: "alerts",
					node: "alert",
					inputs: { bot: "${{ params.bot }}" },
				},
			],
			edges: [
				{ from: "entry", to: "spawn", kind: "chain" },
				{ from: "spawn", to: "sub", kind: "dispatch" },
				{ from: "sub", to: "a", kind: "chain" },
			],
			packages: { alerts: "1.0.0" },
		};
		const { id, warnings } = await save(doc);
		expect(warnings).toEqual([]);

		const rejected = await api.trigger(id, { channel: "ghost" });
		expect(rejected.status).toBe(400);
		expect(((await rejected.json()) as { error: unknown }).error).toMatchObject({
			code: "invalid_params",
			message:
				"节点 a 的输入 bot 选择的飞书机器人「ghost」还没有登记（取自子流程的参数，由异步任务节点 spawn 传入）",
			details: [{ code: "feishu_bot_not_registered", node_id: "a" }],
		});
		await runner.expectNoAssign();

		await api.triggerOk(id, { channel: "ops" });
		expect(await runner.nextAssign()).toMatchObject({ nodeId: "a", inputs: { bot: "ops" } });
	});

	it("名单里每个机器人只有一项，按参数顺序；没有填写的可选参数不在里面", async () => {
		const { id } = await save(document({ bot: "ops", backup: "ops" }));
		await api.triggerOk(id);
		const same = await runner.nextAssign();
		expect(same.referencedFeishuBots).toEqual(["ops"]);
		await runner.succeed(same, {});

		const { id: both } = await save(document({ bot: "dev", backup: "ops" }));
		await api.triggerOk(both);
		expect((await runner.nextAssign()).referencedFeishuBots).toEqual(["dev", "ops"]);
	});

	it("没有「飞书机器人」类型的输入的任务带的名单是空的", async () => {
		const { id } = await save(document({ bot: "ops" }, { pick: true }));
		await api.triggerOk(id);
		const pick = await runner.nextAssign();
		expect(pick.referencedFeishuBots).toEqual([]);
		await runner.succeed(pick, { bot: "dev" });
		expect((await runner.nextAssign()).referencedFeishuBots).toEqual(["ops"]);
	});

	it("值来自前面节点的输出时派发时不检查：机器人没有登记也照常派发，通知不会成为任务失败的原因", async () => {
		const { id, warnings } = await save(
			document({ bot: "${{ nodes.pick.outputs.bot }}" }, { pick: true }),
		);
		expect(warnings).toEqual([]);

		const runId = await api.triggerOk(id);
		await runner.succeed(await runner.nextAssign(), { bot: "ghost" });

		const assign = await runner.nextAssign();
		expect(assign.inputs).toEqual({ bot: "ghost" });
		expect(assign.referencedFeishuBots).toEqual(["ghost"]);
		await eventually(async () => {
			expect((await api.node(runId, "a")).status).toBe("running");
		});
	});
});

describe("删除飞书机器人之前列出「飞书机器人」类型的输入的常量值", () => {
	let cp: TestControlPlane;
	let api: ApiClient;

	beforeEach(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
		await api.createFeishuBot("ops", "http://127.0.0.1:9/hook/ops");
		await api.createFeishuBot("dev", "http://127.0.0.1:9/hook/dev");
	});

	afterEach(async () => {
		await cp.close();
	});

	const references = async (bot: string) =>
		feishuBotsApi.references.response.parse(
			await api.getJson(`/feishu-bots/${encodeURIComponent(bot)}/references`),
		).scenarios;

	const alertNode = (id: string, inputs: Record<string, unknown>) => ({
		id,
		kind: "package",
		package: "alerts",
		node: "alert",
		inputs,
	});
	const flow = (nodes: Array<Record<string, unknown>>) => {
		const all = [
			{ id: "entry", kind: "entry", params: [{ name: "channel", type: "string" }] },
			...nodes,
		];
		return {
			default_agent: "runner",
			nodes: all,
			edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
			packages: { alerts: "1.0.0" },
		};
	};

	it("列出最新场景版本里常量值是这个机器人的参数，指出节点和参数，和飞书通知节点一起按场景列", async () => {
		await api.orchestrationWith(
			flow([
				alertNode("a1", { bot: "ops", backup: "dev" }),
				alertNode("a2", { bot: "dev" }),
				{ id: "n", kind: "feishu_notify", bot: "ops", text: "x" },
			]),
			"scenario-a",
		);
		await api.orchestrationWith(flow([alertNode("b1", { bot: "dev" })]), "scenario-b");

		const ops = await references("ops");
		expect(ops.map((s) => s.name)).toEqual(["scenario-a"]);
		expect(ops[0]?.references).toEqual(
			expect.arrayContaining([
				{ kind: "feishu_bot_input", node_id: "a1", input: "bot" },
				{ kind: "feishu_notify_node", node_id: "n" },
			]),
		);
		expect(ops[0]?.references).toHaveLength(2);

		const dev = await references("dev");
		expect(dev.map((s) => s.name)).toEqual(["scenario-a", "scenario-b"]);
		expect(dev[0]?.references).toEqual([
			{ kind: "feishu_bot_input", node_id: "a1", input: "backup" },
			{ kind: "feishu_bot_input", node_id: "a2", input: "bot" },
		]);
		expect(dev[1]?.references).toEqual([{ kind: "feishu_bot_input", node_id: "b1", input: "bot" }]);
	});

	it("只看最新版本；引用入口参数的、没有填写的、其他输入里同名的值、已归档的场景都不列", async () => {
		const old = await api.orchestrationWith(flow([alertNode("a", { bot: "ops" })]), "scenario-old");
		await api.saveVersion(old, flow([alertNode("a", { bot: "dev" })]));
		await api.orchestrationWith(
			flow([alertNode("a", { bot: "${{ params.channel }}" })]),
			"scenario-param",
		);
		await api.orchestrationWith(
			flow([alertNode("a", { bot: "dev", text: "ops" })]),
			"scenario-text",
		);
		const archived = await api.orchestrationWith(
			flow([alertNode("a", { bot: "ops" })]),
			"scenario-archived",
		);
		expect((await api.post(`/orchestrations/${archived}/archive`, {})).status).toBe(200);

		expect(await references("ops")).toEqual([]);
		expect((await references("dev")).map((s) => s.name)).toEqual(["scenario-old", "scenario-text"]);
	});

	it("引用不拦截删除：删除后保存警告和预检指出机器人没有登记", async () => {
		const id = await api.orchestrationWith(flow([alertNode("a", { bot: "ops" })]), "scenario");
		const res = await cp.fetch("/feishu-bots/ops", {
			method: "DELETE",
			headers: { "x-sfly-nickname": "tester" },
		});
		expect(res.status).toBe(204);
		expect((await api.trigger(id)).status).toBe(400);
	});
});
