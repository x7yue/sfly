// 全栈（#18）：真实的控制面、Rust Agent 和 SDK 执行器。节点用 ctx.artifacts 保存产物，Agent 在上报结果前上传，
// 输出里的产物引用交给后续节点，并且可以从控制面下载；完整日志可以分页读取和下载。
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describe("全栈：产物与完整日志", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;

	beforeAll(async () => {
		const bin = agentBinary();
		[cp, venv] = await Promise.all([startTestControlPlane(), createStubVenv()]);
		await publishStubPackage(cp);
		agent = await startRealAgent({ grpcUrl: cp.grpcUrl, name: "art-agent", venv: venv.path, bin });
	}, 600_000);

	afterAll(async () => {
		await agent?.close();
		await cp?.close();
		await venv?.remove();
	});

	it("节点保存的产物在结果之前上传，输出里的引用交给后续节点，并且可以下载", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "art-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "save",
					kind: "package",
					package: "sfly-stub",
					node: "artifacts",
					inputs: {
						files: { "report.txt": "报告", "图/截图.txt": "像素" },
						// 这个文件在 Agent 上的修改时间是 2099 年（#171）。
						mtimes: { "report.txt": 4070908800 },
					},
				},
				{
					id: "use",
					kind: "package",
					package: "sfly-stub",
					node: "echo",
					inputs: { text: "${{ nodes.save.outputs.refs }}" },
				},
			],
			edges: [
				{ from: "entry", to: "save", kind: "chain" },
				{ from: "save", to: "use", kind: "chain" },
			],
			packages: { "sfly-stub": "0.1.0" },
		});

		const runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 30_000);
		const save = await api.node(runId, "save");
		const taskId = save.attempts[0]?.task_id;
		const refs = save.outputs?.refs as Record<string, string>;

		const listed = (await (await cp.fetch(`/tasks/${taskId}/artifacts`)).json()) as {
			artifacts: Array<{
				name: string;
				size: number;
				url: string;
				agent_modified_at: string | null;
			}>;
		};
		expect(listed.artifacts[0]?.agent_modified_at).toBe("2099-01-01T00:00:00.000Z");
		expect(listed.artifacts[1]?.agent_modified_at).not.toBeNull();
		expect(listed.artifacts.map((a) => [a.name, a.size])).toEqual([
			["report.txt", Buffer.byteLength("报告")],
			["图/截图.txt", Buffer.byteLength("像素")],
		]);
		// SDK 返回的引用就是控制面给出的下载地址。
		expect(refs).toEqual(Object.fromEntries(listed.artifacts.map((a) => [a.name, a.url])));
		expect(await (await fetch(refs["图/截图.txt"] as string)).text()).toBe("像素");
		// 后续节点拿到的是同一份引用。
		expect((await api.node(runId, "use")).outputs).toEqual({ text: refs });
	}, 60_000);

	it("节点返回超过 1 MB 的输出时任务以 node_error 失败", async () => {
		const api = new ApiClient(cp);
		const id = await api.orchestrationWith({
			default_agent: "art-agent",
			nodes: [
				{ id: "entry", kind: "entry" },
				{
					id: "big",
					kind: "package",
					package: "sfly-stub",
					node: "big",
					inputs: { size: 1024 * 1024 },
				},
			],
			edges: [{ from: "entry", to: "big", kind: "chain" }],
			packages: { "sfly-stub": "0.1.0" },
		});
		const runId = await api.triggerOk(id);
		await eventually(async () => expect((await api.run(runId)).status).toBe("failed"), 30_000);
		const node = await api.node(runId, "big");
		expect(node.error?.kind).toBe("node_error");
		expect(node.error?.message).toContain("1 MB");
	}, 60_000);
});
