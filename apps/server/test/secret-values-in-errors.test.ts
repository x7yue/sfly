// 触发时的报错里不回显 secret 参数的值（#467）：按实际值（默认值、调用方传的值、预设固定的值）做的检查，
// 问题的说明和 details 里写出的值要打码，写成 ******。
// 另外：触发时 secret 参数的值恰好是读取接口打的码 ******，拒绝；运行预设保存时同理。
// 测试里的值都是明显的假值；断言整个响应的文本（message 和 details 都在里面）里没有它。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { orchestrationsApi, runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { FakeAgent } from "./support/fake-agent.js";
import { packageArchive, packageMetadata, publishInit } from "./support/package-archive.js";
import { createPreset, createPresetOk, errorOf, triggerWithPreset } from "./support/presets.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const MASK = "******";
const BOT = "test-secret-bot";
const AGENT = "test-secret-agent";
const PIN = 7345921;

/** mix：agent_in(source: Agent)、bot_in(bot: 飞书机器人)、count(n: integer)；声明 requires_agent，Agent 版本太旧会被拦。 */
const metadata = packageMetadata({
	name: "mix",
	version: "1.0.0",
	requires_agent: ">=1.1",
	nodes: [
		{
			name: "agent_in",
			title: "用 Agent",
			entry: "mix:agent_in",
			inputs: {
				type: "object",
				properties: { source: { type: "string", "x-sfly-type": "agent" } },
				required: ["source"],
			},
			outputs: { type: "object", properties: {} },
		},
		{
			name: "bot_in",
			title: "用机器人",
			entry: "mix:bot_in",
			inputs: {
				type: "object",
				properties: { bot: { type: "string", "x-sfly-type": "feishu_bot" } },
				required: ["bot"],
			},
			outputs: { type: "object", properties: {} },
		},
		{
			name: "count",
			title: "计数",
			entry: "mix:count",
			inputs: {
				type: "object",
				properties: { n: { type: "integer" } },
				required: ["n"],
			},
			outputs: { type: "object", properties: {} },
		},
	],
});

const node = (id: string, type: string, inputs: Record<string, unknown>) => ({
	id,
	kind: "package",
	package: "mix",
	node: type,
	inputs,
});

/** 入口 entry → 一个节点；入口参数 params。 */
const scenario = (params: unknown[], middle: Record<string, unknown>) => ({
	default_agent: "runner",
	nodes: [{ id: "entry", kind: "entry", params }, middle],
	edges: [{ from: "entry", to: (middle as { id: string }).id, kind: "chain" }],
	packages: { mix: "1.0.0" },
});

interface Rejected {
	error: { code: string; message: string; details: unknown };
}

