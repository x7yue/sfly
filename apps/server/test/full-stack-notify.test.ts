// 全栈（#234、#235）：真实的控制面、Rust Agent 和 SDK 执行器，桩节点 notify、notify_card、notify_message 调用 ctx.notify。
// 通知经事件管道、Agent 的 Notification 消息到达控制面，写进发送队列，由控制面投递给假飞书 Webhook 服务；
// 投递结果写进这个任务的日志。机器人不是通过「飞书机器人」类型的参数传入的不发送，飞书不响应时节点照常成功。
// 节点用 sfly.feishu.card 发的卡片、自己写的原始消息原样到达假飞书；不合格的原始消息不发送，任务日志里有原因。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary, repoRoot } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const OPS = "tok-ops-0c5d7e19";
const SLOW = "tok-slow-4a8b2f60";
const CARDS = "tok-cards-71e0b3d8";

/** 卡片的共享用例（testdata/feishu-card-cases.json）：SDK 组装、控制面原样投递，假飞书收到的就是用例的期望。 */
const cardCases = (
	JSON.parse(readFileSync(join(repoRoot, "testdata/feishu-card-cases.json"), "utf8")) as {
		cases: Array<{ name: string; input: CardInput; expected: { body?: unknown } }>;
	}
).cases;
type CardInput = { title: unknown; markdown: unknown; color: string };
/** 用例里的字符串可以写成 {"$repeat": 单元, "times": 次数, "suffix": 末尾}；先展开。 */
function expand(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(expand);
	if (value !== null && typeof value === "object") {
		const o = value as Record<string, unknown>;
		if ("$repeat" in o)
			return (o.$repeat as string).repeat(o.times as number) + ((o.suffix as string) ?? "");
		return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)]));
	}
	return value;
}
const cardCase = (part: string) => {
	const found = cardCases.find((c) => c.name.includes(part));
	if (!found?.expected.body) throw new Error(`没有名字含「${part}」的卡片用例`);
	return { input: expand(found.input) as CardInput, body: expand(found.expected.body) };
};

interface LogLine {
	source: string;
	level: string;
	text: string;
}

