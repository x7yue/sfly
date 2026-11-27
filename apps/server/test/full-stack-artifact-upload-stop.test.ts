// 全栈（#648）：节点已经成功、Agent 正在上传它的产物时，它所在的子流程被「停止子流程」节点停止：
// 上传被打断，这个节点记成 stopped，运行不是 failed（docs/SEMANTICS.md §4.1「停止不算失败」）。
// 以前 Agent 把这种成功的节点报成 node_error 失败，控制面记成最终失败、链按失败结束。
//
// 真实的控制面、真实的 Rust Agent、真实的 SDK 执行器。「上传正在进行」靠一个挡在 Agent 和控制面之间的 HTTP 代理：
// 产物的 PUT 它收下之后不回应（连接留着），别的请求（下载节点包、包索引……）原样转给控制面。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chainOf, nodeOf, orchestration, stub } from "./support/acceptance.js";
import { agentBinary } from "./support/agent-binary.js";
import { ApiClient } from "./support/api-client.js";
import { describeWithAgent } from "./support/describe-with-agent.js";
import { eventually } from "./support/eventually.js";
import { createStubVenv, type RealAgent, startRealAgent } from "./support/real-agent.js";
import { publishStubPackage } from "./support/stub-package.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

describeWithAgent("全栈：上传产物时被停止子流程打断", () => {
	let cp: TestControlPlane;
	let venv: Awaited<ReturnType<typeof createStubVenv>>;
	let agent: RealAgent;
	let proxy: Server;
	let dir: string;
	/** 代理收下、没有回应的产物上传请求的路径。 */
	const held: string[] = [];

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-upload-stop-"));
		const bin = agentBinary();
		let upstreamPort = 0;
		proxy = createServer((req, res) => {
			if (req.method === "PUT" && /\/artifacts\//.test(req.url ?? "")) {
				held.push(req.url ?? "");
				req.resume();
				return; // 不回应：控制面卡住的样子
			}
			const forward = httpRequest(
				{
					host: "127.0.0.1",
					port: upstreamPort,
					method: req.method,
					path: req.url,
					headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
				},
				(upstream) => {
					res.writeHead(upstream.statusCode ?? 502, upstream.headers);
					upstream.pipe(res);
				},
			);
			forward.on("error", () => {
				res.statusCode = 502;
				res.end();
			});
			req.pipe(forward);
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
		[cp, venv] = await Promise.all([
			startTestControlPlane({ publicHttpUrl: proxyUrl }),
			createStubVenv(),
		]);
		upstreamPort = Number(new URL(cp.httpUrl).port);
		await publishStubPackage(cp);
		agent = await startRealAgent({
			grpcUrl: cp.grpcUrl,
			name: "upload-stop",
			venv: venv.path,
			bin,
		});
	}, 600_000);

	afterAll(async () => {
		proxy?.closeAllConnections();
		await agent?.close();
		await cp?.close();
		await venv?.remove();
		await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("成功的节点正在上传产物时被停止子流程停止：记成 stopped，运行不是 failed", async () => {
		const api = new ApiClient(cp);
		const file = (name: string) => join(dir, name);
		const id = await api.orchestrationWith(
			orchestration(
				"upload-stop",
				[
					[
						{ id: "entry", kind: "entry" },
						{ id: "spawn", kind: "async", params: {} },
						// 主链停在闸门上，等测试确认上传已经开始了才放行，再去停止子流程。
						stub("gate", "gate", {
							ready_file: file("gate-ready"),
							release_file: file("gate-release"),
						}),
						{ id: "stop", kind: "stop_subflow", subflow: "up" },
					],
					[
						{ id: "up", kind: "subflow_entry", params: [] },
						// 保存一个产物就成功结束：Agent 在上报结果之前上传它，代理不回应，上传一直卡着。
						stub("save", "artifacts", { files: { "report.txt": "内容" } }),
					],
				],
				[["spawn", "up"]],
			),
		);
		const runId = await api.triggerOk(id);

		await eventually(() => {
			expect(held.length).toBeGreaterThanOrEqual(1);
		}, 90_000);
		expect(held[0]).toContain("/artifacts/report.txt");
		const before = await api.run(runId);
		expect(nodeOf(chainOf(before, "up"), "save").status).not.toBe("success");

		// 放行闸门 → 停止子流程「up」：它的节点（已经成功、正在上传）收到取消。
		await writeFile(file("gate-release"), "");
		await eventually(async () => {
			const run = await api.run(runId);
			expect(nodeOf(chainOf(run, "up"), "save").status).toBe("stopped");
			expect(run.status).toBe("success");
		}, 60_000);

		const run = await api.run(runId);
		expect(run.status).not.toBe("failed");
		const save = nodeOf(chainOf(run, "up"), "save");
		expect(save.attempts.length, "不重试：停止不算失败").toBe(1);
		expect(held.length, "被打断之后不再重试上传").toBe(1);
	}, 180_000);
});
