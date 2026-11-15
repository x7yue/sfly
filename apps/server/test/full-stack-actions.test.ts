// 全栈（#356）：真实的控制面、Rust Agent 和 SDK 执行器，桩节点 actions 用 ctx.action 嵌套记录动作、记一个标记、
// 失败一次，最后在嵌套的「等待放行」「检查放行文件」里等测试放行。动作摘要经事件管道、Agent 的 ActionSummary 到达控制面：
// 执行中能读到摘要和此刻在做的动作，任务结束后正在做的清空、计数保留。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionsApi } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("全栈：动作摘要", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let dir: string;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv, dir] = await Promise.all([
			startTestControlPlane(),
			createStubVenv(),
			mkdtemp(join(tmpdir(), "sfly-actions-")),
		]);
		await publishStubPackage(cp);
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "actions-agent",
			venv: venv.path,
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
		await rm(dir, { recursive: true, force: true });
	});

	it("执行中读到动作摘要和此刻在做的动作；任务结束后正在做的清空，计数保留", async () => {
		const api = new ApiClient(cp);
		const release = join(dir, "release");
		const id = await api.orchestrationWith({
			default_agent: "actions-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "orders",
					kind: "package",
					package: "sfly-stub",
					node: "actions",
					inputs: { release_file: release },
				},
			],
			edges: [{ from: "entry", to: "orders", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		const summary = async (taskId: string) => {
			const res = await cp.fetch(`/tasks/${taskId}/actions/summary`);
			expect(res.status).toBe(200);
			return actionsApi.summary.response.parse(await res.json());
		};

		const attemptNow = async () => {
			const [found] = (await api.node(runId, "orders")).attempts;
			if (!found) throw new Error("还没有尝试");
			return found;
		};
		await eventually(
			async () => expect((await attemptNow()).current_action?.name).toBe("等待放行"),
			30_000,
		);
		const attempt = await attemptNow();
		// 控制面时间由真实 Agent 的单调时钟读数折算：动作在执行器启动之后开始（允许一次往返的折算误差）。
		const startedAt = Date.parse(attempt.current_action?.started_at ?? "");
		expect(startedAt).toBeGreaterThanOrEqual(Date.parse(attempt.started_at ?? "") - 1_000);

		// 两个动作几乎同时开始，SDK 每秒最多发一份摘要：可能先到只有外层的一份。
		await eventually(async () =>
			expect((await summary(attempt.task_id)).running.map((a) => [a.name, a.depth])).toEqual([
				["等待放行", 0],
				["检查放行文件", 1],
			]),
		);
		const running = await summary(attempt.task_id);
		expect(running.running[0]?.fields).toEqual({ 文件: "release" });
		expect(running.running[1]?.parent).toBe(running.running[0]?.id);
		expect(running.names.map((n) => [n.name, n.total, n.failed])).toEqual([
			["下单", 2, 1],
			["收到第一笔成交", 1, 0],
			["风控检查", 1, 0],
			["等待放行", 1, 0],
			["检查放行文件", 1, 0],
		]);
		expect(running.recent_failed.map((a) => [a.name, a.reason, a.fields])).toEqual([
			["下单", "拒单：余额不足", { 订单: "1002" }],
		]);
		expect(running.recent.find((a) => a.name === "风控检查")?.parent).toBe(
			running.recent.find((a) => a.fields.订单 === "1001")?.id,
		);

		await writeFile(release, "");
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);
		const [ended] = (await api.node(runId, "orders")).attempts;
		expect(ended?.current_action).toBeNull();
		const final = await summary(attempt.task_id);
		expect(final.running).toEqual([]);
		expect(final.total).toBe(6);
		expect(final.recent.slice(0, 2).map((a) => [a.name, a.result])).toEqual([
			["等待放行", "success"],
			["检查放行文件", "success"],
		]);
	}, 90_000);
});