describe("全栈：ctx.notify", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let feishu: FakeFeishu;
	let api: ApiClient;
	let scenario: string;
	let cardScenario: string;
	let rawScenario: string;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv, feishu] = await Promise.all([
			startTestControlPlane(),
			createStubVenv(),
			startFakeFeishu(),
		]);
		api = new ApiClient(cp);
		await publishStubPackage(cp);
		await api.createFeishuBot("ops", feishu.webhookUrl(OPS));
		await api.createFeishuBot("slow", feishu.webhookUrl(SLOW));
		await api.createFeishuBot("cards", feishu.webhookUrl(CARDS));
		feishu.replyTo(SLOW, { hang: true });
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "notify-agent",
			venv: venv.path,
			bin,
		});
		scenario = await api.orchestrationWith({
			default_agent: "notify-agent",
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "bot", type: "string", required: true }] },
				{
					id: "n",
					kind: "package",
					package: "sfly-stub",
					node: "notify",
					inputs: { bot: "${{ params.bot }}", text: "指标越界", at_all: true, unlisted: "slow" },
				},
			],
			edges: [{ from: "entry", to: "n", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		const single = (params: Array<Record<string, unknown>>, node: string, inputs: object) =>
			api.orchestrationWith({
				default_agent: "notify-agent",
				nodes: [
					{ id: "entry", kind: "entry", params },
					{ id: "n", kind: "package", package: "sfly-stub", node, inputs },
				],
				edges: [{ from: "entry", to: "n", kind: "chain" }],
				packages: { "sfly-stub": "0.1.0" },
			});
		const text = (name: string) => ({ name, type: "string", required: true });
		cardScenario = await single(
			[text("bot"), text("title"), text("markdown"), text("color")],
			"notify_card",
			{
				bot: "${{ params.bot }}",
				title: "${{ params.title }}",
				markdown: "${{ params.markdown }}",
				color: "${{ params.color }}",
			},
		);
		rawScenario = await single(
			[text("bot"), { name: "message", type: "json", required: true }],
			"notify_message",
			{ bot: "${{ params.bot }}", message: "${{ params.message }}" },
		);
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await feishu?.close();
		await cp?.close();
		await venv?.remove();
	});

	const runScenario = async (scenarioId: string, params: Record<string, unknown>) => {
		const runId = await api.triggerOk(scenarioId, params);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);
		const taskId = (await api.node(runId, "n")).attempts[0]?.task_id as string;
		const log = async () =>
			(await api.getJson<{ lines: LogLine[] }>(`/tasks/${taskId}/logs`)).lines;
		return { log };
	};
	const run = (bot: string) => runScenario(scenario, { bot });
	const hookPath = (token: string) => `/open-apis/bot/v2/hook/${token}`;

	it("假飞书收到请求体，投递结果写进这个任务的日志；不是通过「飞书机器人」参数传入的机器人不发送", async () => {
		const { log } = await run("ops");

		await eventually(async () =>
			expect((await log()).find((l) => l.text.includes("已送达"))).toMatchObject({
				source: "system",
				level: "info",
			}),
		);
		expect(feishu.requests.map((r) => [r.path, r.json])).toEqual([
			[
				hookPath(OPS),
				{ msg_type: "text", content: { text: '指标越界<at user_id="all">所有人</at>' } },
			],
		]);
		const lines = await log();
		expect(lines.find((l) => l.source === "sdk")?.text).toBe("发通知前");
		const warning = lines.find((l) => l.level === "warn");
		expect(warning).toMatchObject({ source: "system" });
		expect(warning?.text).toContain("「slow」");
	}, 120_000);

	it("飞书不响应时调用不阻塞：节点照常成功，这时投递还没有结果", async () => {
		const { log } = await run("slow");

		await eventually(() => expect(feishu.requests.map((r) => r.path)).toContain(hookPath(SLOW)));
		expect((await log()).filter((l) => l.source === "system")).toEqual([]);
	}, 120_000);

	const received = (token: string) =>
		feishu.requests.filter((r) => r.path === hookPath(token)).map((r) => r.json);

	it.each([
		"标题、颜色和正文各就各位",
		"多一个字节：截断正文",
		"emoji 每个占 4 字节",
	])("节点用 sfly.feishu.card 发的卡片：假飞书收到的请求体就是卡片用例「%s」的期望，投递结果写进任务日志", async (name) => {
		const { input, body } = cardCase(name);
		const before = received(CARDS).length;

		const { log } = await runScenario(cardScenario, { bot: "cards", ...input });

		await eventually(() => expect(received(CARDS)).toHaveLength(before + 1));
		expect(received(CARDS).at(-1)).toEqual(body);
		await eventually(async () =>
			expect((await log()).find((l) => l.text.includes("已送达"))).toMatchObject({
				source: "system",
				level: "info",
			}),
		);
	}, 120_000);

	it("节点用 ctx.notify(message=...) 发的原始消息：自己写的卡片原样到达假飞书", async () => {
		const message = {
			msg_type: "interactive",
			card: {
				schema: "2.0",
				header: { title: { tag: "plain_text", content: '压测 "A" 环境' }, template: "red" },
				body: {
					elements: [
						{ tag: "markdown", content: "**P99** 超标\n😀" },
						{
							tag: "button",
							text: { tag: "plain_text", content: "查看" },
							behaviors: [{ type: "open_url", default_url: "https://example.com/r/1" }],
						},
					],
				},
			},
		};
		const before = received(CARDS).length;

		await runScenario(rawScenario, { bot: "cards", message });

		await eventually(() => expect(received(CARDS)).toHaveLength(before + 1));
		expect(received(CARDS).at(-1)).toEqual(message);
	}, 120_000);

	it("不合格的原始消息：不发送，任务日志里有原因，节点和运行照常成功", async () => {
		const before = received(CARDS).length;

		const { log } = await runScenario(rawScenario, { bot: "cards", message: { content: {} } });

		await eventually(async () =>
			expect((await log()).find((l) => l.level === "warn")).toMatchObject({
				source: "system",
				text: expect.stringContaining("ctx.notify 的消息没有发送：原始消息的 msg_type"),
			}),
		);
		expect(received(CARDS)).toHaveLength(before);
	}, 120_000);
});
