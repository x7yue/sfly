import type { Client, Unsubscribe } from "@sfly/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { observedClient, startClientControlPlane } from "./support/client.js";
import { eventually } from "./support/eventually.js";
import { type AssignedTask, FakeAgent } from "./support/fake-agent.js";
import { publishPackage } from "./support/package-archive.js";
import { type StreamingProxy, startStreamingProxy } from "./support/streaming-proxy.js";
import type { TestControlPlane } from "./support/test-control-plane.js";

// 事件流长时间没有新事件时，页面还收不收得到之后的事件（#672 第 4 条，#564 第 7 条）：会话页开着、一小时没有新事件之后再说一句话。
// 控制面每 15 秒发一条心跳（`SseOptions.heartbeatMs`，带控制面时间，也是为了不让反向代理断开空闲连接），页面读事件流的是 `@sfly/client`
// 的 `subscribe`。这里用真的控制面、真的客户端，中间放一个能掐空闲连接、能悄悄丢连接的代理，时间按比例缩小（心跳 50 毫秒，代理的空闲超时
// 400 毫秒，对应真实的 15 秒和 60 秒）。三种情形：
// 1. 代理的空闲超时比心跳间隔长（常见）：心跳让流从来不「空闲」，连接一直在同一条上；
// 2. 代理的空闲超时比心跳间隔短：每次空闲都被切，客户端自己重连，带最后一条消息的 id，空闲期间的事件补发、不丢不重复；
// 3. 中间设备悄悄丢了连接（休眠醒来、网络切换、NAT 表项过期：没有 FIN 也没有 RST，字节不再到）：客户端自己发现并重连。
//    读流的 `reader.read()` 没有超时，连接死了没有任何事件通知它；以前的客户端会永远等下去，页面再也收不到这一轮。

const AGENT = "agent-a";
const RECONNECT_TIMEOUT_MS = 15_000;

