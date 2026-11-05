import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import type { ManualClock } from "./support/manual-clock.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

interface EditorsEvent {
	orchestration_id: string;
	editors: { session_id: string; nickname: string }[];
}

const nicknames = (e: { data: EditorsEvent }) => e.data.editors.map((x) => x.nickname);

describe("在线编辑者", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let clock: ManualClock;
	const streams: SseClient[] = [];

	beforeAll(async () => {
		cp = await startTestControlPlane();
		api = new ApiClient(cp);
		clock = cp.clock as ManualClock;
	});
	afterEach(() => {
		for (const s of streams.splice(0)) s.close();
	});
	afterAll(async () => {
		await cp.close();
	});

	const subscribe = async (id: string) => {
		const sse = await SseClient.open(cp, `/orchestrations/${id}/presence/events`);
		streams.push(sse);
		return sse;
	};
	const heartbeat = (id: string, sessionId: string, nickname: string) =>
		api.post(`/orchestrations/${id}/presence`, { session_id: sessionId }, nickname);

	it("订阅时先收到当前在线编辑者，有人发心跳后推送变化", async () => {
		const id = await api.createOrchestration("在线-1");
		const sse = await subscribe(id);
		expect((await sse.next<EditorsEvent>("editors")).data).toEqual({
			orchestration_id: id,
			editors: [],
		});

		const res = await heartbeat(id, "s-alice", "alice");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			editors: [{ session_id: "s-alice", nickname: "alice" }],
		});
		expect(nicknames(await sse.next<EditorsEvent>("editors"))).toEqual(["alice"]);

		await heartbeat(id, "s-bob", "小明");
		expect(nicknames(await sse.next<EditorsEvent>("editors"))).toEqual(["alice", "小明"]);

		// 后来打开页面的人也能立即看到当前在线编辑者。
		const late = await subscribe(id);
		expect(nicknames(await late.next<EditorsEvent>("editors"))).toEqual(["alice", "小明"]);
	});

	it("持续心跳的编辑者一直在线；30 秒没有心跳就移除并推送", async () => {
		const id = await api.createOrchestration("在线-2");
		const sse = await subscribe(id);
		await sse.next("editors");

		await heartbeat(id, "s-alice", "alice");
		await heartbeat(id, "s-bob", "bob");
		await sse.next("editors");
		expect(nicknames(await sse.next<EditorsEvent>("editors"))).toEqual(["alice", "bob"]);

		// alice 每 10 秒一次心跳，bob 关掉了页面。心跳本身不改变名单，不推送。
		clock.advance(10_000);
		await heartbeat(id, "s-alice", "alice");
		clock.advance(10_000);
		await heartbeat(id, "s-alice", "alice");
		clock.advance(9_999);
		await sse.expectNone(150);

		clock.advance(1);
		const left = await sse.next<EditorsEvent>("editors");
		expect(left.data).toEqual({
			orchestration_id: id,
			editors: [{ session_id: "s-alice", nickname: "alice" }],
		});

		// alice 也停止心跳：最后一次心跳 30 秒后名单为空。
		clock.advance(20_000);
		expect((await sse.next<EditorsEvent>("editors")).data.editors).toEqual([]);
	});

	it("同一标签页改了昵称时推送新名单；不同编排的名单互不影响", async () => {
		const a = await api.createOrchestration("在线-3a");
		const b = await api.createOrchestration("在线-3b");
		const sseA = await subscribe(a);
		const sseB = await subscribe(b);
		await sseA.next("editors");
		await sseB.next("editors");

		await heartbeat(a, "s-1", "alice");
		expect(nicknames(await sseA.next<EditorsEvent>("editors"))).toEqual(["alice"]);
		await heartbeat(a, "s-1", "爱丽丝");
		expect(nicknames(await sseA.next<EditorsEvent>("editors"))).toEqual(["爱丽丝"]);
		await sseB.expectNone(100);
	});

	it("关闭页面时主动离开：立即从名单移除并推送；未知会话忽略", async () => {
		const id = await api.createOrchestration("在线-leave");
		const sse = await subscribe(id);
		await sse.next("editors");
		await heartbeat(id, "s-alice", "alice");
		await heartbeat(id, "s-bob", "bob");
		await sse.next("editors");
		expect(nicknames(await sse.next<EditorsEvent>("editors"))).toEqual(["alice", "bob"]);

		const leave = (sessionId: string) =>
			cp.fetch(`/orchestrations/${id}/presence/leave`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ session_id: sessionId }),
			});
		expect((await leave("s-bob")).status).toBe(204);
		expect(nicknames(await sse.next<EditorsEvent>("editors"))).toEqual(["alice"]);
		// 重复离开、未知会话：不报错，也不推送。
		expect((await leave("s-bob")).status).toBe(204);
		expect((await leave("s-nobody")).status).toBe(204);
		await sse.expectNone(100);
	});

	it("心跳需要昵称和 session_id；编排不存在时 404", async () => {
		const id = await api.createOrchestration("在线-4");
		const noNickname = await cp.fetch(`/orchestrations/${id}/presence`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ session_id: "s" }),
		});
		expect(noNickname.status).toBe(400);
		expect(await noNickname.json()).toMatchObject({ error: { code: "nickname_required" } });

		const noSession = await api.post(`/orchestrations/${id}/presence`, {}, "alice");
		expect(noSession.status).toBe(400);
		expect(await noSession.json()).toMatchObject({ error: { code: "invalid_request" } });

		const missing = "00000000-0000-4000-8000-000000000000";
		const res = await heartbeat(missing, "s", "alice");
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
		const events = await cp.fetch(`/orchestrations/${missing}/presence/events`);
		expect(events.status).toBe(404);
		expect((await cp.fetch("/orchestrations/not-a-uuid/presence/events")).status).toBe(404);
	});

	it("在线编辑者只在内存中：控制面重启时 SSE 流结束，重启后名单为空", async () => {
		const id = await api.createOrchestration("在线-5");
		const sse = await subscribe(id);
		await sse.next("editors");
		await heartbeat(id, "s-1", "alice");
		await sse.next("editors");

		await cp.restart();
		await expect(sse.next("editors")).rejects.toThrow(/ended/);

		const again = await subscribe(id);
		expect((await again.next<EditorsEvent>("editors")).data.editors).toEqual([]);
	});
});
