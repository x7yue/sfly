// 全栈（#18）：真实的控制面、Rust Agent 和 SDK 执行器。节点用 ctx.artifacts 保存产物，Agent 在上报结果前上传，
// 输出里的产物引用交给后续节点，并且可以从控制面下载；完整日志可以分页读取和下载。
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describeWithAgent("全栈：产物与完整日志", () => {
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

	// 任务凭据（#492）：控制面派发时签发，Agent 放进执行器的环境变量 SFLY_TASK_TOKEN，SDK 下载产物时带上；
	// 只对控制面的地址带；任务结束之后它就失效。真实的控制面、Rust Agent 和 SDK。
	it("节点用 SDK 下载上游节点的产物：任务凭据由 SDK 带上；别的主机的地址上不带；任务结束之后同一个凭据下载是 401", async () => {
		// 「别的主机」：本进程里另一个端口上的服务，记下每个请求带的 Authorization。
		const seen: Array<string | undefined> = [];
		const elsewhere = createServer((request, response) => {
			seen.push(request.headers.authorization);
			response.end("别处的内容");
		});
		await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
		const elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/x.txt`;
		try {
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
						inputs: { files: { "report.txt": "报告内容" } },
					},
					{
						id: "get",
						kind: "package",
						package: "sfly-stub",
						node: "artifact_download",
						inputs: { refs: "${{ nodes.save.outputs.refs }}" },
					},
					{
						id: "foreign",
						kind: "package",
						package: "sfly-stub",
						node: "artifact_download",
						inputs: { refs: { x: elsewhereUrl } },
					},
				],
				edges: [
					{ from: "entry", to: "save", kind: "chain" },
					{ from: "save", to: "get", kind: "chain" },
					{ from: "get", to: "foreign", kind: "chain" },
				],
				packages: { "sfly-stub": "0.1.0" },
			});

			const runId = await api.triggerOk(id);
			await eventually(async () => expect((await api.run(runId)).status).toBe("success"), 60_000);

			// 控制面的地址：SDK 带着任务凭据下载成功。
			const get = await api.node(runId, "get");
			expect(get.outputs?.texts).toEqual({ "report.txt": "报告内容" });
			// 控制面把输出和日志里长得像令牌的值盖成 ******：节点把它倒过来输出，这里倒回来。
			const token = [...String(get.outputs?.token_reversed)].reverse().join("");
			expect(token).toMatch(/^sfly_tsk_[0-9a-f]{48}$/);
			// 别的主机的地址：下载成功，请求里没有 Authorization。
			expect((await api.node(runId, "foreign")).outputs?.texts).toEqual({ x: "别处的内容" });
			expect(seen).toEqual([undefined]);

			// 任务结束了：同一个凭据下载是 401（直接请求，不经过 SDK）。
			const saveTask = (await api.node(runId, "save")).attempts[0]?.task_id;
			const afterwards = await cp.fetch(`/tasks/${saveTask}/artifacts/report.txt`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(afterwards.status).toBe(401);
			// 凭据不在日志里（节点输出里有，是节点自己写的）。
			const logs = await (await cp.fetch(`/runs/${runId}/logs?limit=1000`)).text();
			expect(logs).not.toContain(token);
		} finally {
			await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
		}
	}, 120_000);

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