describe("事件流长时间没有新事件", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let agent: FakeAgent;
	let task: AssignedTask;
	const subscriptions: Unsubscribe[] = [];
	const proxies: StreamingProxy[] = [];

	const track = (close: Unsubscribe) => {
		subscriptions.push(close);
		return close;
	};
	const proxied = async (options: Parameters<typeof startStreamingProxy>[1] = {}) => {
		const proxy = await startStreamingProxy(cp.httpUrl, options);
		proxies.push(proxy);
		return { proxy, ...observedClient({ baseUrl: proxy.url }) };
	};

	async function start(heartbeatMs: number) {
		({ cp } = await startClientControlPlane({ sseHeartbeatMs: heartbeatMs }));
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: ["text"] });
		agent = await FakeAgent.connect(cp.grpcUrl, { name: AGENT });
		const scenarioId = await api.orchestrationWith({
			default_agent: AGENT,
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{ id: "a", kind: "package", package: "stub", node: "echo" },
			],
			edges: [{ from: "entry", to: "a", kind: "chain" }],
			packages: { stub: "1.0.0" },
		});
		await api.triggerOk(scenarioId);
		task = await agent.nextAssign();
	}

	afterEach(async () => {
		for (const close of subscriptions.splice(0)) close();
		await Promise.all(proxies.splice(0).map((p) => p.close()));
		await agent?.disconnect();
		await cp?.close();
	});

	/** 订阅任务的日志：返回收到的行号、连上的次数和一个等 N 行的函数。 */
	function watchLogs(via: Client, options: { stallMs?: number } = {}) {
		const seqs: number[] = [];
		const state = { opens: 0 };
		track(
			via.logs.events(
				{ params: { id: task.taskId } },
				{ logs: (chunk) => seqs.push(...chunk.lines.map((l) => l.seq)) },
				{ onOpen: () => state.opens++, ...options },
			),
		);
		return { seqs, state };
	}

	describe("代理的空闲超时比心跳间隔长", () => {
		beforeEach(() => start(50));

		it("心跳让流从来不空闲：空闲很久（代理空闲超时的好几倍）连接还是同一条，之后写的日志照常到达", async () => {
			const { proxy, client: viaProxy } = await proxied({ idleTimeoutMs: 400 });
			const { seqs, state } = watchLogs(viaProxy);
			await eventually(() => expect(state.opens).toBe(1));
			agent.logs(task, [[1, "一"]]);
			await eventually(() => expect(seqs).toEqual([1]));

			// 没有任何新事件，等代理的空闲超时过去四次。
			await new Promise((resolve) => setTimeout(resolve, 1_700));
			expect(proxy.requests, "没有重连：还是第一条连接").toHaveLength(1);
			expect(state.opens).toBe(1);

			agent.logs(task, [[2, "二"]]);
			await eventually(() => expect(seqs).toEqual([1, 2]));
			expect(proxy.requests).toHaveLength(1);
		});
	});

	describe("代理的空闲超时比心跳间隔短", () => {
		beforeEach(() => start(2_000));

		it("每次空闲都被切：客户端自己重连，带最后一条消息的 id，空闲期间写的日志补发，不丢不重复", async () => {
			const { proxy, client: viaProxy } = await proxied({ idleTimeoutMs: 100 });
			const { seqs, state } = watchLogs(viaProxy);
			await eventually(() => expect(state.opens).toBe(1));
			agent.logs(task, [
				[1, "一"],
				[2, "二"],
			]);
			await eventually(() => expect(seqs).toEqual([1, 2]));

			// 空闲：代理在 100 毫秒后切断连接（心跳 2 秒才一次）；断线期间写两行。
			await eventually(() => expect(proxy.inFlight).toBe(0));
			agent.logs(task, [
				[3, "三"],
				[4, "四"],
			]);
			await eventually(() => expect(state.opens).toBe(2), RECONNECT_TIMEOUT_MS);
			await eventually(() => expect(seqs).toEqual([1, 2, 3, 4]));

			// 又空闲、又被切、又重连：之后写的照常到。
			await eventually(() => expect(proxy.inFlight).toBe(0));
			agent.logs(task, [[5, "五"]]);
			await eventually(() => expect(state.opens).toBe(3), RECONNECT_TIMEOUT_MS);
			await eventually(() => expect(seqs).toEqual([1, 2, 3, 4, 5]));
			expect(proxy.requests.map((r) => r.headers["last-event-id"])).toEqual([undefined, "2", "4"]);
		}, 40_000);
	});

	describe("中间设备悄悄丢了连接", () => {
		beforeEach(() => start(50));

		it("没有 FIN 也没有 RST、字节不再到：连着一段时间什么都没收到（心跳也没有），客户端自己断开重连，带最后一条消息的 id，之后的日志照常到达", async () => {
			const { proxy, client: viaProxy } = await proxied();
			// 真实的默认是 45 秒（心跳 15 秒的三倍）；这里缩小。
			const { seqs, state } = watchLogs(viaProxy, { stallMs: 400 });
			await eventually(() => expect(state.opens).toBe(1));
			agent.logs(task, [
				[1, "一"],
				[2, "二"],
			]);
			await eventually(() => expect(seqs).toEqual([1, 2]));

			// 连接被悄悄丢了：控制面还在写（心跳、新日志），一个字节也到不了客户端；连接没有关。
			proxy.stall();
			agent.logs(task, [[3, "三（连接已经死了）"]]);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(seqs, "字节确实没有到").toEqual([1, 2]);

			await eventually(() => expect(state.opens).toBe(2), RECONNECT_TIMEOUT_MS);
			await eventually(() => expect(seqs).toEqual([1, 2, 3]));
			agent.logs(task, [[4, "四"]]);
			await eventually(() => expect(seqs).toEqual([1, 2, 3, 4]));
			expect(proxy.requests.map((r) => r.headers["last-event-id"])).toEqual([undefined, "2"]);
		}, 40_000);

		it("心跳一直在：不会被误当成死连接重连（阈值比心跳间隔长）；空闲很久之后写的日志照常到达", async () => {
			const { proxy, client: viaProxy } = await proxied();
			const { seqs, state } = watchLogs(viaProxy, { stallMs: 400 });
			await eventually(() => expect(state.opens).toBe(1));
			await new Promise((resolve) => setTimeout(resolve, 1_700));
			expect(state.opens).toBe(1);
			expect(proxy.requests).toHaveLength(1);
			agent.logs(task, [[1, "一"]]);
			await eventually(() => expect(seqs).toEqual([1]));
		});
	});
});
