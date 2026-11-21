import { ApiClient } from "./api-client.js";
import { FakeAgent } from "./fake-agent.js";
import { publishPackage } from "./package-archive.js";
import type { TestControlPlane } from "./test-control-plane.js";

/**
 * 造一次存在的运行，返回运行 ID：它在排队，没有 Agent 在线，不会被派发，也不会有后续变化。
 * 给只需要「一条能连上的 SSE 流」的测试用（`GET /runs/:id/events`）：控制面里每条 SSE 流都先要有运行或任务。
 * 会发布一个包 `queued-run-probe@1.0.0` 并让 `queued-run-agent` 连一次再断开（触发前的预检要求包已发布、Agent 登记过）。
 */
export async function createQueuedRun(cp: TestControlPlane): Promise<string> {
	await publishPackage(cp, "queued-run-probe", "1.0.0", { check: ["ok"] });
	await (
		await FakeAgent.connect(cp.grpcUrl, { name: "queued-run-agent" }, { clock: cp.clock })
	).disconnect();
	const api = new ApiClient(cp);
	const scenarioId = await api.orchestrationWith(
		{
			default_agent: "queued-run-agent",
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{ id: "check", kind: "package", package: "queued-run-probe", node: "check" },
			],
			edges: [{ from: "entry", to: "check", kind: "chain" }],
			packages: { "queued-run-probe": "1.0.0" },
		},
		"队列里的运行",
	);
	return api.triggerOk(scenarioId);
}
