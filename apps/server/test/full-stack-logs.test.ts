// 全栈（#10）：真实的控制面、Rust Agent 和 SDK 执行器。节点的 print、标准错误、子进程输出和 ctx.log
// 合并成一条日志流到达控制面；进度显示在运行视图里；secret 参数的值在日志中被打码。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { SseClient } from "./support/sse-client.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface LogLine {
	seq: number;
	time: string;
	agent_time: string;
	source: string;
	level: string;
	text: string;
}

describe("全栈：日志、进度与打码", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv()]);
		await publishStubPackage(cp);
		agent = await startRealAgent({ grpcUrl: cp.grpcUrl, name: "logs-agent", venv: venv.path, bin });
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
	});

	it("一个节点的全部输出按序号到达日志流，secret 被打码，最后的进度保留在尝试里", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "logs-agent",
			nodes: [
				{
					id: "entry",
					kind: "entry",
					params: [{ name: "token", type: "string", secret: true, required: true }],
				},
				{
					id: "talk",
					kind: "package",
					package: "sfly-stub",
					node: "chatter",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: 编排引用语法
					inputs: { steps: 3, interval: 0.05, secret: "${{ params.token }}" },
				},
			],
			edges: [{ from: "entry", to: "talk", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});

		const before = Date.now();
		const runId = await api.triggerOk(id, { token: "hunter2-very-secret" });
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);
		const [attempt] = (await api.node(runId, "talk")).attempts;
		expect(attempt?.progress).toMatchObject({ current: 3, total: 3, message: "第 3 步" });
		const after = Date.now();
		// 两种时间（ADR 0018）：控制面用的是停在 2026-01-01 的手动时钟，Agent 时间是这台机器的系统时间。
		// 控制面时间由真实 Agent 打的单调时钟读数折算：从 Agent 连上的那一刻（手动时钟的起点）往后数真实流逝的毫秒，
		// 手动时钟不动它也在走；Agent 时间原样保存。
		const connectedAt = cp.clock.now().getTime();
		const isControlPlaneTime = (time: string | null | undefined) => {
			const ms = Date.parse(time ?? "");
			expect(ms).toBeGreaterThan(connectedAt);
			expect(ms).toBeLessThan(connectedAt + 600_000);
		};
		const isAgentTime = (time: string | null | undefined) => {
			const ms = Date.parse(time ?? "");
			expect(ms).toBeGreaterThanOrEqual(before);
			expect(ms).toBeLessThanOrEqual(after);
		};
		isControlPlaneTime(attempt?.progress?.time);
		isAgentTime(attempt?.progress?.agent_time);

		const sse = await SseClient.open(cp, `/tasks/${attempt?.task_id}/logs/events`);
		try {
			const { lines } = (await sse.next<{ lines: LogLine[] }>("logs")).data;
			expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
			for (const line of lines) {
				isControlPlaneTime(line.time);
				isAgentTime(line.agent_time);
			}
			// 控制面时间按读到的先后不倒退。
			const times = lines.map((l) => Date.parse(l.time));
			expect(times).toEqual([...times].sort((a, b) => a - b));
			expect(lines.map((l) => [l.source, l.level, l.text])).toEqual(
				expect.arrayContaining([
					["stdout", "info", "来自 print"],
					["stderr", "error", "来自标准错误"],
					["stdout", "info", "来自子进程"],
					["stderr", "error", "子进程错误"],
					["sdk", "debug", "sdk 调试"],
					["sdk", "info", "sdk 信息 1"],
					["sdk", "warn", "sdk 警告"],
					["sdk", "error", "sdk 错误"],
					["stdout", "info", "token=******; again ******"],
				]),
			);
			expect(JSON.stringify(lines)).not.toContain("hunter2");
		} finally {
			sse.close();
		}
	}, 60_000);
});