describe("触发时的报错不回显 secret 参数的值", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];
	const connect = async (name: string, agentVersion: string) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, { name, agentVersion });
		agents.push(agent);
		return agent;
	};

	beforeEach(async () => {
		cp = await startTestControlPlane({ version: "1.1.0" });
		api = new ApiClient(cp);
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
		await connect("runner", "1.1.0");
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	/** 触发，断言被拒绝；返回响应的全部文本（message 和 details 都在里面）。 */
	async function rejectedText(id: string, params: Record<string, unknown> = {}) {
		const res = await api.trigger(id, params);
		const text = await res.text();
		expect(res.status, text).toBe(400);
		return { text, error: (JSON.parse(text) as Rejected).error };
	}

	it("机器人输入：默认值是 secret，没有登记时报错里是掩码（读最新版本、预检也都打了码）", async () => {
		const id = await api.orchestrationWith(
			scenario(
				[{ name: "b", type: "string", secret: true, default: BOT }],
				node("n", "bot_in", { bot: "${{ params.b }}" }),
			),
		);
		const { text, error } = await rejectedText(id);
		expect(text).not.toContain(BOT);
		expect(error.code).toBe("invalid_params");
		expect(error.message).toBe(
			`节点 n 的输入 bot 选择的飞书机器人「${MASK}」还没有登记（取自入口参数）`,
		);
		expect(error.details).toEqual([
			{
				code: "feishu_bot_not_registered",
				message: `节点 n 的输入 bot 选择的飞书机器人「${MASK}」还没有登记（取自入口参数）`,
				node_id: "n",
			},
		]);
		for (const path of [`/orchestrations/${id}/head`, `/orchestrations/${id}/preflight`]) {
			expect(await (await api.get(path)).text(), path).not.toContain(BOT);
		}
	});

	it("机器人输入：调用方自己传进来的 secret 值同样打码；普通参数照常写出值", async () => {
		const secret = await api.orchestrationWith(
			scenario(
				[{ name: "b", type: "string", secret: true }],
				node("n", "bot_in", { bot: "${{ params.b }}" }),
			),
		);
		const given = await rejectedText(secret, { b: BOT });
		expect(given.text).not.toContain(BOT);
		expect(given.error.message).toContain(`「${MASK}」`);

		const plain = await api.orchestrationWith(
			scenario([{ name: "b", type: "string" }], node("n", "bot_in", { bot: "${{ params.b }}" })),
		);
		expect((await rejectedText(plain, { b: "ghost" })).error.message).toContain("「ghost」");
	});

	it("机器人输入：引用夹在文字里（前缀-${{ params.b }}）时，解析出来的值里的 secret 部分也打码", async () => {
		const id = await api.orchestrationWith(
			scenario(
				[{ name: "b", type: "string", secret: true, default: BOT }],
				node("n", "bot_in", { bot: "ops-${{ params.b }}" }),
			),
		);
		const { text, error } = await rejectedText(id);
		expect(text).not.toContain(BOT);
		expect(error.message).toContain(`「ops-${MASK}」`);
	});

	it("Agent 输入：没有注册过时报错里是掩码", async () => {
		const id = await api.orchestrationWith(
			scenario(
				[{ name: "a", type: "string", secret: true, default: AGENT }],
				node("n", "agent_in", { source: "${{ params.a }}" }),
			),
		);
		const { text, error } = await rejectedText(id);
		expect(text).not.toContain(AGENT);
		expect(error.message).toBe(
			`节点 n 的输入 source 选择的 Agent ${MASK} 还没有注册过（取自入口参数）`,
		);
		expect(await (await api.get(`/orchestrations/${id}/preflight`)).text()).not.toContain(AGENT);
	});

	it("Agent 输入：版本不满足节点包的要求时报错里是掩码（Agent 版本照常写）", async () => {
		await (await connect(AGENT, "1.0.0")).close();
		const id = await api.orchestrationWith(
			scenario(
				[{ name: "a", type: "string", secret: true, default: AGENT }],
				node("n", "agent_in", { source: "${{ params.a }}" }),
			),
		);
		const { text, error } = await rejectedText(id);
		expect(text).not.toContain(AGENT);
		expect(error.message).toBe(
			`节点 n：节点包 mix@1.0.0 需要 Agent >=1.1，参数 source 选的 Agent ${MASK} 的版本是 1.0.0：请升级 Agent ${MASK}（取自入口参数）`,
		);
	});

	it("类型不符的值（整数输入接到 secret 的小数）：说明里是掩码，不管值来自默认值还是调用方", async () => {
		const id = await api.orchestrationWith(
			scenario(
				[{ name: "n", type: "number", secret: true, default: 8.5 }],
				node("c", "count", { n: "${{ params.n }}" }),
			),
		);
		const byDefault = await rejectedText(id);
		expect(byDefault.error.message).toContain(`实际是 ${MASK}`);
		expect(byDefault.text).not.toContain("8.5");
		const byCaller = await rejectedText(id, { n: 9.25 });
		expect(byCaller.error.message).toContain(`实际是 ${MASK}`);
		expect(byCaller.text).not.toContain("9.25");
	});

	it("预设固定的 secret 值同样打码", async () => {
		const id = await api.orchestrationWith(
			scenario(
				[{ name: "b", type: "string", secret: true }],
				node("n", "bot_in", { bot: "${{ params.b }}" }),
			),
		);
		const preset = await createPresetOk(api, id, {
			name: "p",
			params: [{ name: "b", value: BOT }],
		});
		const res = await triggerWithPreset(api, id, preset.id, {});
		const text = await res.text();
		expect(res.status, text).toBe(400);
		expect(text).not.toContain(BOT);
		expect(text).toContain(MASK);
	});

	it("子流程里经参数映射传进来的 secret 值同样打码", async () => {
		const id = await api.orchestrationWith({
			default_agent: "runner",
			nodes: [
				{
					id: "entry",
					kind: "entry",
					params: [{ name: "b", type: "string", secret: true, default: BOT }],
				},
				{ id: "s", kind: "async", params: { who: "${{ params.b }}" } },
				{
					id: "sub",
					kind: "subflow_entry",
					name: "inner",
					params: [{ name: "who", type: "string" }],
				},
				node("n", "bot_in", { bot: "${{ params.who }}" }),
			],
			edges: [
				{ from: "entry", to: "s", kind: "chain" },
				{ from: "s", to: "sub", kind: "dispatch" },
				{ from: "sub", to: "n", kind: "chain" },
			],
			packages: { mix: "1.0.0" },
		});
		const { text, error } = await rejectedText(id);
		expect(text).not.toContain(BOT);
		expect(error.message).toContain(MASK);
	});

	/** 主链入口参数 b（secret，默认值 `value`）经异步任务节点的映射 `mapped` 传进子流程参数 who，子流程里整值引用 who 接到整数输入。 */
	const subflowToInteger = (mapped: unknown, whoType: string, value: string = BOT) =>
		api.orchestrationWith({
			default_agent: "runner",
			nodes: [
				{
					id: "entry",
					kind: "entry",
					params: [{ name: "b", type: "string", secret: true, default: value }],
				},
				{ id: "s", kind: "async", params: { who: mapped } },
				{
					id: "sub",
					kind: "subflow_entry",
					name: "inner",
					params: [{ name: "who", type: whoType }],
				},
				node("c", "count", { n: "${{ params.who }}" }),
			],
			edges: [
				{ from: "entry", to: "s", kind: "chain" },
				{ from: "s", to: "sub", kind: "dispatch" },
				{ from: "sub", to: "c", kind: "chain" },
			],
			packages: { mix: "1.0.0" },
		});

	it("类型不符：secret 值夹在文字里经参数映射传进子流程再接到整数输入，说明里的值也打码（默认值和调用方传的）", async () => {
		const id = await subflowToInteger("x-${{ params.b }}", "string");
		const byDefault = await rejectedText(id);
		expect(byDefault.error.code).toBe("invalid_params");
		expect(byDefault.text).not.toContain(BOT);
		expect(byDefault.error.message).toContain(`实际是 "x-${MASK}"`);
		expect(byDefault.error.message).toContain("输入 n 应为 integer");
		const byCaller = await rejectedText(id, { b: AGENT });
		expect(byCaller.text).not.toContain(AGENT);
		expect(byCaller.error.message).toContain(`实际是 "x-${MASK}"`);
	});

	it("类型不符：secret 值放在映射的对象里传进子流程再接到整数输入，说明里的值也打码", async () => {
		const id = await subflowToInteger({ k: "${{ params.b }}" }, "json");
		const byDefault = await rejectedText(id);
		expect(byDefault.error.message).toContain("输入 n 应为 integer");
		expect(byDefault.text).not.toContain(BOT);
		expect(byDefault.error.message).toContain(`{"k":"${MASK}"}`);
		const byCaller = await rejectedText(id, { b: AGENT });
		expect(byCaller.text).not.toContain(AGENT);
	});

	it("类型不符：secret 值里有引号、反斜杠、换行时（说明里是 JSON 转义后的写法）同样打码", async () => {
		const tricky = 'test-"quoted"\\-line\nend';
		const id = await subflowToInteger("x-${{ params.b }}", "string", tricky);
		const { text, error } = await rejectedText(id);
		expect(error.message).toContain("输入 n 应为 integer");
		expect(text).not.toContain("quoted");
		expect(text).not.toContain("line");
		expect(error.message).toContain(MASK);
	});

	it("预检（GET）的问题和警告里没有 secret 默认值", async () => {
		const id = await api.orchestrationWith(
			scenario(
				[
					{ name: "b", type: "string", secret: true, default: BOT },
					{ name: "p", type: "number", secret: true, default: PIN },
				],
				node("n", "bot_in", { bot: "${{ params.b }}" }),
			),
		);
		const text = await (await api.get(`/orchestrations/${id}/preflight`)).text();
		expect(text).not.toContain(BOT);
		expect(text).not.toContain(String(PIN));
		runsApi.preflight.response.parse(JSON.parse(text));
	});

	it("保存时的警告和错误里没有 secret 默认值（静态检查只看常量，不看默认值）", async () => {
		const id = await api.createOrchestration("保存");
		const document = scenario(
			[{ name: "b", type: "string", secret: true, default: BOT }],
			node("n", "bot_in", { bot: "${{ params.b }}" }),
		);
		const saved = await api.post(`/orchestrations/${id}/versions`, { base_version: 0, document });
		const savedText = await saved.text();
		expect(saved.status, savedText).toBe(201);
		expect(savedText).not.toContain(BOT);
		orchestrationsApi.saveVersion.response.parse(JSON.parse(savedText));
		// 冲突（409）和文档不合法（400）的响应。
		const conflict = await api.post(`/orchestrations/${id}/versions`, {
			base_version: 0,
			document,
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.text()).not.toContain(BOT);
		const invalid = await api.post(`/orchestrations/${id}/versions`, {
			base_version: 1,
			document: {
				...document,
				nodes: [
					{
						id: "entry",
						kind: "entry",
						params: [{ name: "b", type: "string", secret: true, default: BOT, bogus: BOT }],
					},
				],
			},
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).not.toContain(BOT);
	});
});

describe("secret 参数的值是读取接口打的码 ******", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let runner: FakeAgent;

	beforeEach(async () => {
		cp = await startTestControlPlane({ version: "1.1.0" });
		api = new ApiClient(cp);
		runner = await FakeAgent.connect(cp.grpcUrl, { name: "runner", agentVersion: "1.1.0" });
		expect((await cp.fetch("/packages", publishInit(packageArchive(metadata)))).status).toBe(201);
	});
	afterEach(async () => {
		await runner.disconnect();
		await cp.close();
	});

	const withToken = () =>
		api.orchestrationWith(
			scenario(
				[
					{ name: "token", type: "string", secret: true, default: "test-secret-value" },
					{ name: "label", type: "string", default: "plain" },
				],
				node("n", "count", { n: 1 }),
			),
		);

	it("触发时把占位符当成 secret 参数的值传回来：400，写明原因，不产生运行，节点不会收到 ******", async () => {
		const id = await withToken();
		const res = await api.trigger(id, { token: MASK });
		expect(res.status).toBe(400);
		const { error } = (await res.json()) as Rejected;
		expect(error.code).toBe("invalid_params");
		expect(error.message).toBe(
			`参数 token 的值是 ${MASK}：这是读取时给 secret 参数打的码，不是值。不传这个参数就用默认值，要用别的值就传真正的值`,
		);
		expect(error.details).toEqual([error.message]);
		await runner.expectNoAssign();
		expect((await api.getJson<{ runs: unknown[] }>(`/orchestrations/${id}/runs`)).runs).toEqual([]);
	});

	it("不传这个参数用默认值、传真正的值都照常触发；普通参数的值可以是 ******", async () => {
		const id = await withToken();
		await api.triggerOk(id, { label: MASK });
		expect((await runner.nextAssign()).inputs).toEqual({ n: 1 });
		const run = await api.run(await api.triggerOk(id, { token: "test-secret-other" }));
		expect(run.params).toMatchObject({ token: MASK, label: "plain" });
	});

	it("预设里的 secret 值写成 ******：拒绝；沿用原值（keep）照旧；普通参数的值可以是 ******", async () => {
		const id = await withToken();
		const refused = await createPreset(api, id, {
			name: "p",
			params: [{ name: "token", value: MASK }],
		});
		expect(refused.status).toBe(400);
		const error = await errorOf(refused);
		expect(error).toMatchObject({ code: "invalid_preset" });
		expect(JSON.stringify(error)).toContain("读取时给 secret 参数打的码");

		const preset = await createPresetOk(api, id, {
			name: "ok",
			params: [
				{ name: "token", value: "test-secret-fixed" },
				{ name: "label", value: MASK },
			],
		});
		expect(preset.params).toEqual([
			{ name: "token", secret: true, value: MASK },
			{ name: "label", secret: false, value: MASK },
		]);
		const kept = await api.patch(`/orchestrations/${id}/presets/${preset.id}`, {
			params: [{ name: "token", keep: true }],
		});
		expect(kept.status, await kept.clone().text()).toBe(200);
	});
});
