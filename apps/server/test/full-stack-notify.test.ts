// 全栈（#234）：真实的控制面、Rust Agent 和 SDK 执行器，桩节点 notify 调用 ctx.notify。
// 通知经事件管道、Agent 的 Notification 消息到达控制面，写进发送队列，由控制面投递给假飞书 Webhook 服务；
// 投递结果写进这个任务的日志。机器人不是通过「飞书机器人」类型的参数传入的不发送，飞书不响应时节点照常成功。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { type FakeFeishu, startFakeFeishu } from "./support/fake-feishu.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const OPS = "tok-ops-0c5d7e19";
const SLOW = "tok-slow-4a8b2f60";

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
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await feishu?.close();
		await cp?.close();
		await venv?.remove();
	});

	const run = async (bot: string) => {
		const runId = await api.triggerOk(scenario, { bot });
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);
		const taskId = (await api.node(runId, "n")).attempts[0]?.task_id as string;
		const log = async () =>
			(await api.getJson<{ lines: LogLine[] }>(`/tasks/${taskId}/logs`)).lines;
		return { log };
	};
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
});
