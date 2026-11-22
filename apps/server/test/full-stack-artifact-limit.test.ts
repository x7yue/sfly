// 全栈（#477）：真实的控制面、Rust Agent 和 SDK 执行器。产物合计的上限（控制面的 SFLY_ARTIFACT_LIMIT_MB）随任务下发：
// 节点保存时就知道（ctx.artifacts.limit_bytes），放不下的 save 抛出 ArtifactLimitExceeded、节点可以接住；
// 直接写进产物目录的大文件由 Agent 在上传前拦下，放得下的照常上传，任务以 env_error 失败且不按重试配置重试。
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

/** 控制面配置的产物合计上限（字节）。 */
const LIMIT = 1000;

describeWithAgent("全栈：产物合计的上限随任务下发", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let api: ApiClient;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv] = await Promise.all([
			startTestControlPlane({ artifactLimitBytes: LIMIT }),
			createStubVenv(),
		]);
		api = new ApiClient(cp);
		await publishStubPackage(cp);
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "limit-agent",
			venv: venv.path,
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
	});

	/** 一个入口加一个 `artifact_limit` 节点的场景，返回运行的 id。 */
	const run = async (inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
		const id = await api.orchestrationWith({
			default_agent: "limit-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "save",
					kind: "package",
					package: "sfly-stub",
					node: "artifact_limit",
					inputs,
					...extra,
				},
			],
			edges: [{ from: "entry", to: "save", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		return api.triggerOk(id);
	};
	const stored = async (taskId: string) => {
		const listed = (await (await cp.fetch(`/tasks/${taskId}/artifacts`)).json()) as {
			artifacts: Array<{ name: string; size: number }>;
		};
		return listed.artifacts.map((a) => [a.name, a.size]);
	};

	it("节点读到控制面配置的上限；save 放不下时抛出，接住之后其余的产物照常上传，任务成功", async () => {
		const runId = await run({
			files: { "a.bin": "a".repeat(600), "b.bin": "b".repeat(600), "c.bin": "c".repeat(300) },
			catch_limit: true,
		});

		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);
		const save = await api.node(runId, "save");
		expect(save.outputs?.limit).toBe(LIMIT);
		expect(save.outputs?.refused).toEqual(["b.bin"]);
		expect(await stored(save.attempts[0]?.task_id as string)).toEqual([
			["a.bin", 600],
			["c.bin", 300],
		]);
	}, 90_000);

	it("节点不接住：任务在 save 那一行以 node_error 失败，信息写明大小、已保存的、上限和怎么调", async () => {
		const runId = await run({ files: { "big.bin": "x".repeat(LIMIT + 1) } });

		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 60_000);
		const save = await api.node(runId, "save");
		expect(save.error?.kind).toBe("node_error");
		expect(save.error?.message).toContain("ArtifactLimitExceeded");
		expect(save.error?.message).toContain(`${LIMIT + 1} 字节`);
		expect(save.error?.message).toContain(`${LIMIT} 字节`);
		expect(save.error?.message).toContain("SFLY_ARTIFACT_LIMIT_MB");
		expect(await stored(save.attempts[0]?.task_id as string)).toEqual([]);
	}, 90_000);

	it("直接写进产物目录、绕过 save 的大文件：放得下的从小到大上传，任务以 env_error 失败，不按重试配置重试", async () => {
		const runId = await run(
			{ direct: { "c.bin": 900, "a.bin": 300, "sub/b.bin": 500 } },
			{ retries: 2 },
		);

		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 60_000);
		const save = await api.node(runId, "save");
		expect(save.error?.kind).toBe("env_error");
		expect(save.error?.message).toContain("合计 1700 字节");
		expect(save.error?.message).toContain(`上限 ${LIMIT} 字节`);
		expect(save.error?.message).toContain("c.bin（900 字节）");
		expect(save.error?.message).toContain("SFLY_ARTIFACT_LIMIT_MB");
		// 配置了 retries: 2，env_error 不重试：只有一次尝试。
		expect(save.attempts).toHaveLength(1);
		expect(await stored(save.attempts[0]?.task_id as string)).toEqual([
			["a.bin", 300],
			["sub/b.bin", 500],
		]);
	}, 90_000);

	it("合计正好等于上限时全部上传，任务成功", async () => {
		const runId = await run({ direct: { "a.bin": 400, "b.bin": 600 } });

		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);
		const save = await api.node(runId, "save");
		expect(await stored(save.attempts[0]?.task_id as string)).toEqual([
			["a.bin", 400],
			["b.bin", 600],
		]);
	}, 90_000);
});
