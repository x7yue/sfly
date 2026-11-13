import type { ApiError, Client, RunView, Unsubscribe } from "@sfly/client";
import { runsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { observedClient, startClientControlPlane } from "./support/client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { type StreamingProxy, startStreamingProxy } from "./support/streaming-proxy.js";
import type { TestControlPlane } from "./support/test-control-plane.js";

const AGENT = "agent-a";
const MISSING_RUN = "00000000-0000-0000-0000-000000000000";
/** 控制面建议的重连间隔是 3 秒，等重连的条件留出余量。 */
const RECONNECT_MS = 10_000;
const LIFECYCLE = ["pending", "queued", "dispatched", "running", "success"];

const statusOf = (view: RunView | undefined, node: string) =>
	view?.chains[0]?.nodes.find((n) => n.node_id === node)?.status;
const changes = <T>(values: T[]) => values.filter((v, i) => i === 0 || v !== values[i - 1]);

describe("API 客户端订阅事件流", () => {
	let clock: ManualClock;
	let cp: TestControlPlane;
	let client: Client;
	let controlPlaneTimes: string[];
	let api: ApiClient;
	let agent: FakeAgent;
	let scenarioId: string;
	const subscriptions: Unsubscribe[] = [];
	const proxies: StreamingProxy[] = [];

	const track = (close: Unsubscribe) => {
		subscriptions.push(close);
		return close;
	};
	const proxied = async () => {
		const proxy = await startStreamingProxy(cp.httpUrl);
		proxies.push(proxy);
		return { proxy, ...observedClient({ baseUrl: proxy.url }) };
	};
	const startRun = async (): Promise<{ runId: string; task: AssignedTask }> => {
		const runId = await api.triggerOk(scenarioId);
		return { runId, task: await agent.nextAssign() };
	};
	/**
	 * 等过一次断线重连的间隔：另开一条订阅，切断它，等它重连上。
	 * 被测的订阅如果还会重连，到这时也已经重连了（它断开得更早，间隔不比这条长）。
	 */
	const reconnectIntervalPassed = async (runId: string) => {
		const { proxy, client: witness } = await proxied();
		let opens = 0;
		track(witness.runs.events({ params: { id: runId } }, {}, { onOpen: () => opens++ }));
		await eventually(() => expect(opens).toBe(1));
		proxy.cut();
		await eventually(() => expect(opens).toBe(2), RECONNECT_MS);
	};

	beforeEach(async () => {
		clock = new ManualClock();
		({ cp, client, controlPlaneTimes } = await startClientControlPlane({
			clock,
			sseHeartbeatMs: 20,
		}));
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: AGENT });
		scenarioId = await api.orchestrationWith({
			default_agent: AGENT,
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{ id: "a", kind: "package", package: "stub", node: "echo" },
				{ id: "b", kind: "package", package: "stub", node: "echo" },
			],
			edges: [
				{ from: "entry", to: "a", kind: "chain" },
				{ from: "a", to: "b", kind: "chain" },
			],
			packages: { stub: "1.0.0" },
		});
	});
	afterEach(async () => {
		for (const close of subscriptions.splice(0)) close();
		await Promise.all(proxies.splice(0).map((p) => p.close()));
		await agent.disconnect();
		await cp.close();
	});

	it("订阅一次运行的事件流，用假 Agent 推进运行，处理函数依次收到运行视图直到运行结束", async () => {
		const { runId, task: a } = await startRun();
		const views: RunView[] = [];
		track(
			client.runs.events(
				{ params: { id: runId } },
				{
					run: (view) => {
						expectTypeOf(view).toEqualTypeOf<RunView>();
						views.push(view);
					},
				},
			),
		);
		await eventually(() => expect(statusOf(views.at(-1), "a")).toBe("running"));

		await agent.succeed(a);
		const b = await agent.nextAssign();
		await eventually(() => {
			expect(statusOf(views.at(-1), "a")).toBe("success");
			expect(statusOf(views.at(-1), "b")).toBe("running");
		});
		await agent.succeed(b);
		await eventually(() => expect(views.at(-1)?.status).toBe("success"));

		expect(new Set(views.map((v) => v.id))).toEqual(new Set([runId]));
		expect(changes(views.map((v) => v.status))).toEqual(["running", "success"]);
		for (const node of ["a", "b"]) {
			const steps = views.map((v) => LIFECYCLE.indexOf(statusOf(v, node) ?? ""));
			expect(steps, node).toEqual(steps.toSorted((x, y) => x - y));
			expect(steps.at(-1), node).toBe(LIFECYCLE.indexOf("success"));
		}
	});

	it("从分页读到的位置订阅任务和运行的日志流，收到任务之后新写的日志", async () => {
		const { runId, task } = await startRun();
		agent.logs(task, [[1, "订阅之前写的"]]);
		await eventually(async () => {
			expect((await client.logs.page({ params: { id: task.taskId } })).last_seq).toBe(1);
		});
		const taskPage = await client.logs.page({ params: { id: task.taskId } });
		const runPage = await client.logs.runPage({ params: { id: runId } });

		const taskLines: string[] = [];
		const runLines: string[] = [];
		let opens = 0;
		const onOpen = () => opens++;
		track(
			client.logs.events(
				{ params: { id: task.taskId }, query: { after_seq: String(taskPage.last_seq) } },
				{ logs: (chunk) => taskLines.push(...chunk.lines.map((l) => l.text)) },
				{ onOpen },
			),
		);
		track(
			client.logs.runEvents(
				{ params: { id: runId }, query: { after: runPage.live_after } },
				{ logs: (chunk) => runLines.push(...chunk.lines.map((l) => l.text)) },
				{ onOpen },
			),
		);
		await eventually(() => expect(opens).toBe(2));

		agent.logs(task, [
			[2, "第二行"],
			[3, "第三行"],
		]);
		await eventually(() => {
			expect(taskLines).toEqual(["第二行", "第三行"]);
			expect(runLines).toEqual(["第二行", "第三行"]);
		});
	});

	it("中途断开后自动重连：重连请求带着最后一条消息的 id，断线期间和之后写的日志都到达，不丢也不重复；连上和每次重连各回调一次", async () => {
		const { task } = await startRun();
		const { proxy, client: viaProxy } = await proxied();
		const seqs: number[] = [];
		let opens = 0;
		track(
			viaProxy.logs.events(
				{ params: { id: task.taskId } },
				{ logs: (chunk) => seqs.push(...chunk.lines.map((l) => l.seq)) },
				{ onOpen: () => opens++ },
			),
		);
		await eventually(() => expect(opens).toBe(1));
		agent.logs(task, [
			[1, "一"],
			[2, "二"],
		]);
		await eventually(() => expect(seqs).toEqual([1, 2]));

		proxy.hold();
		proxy.cut();
		agent.logs(task, [
			[3, "三"],
			[4, "四"],
		]);
		await eventually(async () => {
			expect((await client.logs.page({ params: { id: task.taskId } })).last_seq).toBe(4);
		});
		await eventually(() => expect(proxy.requests).toHaveLength(2), RECONNECT_MS);
		expect(opens).toBe(1);
		proxy.release();
		await eventually(() => expect(opens).toBe(2));

		agent.logs(task, [[5, "五"]]);
		await eventually(() => expect(seqs).toEqual([1, 2, 3, 4, 5]));
		expect(proxy.requests.map((r) => r.headers["last-event-id"])).toEqual([undefined, "2"]);
		expect(opens).toBe(2);
	});

	it("运行的事件流没有消息 id：断开后重连不带 id，连上后先收到完整的运行视图，之后的变化继续到达", async () => {
		const { runId, task: a } = await startRun();
		const { proxy, client: viaProxy } = await proxied();
		const views: RunView[] = [];
		let opens = 0;
		track(
			viaProxy.runs.events(
				{ params: { id: runId } },
				{ run: (view) => views.push(view) },
				{ onOpen: () => opens++ },
			),
		);
		await eventually(() => expect(statusOf(views.at(-1), "a")).toBe("running"));

		proxy.hold();
		proxy.cut();
		await agent.succeed(a);
		const b = await agent.nextAssign();
		await eventually(() => expect(proxy.requests).toHaveLength(2), RECONNECT_MS);
		expect(statusOf(views.at(-1), "a")).toBe("running");
		proxy.release();
		await eventually(() => {
			expect(opens).toBe(2);
			expect(statusOf(views.at(-1), "b")).toBe("running");
		});

		await agent.succeed(b);
		await eventually(() => expect(views.at(-1)?.status).toBe("success"));
		expect(proxy.requests.map((r) => r.headers["last-event-id"])).toEqual([undefined, undefined]);
	});

	it("调用关闭函数后连接断开，之后不再收到事件，也不再重连；关闭函数可以重复调用", async () => {
		const { runId, task } = await startRun();
		const { proxy, client: viaProxy } = await proxied();
		const received: string[] = [];
		let opens = 0;
		const close = viaProxy.runs.events(
			{ params: { id: runId } },
			{ run: () => received.push("run"), progress: () => received.push("progress") },
			{ onOpen: () => opens++ },
		);
		await eventually(() => expect(received).toContain("run"));

		close();
		close();
		await eventually(() => expect(proxy.open).toBe(0));
		const seen = received.length;
		const progress: number[] = [];
		let witnessOpens = 0;
		track(
			client.runs.events(
				{ params: { id: runId } },
				{ progress: (event) => progress.push(event.progress.current) },
				{ onOpen: () => witnessOpens++ },
			),
		);
		await eventually(() => expect(witnessOpens).toBe(1));
		agent.progress(task, 1, 2);
		await eventually(() => expect(progress).toEqual([1]));
		await reconnectIntervalPassed(runId);

		expect(received).toHaveLength(seen);
		expect(proxy.requests).toHaveLength(1);
		expect(opens).toBe(1);
	});

	it("等待重连时关闭：不再重连", async () => {
		const { runId } = await startRun();
		const { proxy, client: viaProxy } = await proxied();
		let opens = 0;
		const close = viaProxy.runs.events({ params: { id: runId } }, {}, { onOpen: () => opens++ });
		await eventually(() => expect(opens).toBe(1));

		proxy.cut();
		await eventually(() => expect(proxy.open).toBe(0));
		close();
		await reconnectIntervalPassed(runId);

		expect(proxy.requests).toHaveLength(1);
		expect(opens).toBe(1);
	});

	it("控制面时间事件交给时间回调，不出现在处理函数里", async () => {
		const { runId } = await startRun();
		const received: string[] = [];
		let opens = 0;
		track(
			client.subscribe(
				runsApi.events,
				{ params: { id: runId } },
				{ time: () => received.push("time"), run: () => received.push("run") },
				{ onOpen: () => opens++ },
			),
		);
		await eventually(() => expect(received).toContain("run"));

		clock.advance(1_000);
		const later = clock.now().toISOString();
		await eventually(() => expect(controlPlaneTimes).toContain(later));
		expect(opens).toBe(1);
		expect(received).not.toContain("time");
	});

	it("控制面回 4xx 或响应不是事件流时停止订阅，回调 onError，不重连", async () => {
		const { runId } = await startRun();
		const { proxy, client: viaProxy } = await proxied();
		const errors: ApiError[] = [];
		let opens = 0;
		const options = { onOpen: () => opens++, onError: (error: ApiError) => errors.push(error) };
		track(viaProxy.runs.events({ params: { id: MISSING_RUN } }, {}, options));
		track(
			viaProxy.subscribe(
				{ method: "GET", path: "/runs/:id", kind: "stream" },
				{ params: { id: runId } },
				{},
				options,
			),
		);
		await eventually(() => expect(errors).toHaveLength(2));
		await reconnectIntervalPassed(runId);

		expect(errors.map((e) => [e.status, e.code, e.method, e.path]).sort()).toEqual([
			[200, "invalid_response", "GET", `/runs/${runId}`],
			[404, "not_found", "GET", `/runs/${MISSING_RUN}/events`],
		]);
		expect(proxy.requests).toHaveLength(2);
		expect(opens).toBe(0);
	});
});
