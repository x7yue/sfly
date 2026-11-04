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
});
