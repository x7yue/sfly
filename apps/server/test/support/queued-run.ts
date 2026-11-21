import { ApiClient } from "./api-client.js";
import { FakeAgent } from "./fake-agent.js";
import { publishPackage } from "./package-archive.js";
import type { TestControlPlane } from "./test-control-plane.js";

/** 每个控制面只发布一次包、让 Agent 登记一次；同一个控制面上再造运行就不会重复发布同一个版本。 */
const prepared = new WeakMap<TestControlPlane, Promise<void>>();
/** 每个控制面上已经造了几次，给场景起不同的名字。 */
const created = new WeakMap<TestControlPlane, number>();

async function prepare(cp: TestControlPlane): Promise<void> {
	await publishPackage(cp, "queued-run-probe", "1.0.0", { check: ["ok"] });
	await (
		await FakeAgent.connect(cp.grpcUrl, { name: "queued-run-agent" }, { clock: cp.clock })
	).disconnect();
}

/**
 * 造一次存在的运行，返回运行 ID：它在排队，没有 Agent 在线，不会被派发，所以在排队超时之前不会有变化。
 * 排队超时是节点的 `queue_timeout`，默认 10 分钟：超过它任务以 `env_error` 失败，运行随之结束。
 * 用了手动时钟（`startTestControlPlane({ clock })`）又把时间拨过 10 分钟的测试，不能指望运行还停在排队
 * （`control-plane-time.test.ts` 把时钟拨了约 23 小时，它只看 `time` 事件，所以不受影响）。
 * 给只需要「一条能连上的 SSE 流」的测试用（`GET /runs/:id/events`）：控制面里每条 SSE 流都先要有运行或任务。
 * 第一次调用会发布一个包 `queued-run-probe@1.0.0` 并让 `queued-run-agent` 连一次再断开
 * （触发前的预检要求包已发布、Agent 登记过）；同一个控制面上可以重复调用，每次造一个新的运行。
 */
export async function createQueuedRun(cp: TestControlPlane): Promise<string> {
	let ready = prepared.get(cp);
	if (ready === undefined) {
		ready = prepare(cp);
		prepared.set(cp, ready);
	}
	await ready;
	const n = (created.get(cp) ?? 0) + 1;
	created.set(cp, n);
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
		`队列里的运行 ${n}`,
	);
	return api.triggerOk(scenarioId);
}
