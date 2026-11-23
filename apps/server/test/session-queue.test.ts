// 助手会话的打断、插话和排队（#544 控制面那一半）：停止排队中的会话、在做时说话是插话、结束会话、同一个项目一次只跑一轮
// 其余排队（按排队的先后轮流开始）、旧的一轮过一会儿才结束时新的一轮不回 409、重启之后接着开始排队的。
// 真实控制面 + 真实数据库 + 进程内的假助手服务（support/fake-assistant.ts，`strictTurns` 开着时按协议「一轮的状态」回应）。
import { randomUUID } from "node:crypto";
import type {
	AssistantEvent,
	PersistedSessionEvent,
	SessionDetailResponse,
	SessionListResponse,
	SessionView,
} from "@sfly/schema";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { FakeAssistant } from "./support/fake-assistant.js";
import type { ManualClock } from "./support/manual-clock.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const WORKBENCH = "workbench-a";
const USAGE = { input: 10, output: 5, cache_read: 0, cache_write: 0 };
const turnEnd = (turn: number, outcome: "completed" | "stopped" = "completed"): AssistantEvent => ({
	type: "turn_end",
	turn,
	outcome,
	reason: "测试",
	steps: 1,
	model_calls: 1,
	duration_ms: 1000,
	usage: USAGE,
});

/** 一个会话的当前行（直接读库）。 */
async function row(cp: TestControlPlane, id: string) {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		const { rows } = await client.query("select * from sessions where id = $1", [id]);
		return rows[0] as
			| { status: string; queued_at: Date | null; current_turn: number; title: string }
			| undefined;
	} finally {
		await client.end();
	}
}

/** 直接改库。 */
async function database_query(cp: TestControlPlane, text: string, params: unknown[] = []) {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		await client.query(text, params);
	} finally {
		await client.end();
	}
}

const statusOf = async (cp: TestControlPlane, id: string) => (await row(cp, id))?.status;

describe("停止、插话、结束会话、排队", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let assistant: FakeAssistant;
	let workbench: FakeAgent;

	beforeAll(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
		});
		api = new ApiClient(cp);
		workbench = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
			{ clock: cp.clock },
		);
		await assistant.connected();
	}, 60_000);

	afterAll(async () => {
		await workbench?.disconnect();
		await cp?.close();
		await assistant?.close();
	});

	beforeEach(async () => {
		// 后台正在开始的排队中的会话做完，再清库、清假助手服务。
		await cp.current.sessionService.idle();
		const client = new pg.Client({ connectionString: cp.database.url });
		await client.connect();
		try {
			await client.query("delete from sessions");
		} finally {
			await client.end();
		}
		assistant.prompts.length = 0;
		assistant.aborts.length = 0;
		assistant.abortRequests.length = 0;
		assistant.abortMarks.clear();
		assistant.abortAttempts = 0;
		assistant.steers.length = 0;
		assistant.ends.length = 0;
		assistant.endedByAbort.length = 0;
		assistant.promptReply = () => undefined;
		assistant.abortReply = () => undefined;
		assistant.steerReply = () => undefined;
		assistant.endReply = () => undefined;
		assistant.stopSettleMs = 0;
		assistant.endDelayMs = 0;
		assistant.abortDelayMs = 0;
		assistant.promptDelayMs = 0;
		assistant.log.length = 0;
		assistant.strictTurns = true;
		assistant.health = () => assistant.healthy();
	});

	/** 控制面的时钟是手动的：每次建会话、说话之后走一秒，排队的先后（`queued_at`）才分得出来。 */
	const tick = () => (cp.clock as ManualClock).advance(1_000);
	const create = async (text: string, nickname = "alice") => {
		const res = await api.post("/projects/default/sessions", { text }, nickname);
		tick();
		return res;
	};
	const view = async (id: string) => json<SessionView>(await api.get(`/sessions/${id}`));
	const detail = async (id: string) =>
		json<SessionDetailResponse>(await api.get(`/sessions/${id}`));
	const types = async (id: string) => (await detail(id)).events.map((e) => e.type);
	const say = async (id: string, text: string, nickname = "alice") => {
		const res = await api.post(`/sessions/${id}/messages`, { text }, nickname);
		tick();
		return res;
	};

	/** 建一个会话并让它做完它的第一轮（空闲）。 */
	const idleSession = async (text = "先做一件事") => {
		const created = await json<SessionView>(await create(text));
		assistant.emit(created.id, 1, turnEnd(1));
		await eventually(async () => expect(await statusOf(cp, created.id)).toBe("idle"));
		return created;
	};

	describe("插话：在做时说的话", () => {
		it("在做时说话不再是 409：写 user_message（steer: true，发话人是说话的人），交给助手服务的 steer（带这句话的 ID）；响应的类型不变", async () => {
			const first = await json<SessionView>(await create("做第一件事"));
			const res = await say(first.id, "先别改测试", "bob");
			expect(res.status).toBe(200);
			const { seq } = await json<{ seq: number }>(res);
			const events = (await detail(first.id)).events;
			expect(events.map((e) => [e.seq, e.type])).toEqual([
				[1, "user_message"],
				[2, "turn_started"],
				[3, "user_message"],
			]);
			expect(events[2]).toMatchObject({
				seq,
				text: "先别改测试",
				steer: true,
				author: "bob",
			});
			expect(assistant.steers).toHaveLength(1);
			expect(assistant.steers[0]).toMatchObject({
				sessionId: first.id,
				body: {
					turn: 1,
					text: "先别改测试",
					message_id: (events[2] as { message_id: string }).message_id,
				},
			});
			// 没有开始新的一轮：助手服务只收到过一次 prompt，会话还在做第 1 轮。
			expect(assistant.prompts).toHaveLength(1);
			expect(await row(cp, first.id)).toMatchObject({ status: "running", current_turn: 1 });
		});

		it("连着发两句：各是一条 user_message（steer: true）、各一次 steer，按先后", async () => {
			const first = await json<SessionView>(await create("做第一件事"));
			expect((await say(first.id, "先别改测试")).status).toBe(200);
			expect((await say(first.id, "再加一条日志")).status).toBe(200);
			expect(assistant.steers.map((s) => s.body.text)).toEqual(["先别改测试", "再加一条日志"]);
			const ids = new Set(assistant.steers.map((s) => s.body.message_id));
			expect(ids.size).toBe(2);
			expect((await types(first.id)).filter((t) => t === "user_message")).toHaveLength(3);
		});

		it("助手服务说没有可以送到的一轮（409 no_turn_running：这一轮刚好结束了）：写一条 steer_dropped 的提示（带这句话的 message_id），不重试、不开始新的一轮；响应仍是 200", async () => {
			const first = await json<SessionView>(await create("做第一件事"));
			assistant.steerReply = () => ({
				status: 409,
				code: "no_turn_running",
				message: "没有可以送到的一轮",
			});
			const res = await say(first.id, "来得太晚的话");
			expect(res.status).toBe(200);
			const events = (await detail(first.id)).events;
			const said = events.find((e) => e.type === "user_message" && e.steer);
			const notice = events.find((e) => e.type === "notice");
			expect(notice).toMatchObject({
				kind: "steer_dropped",
				message: expect.stringContaining("没有送到"),
				message_id: (said as { message_id: string }).message_id,
			});
			// 没有重试，也没有开始新的一轮。
			expect(assistant.steers).toHaveLength(1);
			expect(assistant.prompts).toHaveLength(1);
		});

		it("助手服务连不上：写 steer_dropped 的提示，响应 503 assistant_unavailable；这句话已经在时间线上", async () => {
			const first = await json<SessionView>(await create("做第一件事"));
			await assistant.stop();
			try {
				const res = await say(first.id, "没人听的话");
				expect(res.status).toBe(503);
				expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
					"assistant_unavailable",
				);
			} finally {
				await assistant.resume();
				await assistant.connected();
			}
			const events = (await detail(first.id)).events;
			expect(events.filter((e) => e.type === "user_message")).toHaveLength(2);
			// 结果未知（连不上也可能是命令送到之后断了）：写「没有确认送到」，不写「没有送到」。
			expect(events.find((e) => e.type === "notice")).toMatchObject({
				kind: "steer_dropped",
				message: expect.stringContaining("没有确认送到"),
			});
		});

		it("这一轮刚结束（会话已经空闲）：这句话开始新的一轮，不是插话", async () => {
			const first = await idleSession();
			const res = await say(first.id, "接着做");
			expect(res.status).toBe(200);
			expect(assistant.steers).toHaveLength(0);
			expect(assistant.prompts.at(-1)?.body).toMatchObject({ turn: 2, text: "接着做" });
			const events = (await detail(first.id)).events;
			expect(events.filter((e) => e.type === "user_message").at(-1)).toMatchObject({
				steer: false,
			});
		});

		it("已结束的会话发话 409 session_ended，不交给助手服务", async () => {
			const first = await idleSession();
			expect((await api.post(`/sessions/${first.id}/end`, {})).status).toBe(200);
			const res = await say(first.id, "还能说吗");
			expect(res.status).toBe(409);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe("session_ended");
		});
	});

	describe("插话的结局（协议「插话」的不变式）", () => {
		/** 用户说的插话（steer: true）的 message_id，按说的先后。 */
		const steerIds = async (id: string) =>
			(await detail(id)).events
				.filter((e) => e.type === "user_message" && e.steer)
				.map((e) => (e as { message_id: string }).message_id);
		const queue = (id: string, turn: number, ids: string[], texts: string[]) =>
			assistant.emit(id, turn, {
				type: "steer_queue",
				messages: ids.map((message_id, i) => ({ message_id, text: texts[i] ?? "" })),
			});

		it("steer 命令带这句话是对第几轮说的：第 2 轮在做时是 2", async () => {
			const first = await idleSession();
			await say(first.id, "接着做");
			expect(assistant.prompts.at(-1)?.body.turn).toBe(2);
			expect((await say(first.id, "再补一句")).status).toBe(200);
			expect(assistant.steers.at(-1)?.body).toMatchObject({ turn: 2, text: "再补一句" });
		});

		it("控制面自己补结局（助手服务收下了中止、却没有带回结局）：这一轮里没有确认送到、也没有 steer_dropped 的插话各补一条，排在补的 turn_end 前面；确认送到的不补", async () => {
			assistant.strictTurns = false;
			const first = await json<SessionView>(await create("做第一件事"));
			for (const text of ["甲", "乙", "丙", "丁"])
				expect((await say(first.id, text)).status).toBe(200);
			const [a, b, c, d] = await steerIds(first.id);
			expect([a, b, c, d].every(Boolean)).toBe(true);
			// 助手服务的队列：四句都出现过，之后甲不在了（确认送到）。丁从没有出现在任何一份队列里（刚收下就不回话了）。
			queue(first.id, 1, [a as string, b as string, c as string], ["甲", "乙", "丙"]);
			queue(first.id, 1, [b as string, c as string], ["乙", "丙"]);
			await new Promise((resolve) => setTimeout(resolve, 50));
			// 助手服务收下了中止、没有带回结局：等宽限（测试里 300 毫秒）之后控制面自己补。
			const stopped = await api.postEmpty(`/sessions/${first.id}/stop`);
			expect(stopped.status).toBe(200);
			const events = (await detail(first.id)).events;
			const dropped = events.filter((e) => e.type === "notice" && e.kind === "steer_dropped");
			expect(dropped.map((e) => (e as { message_id: string }).message_id)).toEqual([b, c, d]);
			for (const e of dropped) {
				expect((e as { message: string }).message).toContain("没有确认送到");
			}
			// 顺序：用户的话、（插话各自的）、乙丙丁的 steer_dropped，最后是补的 turn_end。
			const tail = events.slice(-4).map((e) => e.type);
			expect(tail).toEqual(["notice", "notice", "notice", "turn_end"]);
			expect(events.at(-1)).toMatchObject({ type: "turn_end", outcome: "stopped" });
			// 助手服务晚到的 steer_dropped 和 turn_end：这一轮已经结束，丢掉，不重复。
			assistant.emit(first.id, 1, {
				type: "notice",
				kind: "steer_dropped",
				message: "晚到的",
				message_id: b as string,
			});
			assistant.emit(first.id, 1, turnEnd(1, "stopped"));
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect((await detail(first.id)).events).toHaveLength(events.length);
		});

		it("已经有 steer_dropped 的插话（助手服务回 409 时控制面写过，或者助手服务发过）不再补第二条", async () => {
			assistant.strictTurns = false;
			const first = await json<SessionView>(await create("做第一件事"));
			assistant.steerReply = () => ({ status: 409, code: "no_turn_running", message: "刚好结束" });
			expect((await say(first.id, "来得太晚")).status).toBe(200);
			assistant.steerReply = () => undefined;
			expect((await say(first.id, "助手服务收下了")).status).toBe(200);
			const [late, accepted] = await steerIds(first.id);
			// 助手服务自己发了第二句的 steer_dropped（持久，核对通过），之后停止、控制面补结局。
			assistant.emit(first.id, 1, {
				type: "notice",
				kind: "steer_dropped",
				message: "没有送到：「助手服务收下了」",
				message_id: accepted as string,
			});
			await eventually(async () =>
				expect(
					(await detail(first.id)).events.filter(
						(e) => e.type === "notice" && e.kind === "steer_dropped",
					),
				).toHaveLength(2),
			);
			expect((await api.postEmpty(`/sessions/${first.id}/stop`)).status).toBe(200);
			const dropped = (await detail(first.id)).events.filter(
				(e) => e.type === "notice" && e.kind === "steer_dropped",
			);
			expect(dropped.map((e) => (e as { message_id: string }).message_id).sort()).toEqual(
				[late as string, accepted as string].sort(),
			);
		});

		it("补结局只管这一轮的插话：更早的一轮里确认送到的插话，下一轮由控制面补结局时不会被补成没有送到", async () => {
			assistant.strictTurns = false;
			const first = await json<SessionView>(await create("做第一件事"));
			expect((await say(first.id, "第一轮的插话")).status).toBe(200);
			const [early] = await steerIds(first.id);
			// 第一轮：这句话出现在助手服务的队列里、之后又不在了（确认送到），助手服务带回结局。
			queue(first.id, 1, [early as string], ["第一轮的插话"]);
			queue(first.id, 1, [], []);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assistant.emit(first.id, 1, turnEnd(1));
			await eventually(async () => expect(await statusOf(cp, first.id)).toBe("idle"));
			// 第二轮：新的一句插话没有确认送到，停止、控制面补结局。
			expect((await say(first.id, "接着做")).status).toBe(200);
			expect((await say(first.id, "第二轮的插话")).status).toBe(200);
			const ids = await steerIds(first.id);
			expect(ids).toHaveLength(2);
			expect((await api.postEmpty(`/sessions/${first.id}/stop`)).status).toBe(200);
			const dropped = (await detail(first.id)).events.filter(
				(e) => e.type === "notice" && e.kind === "steer_dropped",
			);
			expect(dropped.map((e) => (e as { message_id: string }).message_id)).toEqual([ids[1]]);
		});

		it("控制面写更早一轮的重复结局，不清掉当前这一轮「确认送到」的记录：之后由控制面补当前这一轮的结局时，已经确认送到的话不会被补成没有确认送到", async () => {
			assistant.strictTurns = false;
			const first = await idleSession();
			expect((await say(first.id, "接着做")).status).toBe(200); // 第 2 轮
			expect((await say(first.id, "第二轮的插话")).status).toBe(200);
			const [id] = await steerIds(first.id);
			// 助手服务的队列：出现过、之后又不在了（确认送到）。
			queue(first.id, 2, [id as string], ["第二轮的插话"]);
			queue(first.id, 2, [], []);
			await new Promise((resolve) => setTimeout(resolve, 100));
			// 第 1 轮的重复结局（比如第 1 轮的 prompt 超时、补结局晚了）：这一轮早就结束了，写它不动第 2 轮的记录。
			await cp.current.sessions.appendTurnEnd(first.id, {
				type: "turn_end",
				turn: 1,
				outcome: "failed",
				reason: "重复的",
				steps: 0,
				model_calls: 0,
				duration_ms: 0,
			});
			expect(await statusOf(cp, first.id)).toBe("running");
			expect((await api.postEmpty(`/sessions/${first.id}/stop`)).status).toBe(200);
			const dropped = (await detail(first.id)).events.filter(
				(e) => e.type === "notice" && e.kind === "steer_dropped",
			);
			expect(dropped).toEqual([]);
		});

		it("同一个会话上同时点两次停止，助手服务都没有带回结局：每句没有确认送到的插话只有一条 steer_dropped，结局只有一条", async () => {
			assistant.strictTurns = false;
			const first = await json<SessionView>(await create("做第一件事"));
			expect((await say(first.id, "没人理的话")).status).toBe(200);
			const [id] = await steerIds(first.id);
			const stops = await Promise.all([
				api.postEmpty(`/sessions/${first.id}/stop`),
				api.postEmpty(`/sessions/${first.id}/stop`),
			]);
			expect(stops.map((r) => r.status)).toEqual([200, 200]);
			const events = (await detail(first.id)).events;
			const dropped = events.filter((e) => e.type === "notice" && e.kind === "steer_dropped");
			expect(dropped.map((e) => (e as { message_id: string }).message_id)).toEqual([id]);
			expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
		});

		it("助手服务带回了结局：控制面不替它补 steer_dropped（它自己发的在 turn_end 前面）", async () => {
			const first = await json<SessionView>(await create("做第一件事"));
			expect((await say(first.id, "甲")).status).toBe(200);
			expect((await say(first.id, "乙")).status).toBe(200);
			// 严格的假助手服务：收到中止时没送到的两句各发一条 steer_dropped，再发 turn_end（协议「停止一轮」第 4、5 步）。
			expect((await api.postEmpty(`/sessions/${first.id}/stop`)).status).toBe(200);
			const events = (await detail(first.id)).events;
			const dropped = events.filter((e) => e.type === "notice" && e.kind === "steer_dropped");
			expect(dropped).toHaveLength(2);
			expect(events.at(-1)).toMatchObject({ type: "turn_end", outcome: "stopped" });
			expect((events.at(-1) as { reason: string }).reason).toContain("助手服务按中止结束");
			// 控制面没有补：每句话只有一条 steer_dropped，没有写「没有确认送到」。
			for (const e of dropped) {
				expect((e as { message: string }).message).not.toContain("没有确认送到");
			}
		});

		it("这一轮的 prompt 还没有得到 202 时，这期间说的插话先留着、不转发（user_message 照常写）；prompt 被明确拒绝（503）：留着的话各写一条「没有送到」的 steer_dropped，排在失败的 turn_end 前面，助手服务没有收到过插话", async () => {
			const first = await idleSession();
			// prompt 慢（模拟冷启动）：这期间用户又说了两句；之后 prompt 被拒绝，控制面补失败的结局。
			assistant.promptDelayMs = 400;
			assistant.promptReply = () => ({
				status: 503,
				code: "model_not_configured",
				message: "没配模型",
			});
			const handing = say(first.id, "接着做");
			await eventually(async () => expect(assistant.prompts).toHaveLength(2));
			expect((await say(first.id, "甲")).status).toBe(200);
			expect((await say(first.id, "乙")).status).toBe(200);
			// 留着：没有转发。
			expect(assistant.steers).toHaveLength(0);
			expect((await handing).status).toBe(503);
			await eventually(async () => expect(await statusOf(cp, first.id)).toBe("idle"));
			const events = (await detail(first.id)).events;
			const [a, b] = events
				.filter((e) => e.type === "user_message" && e.steer)
				.map((e) => (e as { message_id: string }).message_id);
			const dropped = events.filter((e) => e.type === "notice" && e.kind === "steer_dropped");
			expect(dropped.map((e) => (e as { message_id: string }).message_id)).toEqual([a, b]);
			// 一定没有开始：写「没有送到」，不是「没有确认送到」。
			for (const e of dropped) {
				expect((e as { message: string }).message).not.toContain("没有确认送到");
			}
			expect(events.at(-1)).toMatchObject({
				type: "turn_end",
				turn: 2,
				outcome: "model_unavailable",
			});
			expect(events.at(-2)).toMatchObject({ type: "notice", message_id: b });
			expect(assistant.steers).toHaveLength(0);
			// 没有补发中止：这一轮一定没有开始。
			expect(assistant.abortAttempts).toBe(0);
		});

		it("prompt 拿到 202 之后才转发这一轮的插话，按说的先后；转发期间新来的接在后面", async () => {
			const first = await idleSession();
			assistant.promptDelayMs = 400;
			const handing = say(first.id, "接着做");
			await eventually(async () => expect(assistant.prompts).toHaveLength(2));
			expect((await say(first.id, "甲")).status).toBe(200);
			expect((await say(first.id, "乙")).status).toBe(200);
			expect(assistant.steers).toHaveLength(0);
			expect((await handing).status).toBe(200);
			expect(assistant.steers.map((s) => [s.body.turn, s.body.text])).toEqual([
				[2, "甲"],
				[2, "乙"],
			]);
			// 先 prompt、后两条 steer（按说的先后）。
			expect(assistant.log.filter((entry) => entry.endsWith(first.id)).slice(-3)).toEqual([
				`prompt:${first.id}`,
				`steer:${first.id}`,
				`steer:${first.id}`,
			]);
			// 之后新来的插话直接转发。
			expect((await say(first.id, "丙")).status).toBe(200);
			expect(assistant.steers.map((s) => s.body.text)).toEqual(["甲", "乙", "丙"]);
		});

		it("一轮的 turn_end 写下之后不再为这一轮的插话写 steer_dropped：控制面补完结局之后，还在路上的插话命令失败了也不写（不会落在 turn_end 后面，更不会落进下一轮）", async () => {
			assistant.strictTurns = false;
			const first = await json<SessionView>(await create("做第一件事"));
			assistant.steerDelayMs = 700;
			assistant.steerReply = () => ({ status: 500, code: "start_failed", message: "出错了" });
			const saying = say(first.id, "在路上的插话");
			await eventually(async () => expect(assistant.steers).toHaveLength(1));
			// 同时停止：助手服务不带回结局，等到期（测试里 300 毫秒）控制面补结局，之前为这句话补一条「没有确认送到」。
			expect((await api.postEmpty(`/sessions/${first.id}/stop`)).status).toBe(200);
			expect((await saying).status).toBe(503);
			const events = (await detail(first.id)).events;
			expect(events.filter((e) => e.type === "notice" && e.kind === "steer_dropped")).toHaveLength(
				1,
			);
			expect(events.at(-1)).toMatchObject({ type: "turn_end", outcome: "stopped" });
			// 下一轮开始：这一轮的插话命令早就有了结果，没有东西再落进来。
			assistant.steerDelayMs = 0;
			assistant.steerReply = () => undefined;
			expect((await say(first.id, "下一轮")).status).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(
				(await detail(first.id)).events.filter(
					(e) => e.type === "notice" && e.kind === "steer_dropped",
				),
			).toHaveLength(1);
		});
	});

	describe("停止的等待从发出 abort 起算", () => {
		it("助手服务过了宽限才带回结局，但从收到回应算还在宽限之内：控制面已经按发出 abort 起算到点，自己补结局；晚到的 turn_end 丢掉", async () => {
			assistant.strictTurns = false;
			const first = await json<SessionView>(await create("做第一件事"));
			// 测试里的宽限是 300 毫秒：abort 的回应 400 毫秒才到（已经过了宽限），助手服务在回应之后 100 毫秒才带回结局。
			assistant.abortDelayMs = 400;
			try {
				const stopping = api.postEmpty(`/sessions/${first.id}/stop`);
				setTimeout(() => assistant.emit(first.id, 1, turnEnd(1, "stopped")), 500);
				expect((await stopping).status).toBe(200);
				await new Promise((resolve) => setTimeout(resolve, 300));
			} finally {
				assistant.abortDelayMs = 0;
			}
			const ends = (await detail(first.id)).events.filter((e) => e.type === "turn_end");
			expect(ends).toHaveLength(1);
			// 是控制面补的，不是助手服务带回的（助手服务的 reason 是「测试」）。
			expect((ends[0] as { reason: string }).reason).toContain("没有及时带回");
			expect(await statusOf(cp, first.id)).toBe("idle");
		});

		it("助手服务在宽限之内带回结局：不补，用助手服务的", async () => {
			assistant.strictTurns = false;
			const first = await json<SessionView>(await create("做第一件事"));
			const stopping = api.postEmpty(`/sessions/${first.id}/stop`);
			setTimeout(() => assistant.emit(first.id, 1, turnEnd(1, "stopped")), 100);
			expect((await stopping).status).toBe(200);
			const ends = (await detail(first.id)).events.filter((e) => e.type === "turn_end");
			expect(ends).toHaveLength(1);
			expect((ends[0] as { reason: string }).reason).toBe("测试");
		});
	});

	describe("结束会话的先后：先停止并等到结局，再写 session_ended，写下之后才发 end", () => {
		it("end 在路上时 session_ended 已经写下：会话已经是 ended，这个窗口里说话 409，不会再开始新的一轮", async () => {
			const first = await idleSession();
			assistant.endDelayMs = 300;
			try {
				const ending = api.post(`/sessions/${first.id}/end`, {});
				await eventually(async () => expect(assistant.ends).toEqual([first.id]));
				// `end` 已经到了助手服务（它还没回应）：会话此刻已经结束，session_ended 已经写下。
				expect(await statusOf(cp, first.id)).toBe("ended");
				expect(await types(first.id)).toContain("session_ended");
				// 这个窗口里说话：409 session_ended，不交给助手服务（助手服务不记得会话结束了，所以控制面不能再发 prompt）。
				const said = await say(first.id, "还能说吗");
				expect(said.status).toBe(409);
				expect((await json<{ error: { code: string } }>(said)).error.code).toBe("session_ended");
				expect(assistant.prompts).toHaveLength(1);
				expect((await ending).status).toBe(200);
			} finally {
				assistant.endDelayMs = 0;
			}
			expect(await statusOf(cp, first.id)).toBe("ended");
		});

		it("在做的会话：先 abort 并等到这一轮的结局，再写 session_ended，写下之后才发 end", async () => {
			const first = await json<SessionView>(await create("做第一件事"));
			assistant.endDelayMs = 200;
			try {
				const ending = api.post(`/sessions/${first.id}/end`, {});
				await eventually(async () => expect(assistant.ends).toEqual([first.id]));
				// `end` 到助手服务的时候，这一轮的结局和 session_ended 已经都写下了，先后是结局、session_ended。
				const events = (await detail(first.id)).events.map((e) => e.type);
				expect(events.slice(-2)).toEqual(["turn_end", "session_ended"]);
				expect(assistant.log.filter((entry) => entry.endsWith(first.id))).toEqual([
					`prompt:${first.id}`,
					`abort:${first.id}`,
					`end:${first.id}`,
				]);
				expect((await ending).status).toBe(200);
			} finally {
				assistant.endDelayMs = 0;
			}
		});

		it("end 发不出去（助手服务连不上）：会话照样结束", async () => {
			const first = await idleSession();
			assistant.endReply = () => ({ status: 503, code: "start_failed", message: "出错了" });
			expect((await api.post(`/sessions/${first.id}/end`, {})).status).toBe(200);
			expect(await statusOf(cp, first.id)).toBe("ended");
		});
	});

	describe("停止途中说的话（控制面发出 abort 之后、这一轮的结局写下之前）：是新的一轮的开头，排在这一轮后面，不是插话", () => {
		it("写 user_message（steer 为 false）、不转发给助手服务，会话仍在做但有排队的位置；再说一句 409 session_queued；这一轮的结局写下之后开始它，交给助手服务的是这句话", async () => {
			assistant.strictTurns = false;
			const first = await json<SessionView>(await create("第一件事"));
			assistant.abortDelayMs = 150; // 中止还在路上
			const stopping = api.postEmpty(`/sessions/${first.id}/stop`);
			await eventually(async () => expect(assistant.aborts).toEqual([first.id]));
			const said = await say(first.id, "停下来之后的话");
			expect(said.status).toBe(200);
			expect(assistant.steers).toHaveLength(0);
			const spoken = (await detail(first.id)).events
				.filter((e) => e.type === "user_message")
				.at(-1);
			expect(spoken).toMatchObject({ text: "停下来之后的话", steer: false });
			expect(await view(first.id)).toMatchObject({ status: "running", queue_position: 1 });
			expect((await row(cp, first.id))?.queued_at).toBeInstanceOf(Date);
			const again = await say(first.id, "再说一句");
			expect(again.status).toBe(409);
			expect((await json<{ error: { code: string } }>(again)).error.code).toBe("session_queued");
			expect((await stopping).status).toBe(200);
			await eventually(async () =>
				expect(assistant.prompts.at(-1)).toMatchObject({
					sessionId: first.id,
					body: { turn: 2, text: "停下来之后的话" },
				}),
			);
			expect((await detail(first.id)).events.map((e) => e.type)).toEqual([
				"user_message",
				"turn_started",
				"user_message",
				"turn_end",
				"turn_started",
			]);
			expect(await row(cp, first.id)).toMatchObject({
				status: "running",
				current_turn: 2,
				queued_at: null,
			});
		});

		it("按说话的时刻排，不插队：项目里已经有别的会话在排，它排在那个会话后面；页面的排位也这样算", async () => {
			assistant.strictTurns = false;
			const a = await json<SessionView>(await create("甲的事", "alice"));
			const b = await json<SessionView>(await create("乙的事", "bob")); // 排队，第 1 位
			assistant.abortDelayMs = 150;
			const stopping = api.postEmpty(`/sessions/${a.id}/stop`);
			await eventually(async () => expect(assistant.aborts).toEqual([a.id]));
			expect((await say(a.id, "甲接着做", "alice")).status).toBe(200);
			expect(await view(a.id)).toMatchObject({ status: "running", queue_position: 2 });
			expect(await view(b.id)).toMatchObject({ status: "queued", queue_position: 1 });
			const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
			expect(list.sessions.find((x) => x.id === a.id)).toMatchObject({ queue_position: 2 });
			expect(list.sessions.find((x) => x.id === b.id)).toMatchObject({ queue_position: 1 });
			expect((await stopping).status).toBe(200);
			// 甲的这一轮结束：乙先开始，甲接着排（第 1 位，在等乙）。
			await eventually(() =>
				expect(assistant.prompts.map((p) => p.sessionId)).toEqual([a.id, b.id]),
			);
			await eventually(async () =>
				expect(await view(a.id)).toMatchObject({
					status: "queued",
					queue_position: 1,
					waiting_for: { session_id: b.id },
				}),
			);
			// 乙这一轮结束，甲的话开始。
			assistant.emit(b.id, 1, turnEnd(1));
			await eventually(() =>
				expect(assistant.prompts.at(-1)).toMatchObject({
					sessionId: a.id,
					body: { turn: 2, text: "甲接着做" },
				}),
			);
		});

		it("在做、却有排队时间的会话（停止途中说了话，控制面重启之后内存里「正在停止」的标记没了）：再说话仍是 409 session_queued，不是插话；也不收插话", async () => {
			const first = await json<SessionView>(await create("第一件事"));
			await database_query(cp, "update sessions set queued_at = now() where id = $1", [first.id]);
			const again = await say(first.id, "再说一句");
			expect(again.status).toBe(409);
			expect((await json<{ error: { code: string } }>(again)).error.code).toBe("session_queued");
			expect(assistant.steers).toHaveLength(0);
			expect((await types(first.id)).filter((t) => t === "user_message")).toHaveLength(1);
			// 存储层也不收插话：写在排着的话后面的话，下一轮取到的就是它。
			expect(
				await cp.current.sessions.steer(first.id, {
					type: "user_message",
					message_id: randomUUID(),
					text: "插话",
					steer: true,
					author: "alice",
					author_user_id: null,
				}),
			).toMatchObject({ steered: false, status: "running" });
		});

		it("停止途中说了话、又结束会话：这句话按排队中的话处理（queue_cancelled），再写 session_ended", async () => {
			assistant.strictTurns = false;
			const first = await json<SessionView>(await create("第一件事"));
			assistant.abortDelayMs = 100;
			const ending = api.post(`/sessions/${first.id}/end`, {});
			await eventually(async () => expect(assistant.aborts).toEqual([first.id]));
			expect((await say(first.id, "停下来之后的话")).status).toBe(200);
			expect((await ending).status).toBe(200);
			expect((await detail(first.id)).events.map((e) => e.type)).toEqual([
				"user_message",
				"turn_started",
				"user_message",
				"turn_end",
				"notice",
				"session_ended",
			]);
			expect(await statusOf(cp, first.id)).toBe("ended");
			// 没有为这句话开始新的一轮。
			expect(assistant.prompts).toHaveLength(1);
		});
	});

	describe("同一个项目一次只跑一轮，其余排队", () => {
		it("第一个会话在做时，新建的会话排队：queued、记下排队时间、这句话写了 user_message、没有交给助手服务；事件流里有 turn_queued（排第 1、在等谁）", async () => {
			const a = await json<SessionView>(await create("甲的事", "alice"));
			const res = await create("乙的事", "bob");
			expect(res.status).toBe(201);
			const b = await json<SessionView>(res);
			expect(b).toMatchObject({
				status: "queued",
				queue_position: 1,
				waiting_for: { session_id: a.id, title: a.title, created_by: "alice" },
			});
			expect((await row(cp, b.id))?.queued_at).toBeInstanceOf(Date);
			// 助手服务只收到了甲的这一轮。
			expect(assistant.prompts.map((p) => p.sessionId)).toEqual([a.id]);
			expect(await types(b.id)).toEqual(["user_message"]);
			// 会话列表里带排队的位置。
			const list = await json<SessionListResponse>(await api.get("/projects/default/sessions"));
			expect(list.sessions.find((s) => s.id === b.id)).toMatchObject({
				status: "queued",
				queue_position: 1,
			});
			expect(list.sessions.find((s) => s.id === a.id)).toMatchObject({
				status: "running",
				queue_position: null,
			});
			// 刷新页面后读会话也拿得回在等谁。
			expect(await view(b.id)).toMatchObject({ waiting_for: { session_id: a.id } });
		});

		it("空闲的会话说话时，项目里有别的会话在做：这个会话排队，事件流里推 turn_queued；排队中再说话 409 session_queued", async () => {
			const b = await idleSession("乙的第一件事");
			const a = await json<SessionView>(await create("甲的事"));
			const sse = await SseClient.open(cp, `/sessions/${b.id}/events`);
			try {
				const res = await say(b.id, "乙的第二件事", "bob");
				expect(res.status).toBe(200);
				expect(await statusOf(cp, b.id)).toBe("queued");
				const queued = await sse.next<{
					position: number;
					waiting_for: { session_id: string; title: string; created_by: string };
				}>("turn_queued");
				expect(queued.data).toMatchObject({
					position: 1,
					waiting_for: { session_id: a.id, title: a.title, created_by: "alice" },
				});
				// turn_queued 不持久：没有 id，也不在历史里。
				expect(queued.id).toBeUndefined();
				expect(await types(b.id)).not.toContain("turn_queued");
				// 排队中再说话：409。
				const again = await say(b.id, "再说一句", "bob");
				expect(again.status).toBe(409);
				expect((await json<{ error: { code: string } }>(again)).error.code).toBe("session_queued");
				// 助手服务没有收到过乙的第二件事。
				expect(assistant.prompts.map((p) => p.body.text)).not.toContain("乙的第二件事");
			} finally {
				sse.close();
			}
		});

		it("第一个会话这一轮结束：排队的自动开始（turn_started，交给助手服务的是它排队时说的那句话，发话人是排队时说话的人）；两轮的交给助手服务没有重叠", async () => {
			const a = await json<SessionView>(await create("甲的事", "alice"));
			const b = await json<SessionView>(await create("乙的事", "bob"));
			expect(assistant.prompts).toHaveLength(1);
			const sse = await SseClient.open(cp, `/sessions/${b.id}/events`);
			try {
				// 甲这一轮还没结束：乙不能开始。
				await new Promise((resolve) => setTimeout(resolve, 100));
				expect(assistant.prompts).toHaveLength(1);
				assistant.emit(a.id, 1, turnEnd(1));
				await eventually(() => expect(assistant.prompts).toHaveLength(2));
				const second = assistant.prompts[1];
				expect(second).toMatchObject({ sessionId: b.id });
				expect(second?.body).toMatchObject({
					turn: 1,
					text: "乙的事",
					env: { SFLY_NICKNAME: "bob", AI_AGENT: "pi" },
					session: { title: b.title, created_by: "bob" },
				});
				await sse.next("turn_started");
				expect(await row(cp, b.id)).toMatchObject({ status: "running", current_turn: 1 });
				expect((await row(cp, b.id))?.queued_at).toBeNull();
				// 乙开始之后，甲回到空闲（甲的 turn_end 先于乙的 prompt）。
				expect(await statusOf(cp, a.id)).toBe("idle");
				expect(await types(b.id)).toEqual(["user_message", "turn_started"]);
				// 乙的这一轮的事件照常收。
				assistant.emit(b.id, 1, { type: "assistant_message", text: "乙在做", usage: USAGE });
				await eventually(async () => expect(await types(b.id)).toContain("assistant_message"));
			} finally {
				sse.close();
			}
		});

		it("排队的按排队的先后轮流开始（先来先服务），新来的会话排在后面", async () => {
			const a = await json<SessionView>(await create("甲", "alice"));
			const b = await json<SessionView>(await create("乙", "bob"));
			const c = await json<SessionView>(await create("丙", "carol"));
			expect([(await view(b.id)).queue_position, (await view(c.id)).queue_position]).toEqual([
				1, 2,
			]);
			expect(await view(c.id)).toMatchObject({ waiting_for: { session_id: a.id } });
			assistant.emit(a.id, 1, turnEnd(1));
			await eventually(() =>
				expect(assistant.prompts.map((p) => p.sessionId)).toEqual([a.id, b.id]),
			);
			// 乙开始之后，丙排第 1，在等乙。
			await eventually(async () =>
				expect(await view(c.id)).toMatchObject({
					status: "queued",
					queue_position: 1,
					waiting_for: { session_id: b.id },
				}),
			);
			assistant.emit(b.id, 1, turnEnd(1));
			await eventually(() =>
				expect(assistant.prompts.map((p) => p.sessionId)).toEqual([a.id, b.id, c.id]),
			);
			expect(await statusOf(cp, c.id)).toBe("running");
		});

		it("排队中的会话开始时给后面排队的各推一条 turn_queued（位置前进了，在等的是新开始的那个）", async () => {
			const a = await json<SessionView>(await create("甲", "alice"));
			const b = await json<SessionView>(await create("乙", "bob"));
			const c = await json<SessionView>(await create("丙", "carol"));
			const sse = await SseClient.open(cp, `/sessions/${c.id}/events`);
			try {
				assistant.emit(a.id, 1, turnEnd(1));
				const moved = await sse.next<{ position: number; waiting_for: { session_id: string } }>(
					"turn_queued",
				);
				expect(moved.data).toMatchObject({ position: 1, waiting_for: { session_id: b.id } });
			} finally {
				sse.close();
			}
		});

		it("停止排队中的会话：移出队列、回到空闲，时间线上有 queue_cancelled（带排队时那句话的 message_id）；后面的会话的位置随之更新", async () => {
			await json<SessionView>(await create("甲", "alice"));
			const b = await json<SessionView>(await create("乙", "bob"));
			const c = await json<SessionView>(await create("丙", "carol"));
			const queuedSaid = (await detail(b.id)).events.find((e) => e.type === "user_message");
			const sse = await SseClient.open(cp, `/sessions/${c.id}/events`);
			try {
				const res = await api.post(`/sessions/${b.id}/stop`, {});
				expect(res.status).toBe(200);
				expect(await json<SessionView>(res)).toMatchObject({
					status: "idle",
					queue_position: null,
					waiting_for: null,
				});
				expect((await row(cp, b.id))?.queued_at).toBeNull();
				const events = (await detail(b.id)).events;
				expect(events.map((e) => e.type)).toEqual(["user_message", "notice"]);
				expect(events[1]).toMatchObject({
					type: "notice",
					kind: "queue_cancelled",
					message: "这句话排队时被取消了，没有交给助手",
					message_id: (queuedSaid as { message_id: string }).message_id,
				});
				// 丙前进到第 1 位。
				const moved = await sse.next<{ position: number }>("turn_queued");
				expect(moved.data.position).toBe(1);
				expect(await view(c.id)).toMatchObject({ queue_position: 1 });
				// 助手服务一直没有收到乙的话，也没有收到过中止。
				expect(assistant.prompts.map((p) => p.body.text)).toEqual(["甲"]);
				expect(assistant.aborts).toEqual([]);
			} finally {
				sse.close();
			}
		});

		it("被停止的排队会话之后还能再说话：重新排队（在队尾）", async () => {
			await json<SessionView>(await create("甲", "alice"));
			const b = await json<SessionView>(await create("乙", "bob"));
			const c = await json<SessionView>(await create("丙", "carol"));
			await api.post(`/sessions/${b.id}/stop`, {});
			expect((await say(b.id, "乙再说一次", "bob")).status).toBe(200);
			expect(await view(b.id)).toMatchObject({ status: "queued", queue_position: 2 });
			expect(await view(c.id)).toMatchObject({ queue_position: 1 });
		});

		it("没有会话在做时发话照常开始（不排队）", async () => {
			const a = await idleSession("甲");
			const res = await say(a.id, "甲接着做");
			expect(res.status).toBe(200);
			expect(await statusOf(cp, a.id)).toBe("running");
		});

		it("交给助手服务没接住：排队的那一轮以失败结束，会话回到空闲，下一个排队的接着开始", async () => {
			const a = await json<SessionView>(await create("甲", "alice"));
			const b = await json<SessionView>(await create("乙", "bob"));
			const c = await json<SessionView>(await create("丙", "carol"));
			assistant.promptReply = (prompt) =>
				prompt.sessionId === b.id ? { status: 503, code: "start_failed" } : undefined;
			assistant.emit(a.id, 1, turnEnd(1));
			// 乙没接住：失败的结局，回到空闲；丙接着开始。
			await eventually(async () => expect(await statusOf(cp, b.id)).toBe("idle"));
			const end = (await detail(b.id)).events.find((e) => e.type === "turn_end");
			expect(end).toMatchObject({ turn: 1, outcome: "failed" });
			await eventually(() => expect(assistant.prompts.map((p) => p.sessionId)).toContain(c.id));
			expect(await statusOf(cp, c.id)).toBe("running");
		});

		it("控制面重启时有会话在排队、项目里却没有会话在做：起来之后（工作台的 Agent 重新连上以后）排队最早的那个开始，其余的接着排", async () => {
			// 单独起一个控制面：它要重启，工作台的 Agent 也要重新连上。
			const restartCp = await startTestControlPlane({
				assistantUrl: assistant.url,
				assistantSecret: assistant.secret,
				workbenchAgent: "workbench-restart",
				assistantReconnectMs: { min: 20, max: 100 },
				// 兜底的扫描调快：重启时工作台还没连上，开始排队的要等扫描。
				sessionSweepIntervalMs: 100,
			});
			let agent = await FakeAgent.connect(
				restartCp.grpcUrl,
				{ name: "workbench-restart", peer: { port: 7004, publicAddress: "10.0.0.8" } },
				{ clock: restartCp.clock },
			);
			try {
				await assistant.connected(2);
				const restartApi = new ApiClient(restartCp);
				const advance = () => (restartCp.clock as ManualClock).advance(1_000);
				const make = async (text: string, nickname: string) => {
					const created = await json<SessionView>(
						await restartApi.post("/projects/default/sessions", { text }, nickname),
					);
					advance();
					return created;
				};
				const a = await make("甲", "alice");
				const b = await make("乙", "bob");
				const c = await make("丙", "carol");
				expect([b.status, c.status]).toEqual(["queued", "queued"]);
				assistant.prompts.length = 0;
				// 停机期间甲的这一轮结束了（助手服务的事件控制面没收到）：直接在库里把甲改回空闲。
				await restartCp.restart(async () => {
					await database_query(restartCp, "update sessions set status = 'idle' where id = $1", [
						a.id,
					]);
				});
				// 起来的时候工作台还没重新连上：排队的先不开始（不把它们的话失败掉）。
				expect(await statusOf(restartCp, b.id)).toBe("queued");
				await agent.disconnect();
				agent = await FakeAgent.connect(
					restartCp.grpcUrl,
					{ name: "workbench-restart", peer: { port: 7004, publicAddress: "10.0.0.8" } },
					{ clock: restartCp.clock },
				);
				await eventually(
					() => expect(assistant.prompts.map((p) => p.sessionId)).toEqual([b.id]),
					6_000,
				);
				expect(await statusOf(restartCp, b.id)).toBe("running");
				// 丙还在排队，排第 1。
				expect(await json<SessionView>(await restartApi.get(`/sessions/${c.id}`))).toMatchObject({
					status: "queued",
					queue_position: 1,
				});
			} finally {
				await agent.disconnect();
				await restartCp.close();
			}
		}, 30_000);
	});

	describe("停止：旧的一轮过一会儿才结束", () => {
		it("控制面等不及先补了 stopped：用户马上再说一句，助手服务把新的一轮登记着（202，不回 409），旧的一轮结束之后才开始；旧的一轮迟到的结局不影响新的一轮", async () => {
			const stopCp = await startTestControlPlane({
				assistantUrl: assistant.url,
				assistantSecret: assistant.secret,
				workbenchAgent: "workbench-slow",
				assistantReconnectMs: { min: 20, max: 100 },
				sessionStopGraceMs: 50,
			});
			const slowWorkbench = await FakeAgent.connect(
				stopCp.grpcUrl,
				{ name: "workbench-slow", peer: { port: 7002, publicAddress: "10.0.0.6" } },
				{ clock: stopCp.clock },
			);
			try {
				await assistant.connected(2);
				const slowApi = new ApiClient(stopCp);
				const created = await json<SessionView>(
					await slowApi.post("/projects/default/sessions", { text: "第一句" }, "alice"),
				);
				// 旧的一轮要 1.2 秒才结束（pi 不理会 abort、助手服务等了又结束进程）。
				assistant.stopSettleMs = 1_200;
				const stopped = await slowApi.post(`/sessions/${created.id}/stop`, {});
				expect(stopped.status).toBe(200);
				// 控制面只等了 50 毫秒，先补了 stopped，会话空闲；助手服务那边还在停止。
				expect(await statusOf(stopCp, created.id)).toBe("idle");
				expect(assistant.stoppingTurn(created.id)).toBe(1);
				// 马上再说一句：新的一轮被助手服务登记着（202），这一次发话成功，不是 409。
				const said = await slowApi.post(`/sessions/${created.id}/messages`, { text: "再来一句" });
				expect(said.status).toBe(200);
				expect(assistant.pendingTurn(created.id)).toBe(2);
				expect(await statusOf(stopCp, created.id)).toBe("running");
				// 旧的一轮结束：它迟到的 turn_end（第 1 轮）控制面丢掉，不会把新的一轮改回空闲；新的一轮开始。
				await eventually(() => expect(assistant.stoppingTurn(created.id)).toBeUndefined(), 4_000);
				expect(assistant.pendingTurn(created.id)).toBeUndefined();
				expect(await row(stopCp, created.id)).toMatchObject({ status: "running", current_turn: 2 });
				// 新的一轮的事件照常收，结局让会话回到空闲。
				assistant.emit(created.id, 2, { type: "assistant_message", text: "好", usage: USAGE });
				assistant.emit(created.id, 2, turnEnd(2));
				await eventually(async () => expect(await statusOf(stopCp, created.id)).toBe("idle"));
				const ends = (
					await json<SessionDetailResponse>(await slowApi.get(`/sessions/${created.id}`))
				).events.filter((e) => e.type === "turn_end");
				expect(
					ends.map((e) => [(e as { turn: number }).turn, (e as { outcome: string }).outcome]),
				).toEqual([
					[1, "stopped"],
					[2, "completed"],
				]);
			} finally {
				await slowWorkbench.disconnect();
				await stopCp.close();
			}
		}, 30_000);

		it("停止之后项目的位置空出来，排队的开始（不论这一轮的结局是助手服务带回来的，还是控制面补的）", async () => {
			const a = await json<SessionView>(await create("甲", "alice"));
			const b = await json<SessionView>(await create("乙", "bob"));
			const stopped = await api.post(`/sessions/${a.id}/stop`, {});
			expect(stopped.status).toBe(200);
			await eventually(() =>
				expect(assistant.prompts.map((p) => p.sessionId)).toEqual([a.id, b.id]),
			);
			expect(await statusOf(cp, b.id)).toBe("running");
			expect(await statusOf(cp, a.id)).toBe("idle");
		});
	});

	describe("结束会话：POST /sessions/:id/end", () => {
		it("空闲的会话：改成 ended、写 session_ended（by 是结束它的人），助手服务收到 end；之后发话 409 session_ended；重复调用无害（不再写事件、不再发 end）", async () => {
			const a = await idleSession();
			const before = (await detail(a.id)).events.length;
			const res = await api.post(`/sessions/${a.id}/end`, {}, "bob");
			expect(res.status).toBe(200);
			expect(await json<SessionView>(res)).toMatchObject({ status: "ended" });
			const events = (await detail(a.id)).events;
			expect(events).toHaveLength(before + 1);
			expect(events.at(-1)).toMatchObject({ type: "session_ended", by: "bob" });
			expect(assistant.ends).toEqual([a.id]);
			// 之后发话：409 session_ended，不交给助手服务。
			const said = await say(a.id, "还能说吗");
			expect(said.status).toBe(409);
			expect((await json<{ error: { code: string } }>(said)).error.code).toBe("session_ended");
			// 重复调用：无害。
			expect((await api.post(`/sessions/${a.id}/end`, {}, "bob")).status).toBe(200);
			expect((await detail(a.id)).events).toHaveLength(before + 1);
			expect(assistant.ends).toEqual([a.id]);
		});

		it("在做的一轮先停止（助手服务收到 abort，这一轮的结局在 session_ended 之前），再结束；工作台和别的会话不受影响", async () => {
			const a = await json<SessionView>(await create("甲的事"));
			const res = await api.post(`/sessions/${a.id}/end`, {}, "bob");
			expect(res.status).toBe(200);
			expect(assistant.abortRequests).toEqual([{ sessionId: a.id, turn: 1 }]);
			const types = (await detail(a.id)).events.map((e) => e.type);
			expect(types).toEqual(["user_message", "turn_started", "turn_end", "session_ended"]);
			expect(assistant.ends).toEqual([a.id]);
			expect(await statusOf(cp, a.id)).toBe("ended");
		});

		it("排队中的会话：移出队列（queue_cancelled）再结束；后面排队的位置更新", async () => {
			await json<SessionView>(await create("甲"));
			const b = await json<SessionView>(await create("乙", "bob"));
			const c = await json<SessionView>(await create("丙", "carol"));
			const res = await api.post(`/sessions/${b.id}/end`, {}, "bob");
			expect(res.status).toBe(200);
			expect((await detail(b.id)).events.map((e) => e.type)).toEqual([
				"user_message",
				"notice",
				"session_ended",
			]);
			expect(await view(b.id)).toMatchObject({ status: "ended", queue_position: null });
			expect(await view(c.id)).toMatchObject({ queue_position: 1 });
		});

		it("助手服务拒绝了 end（或连不上）：会话照样已经结束（进程由助手服务自己回收），响应是 200", async () => {
			const a = await idleSession();
			assistant.endReply = () => ({ status: 503, code: "start_failed" });
			const res = await api.post(`/sessions/${a.id}/end`, {});
			expect(res.status).toBe(200);
			expect(await statusOf(cp, a.id)).toBe("ended");
		});

		it("结束之后调用 onEnded（会话令牌合入之后在那里吊销令牌）：它抛错只进日志，不影响结束", async () => {
			const ended: string[] = [];
			const endCp = await startTestControlPlane({
				assistantUrl: assistant.url,
				assistantSecret: assistant.secret,
				workbenchAgent: "workbench-ended",
				assistantReconnectMs: { min: 20, max: 100 },
				onSessionEnded: async (session) => {
					ended.push(session.id);
					throw new Error("吊销失败");
				},
			});
			const endedWorkbench = await FakeAgent.connect(
				endCp.grpcUrl,
				{ name: "workbench-ended", peer: { port: 7003, publicAddress: "10.0.0.7" } },
				{ clock: endCp.clock },
			);
			try {
				await assistant.connected(2);
				const endApi = new ApiClient(endCp);
				const created = await json<SessionView>(
					await endApi.post("/projects/default/sessions", { text: "第一句" }),
				);
				assistant.emit(created.id, 1, turnEnd(1));
				await eventually(async () => expect(await statusOf(endCp, created.id)).toBe("idle"));
				const res = await endApi.post(`/sessions/${created.id}/end`, {});
				expect(res.status).toBe(200);
				expect(ended).toEqual([created.id]);
				expect(await statusOf(endCp, created.id)).toBe("ended");
			} finally {
				await endedWorkbench.disconnect();
				await endCp.close();
			}
		});

		it("不存在的会话 404；已结束的会话的事件和历史仍能读", async () => {
			expect((await api.post(`/sessions/${randomUUID()}/end`, {})).status).toBe(404);
			const a = await idleSession();
			await api.post(`/sessions/${a.id}/end`, {});
			const events: PersistedSessionEvent[] = (await detail(a.id)).events;
			expect(events.at(-1)?.type).toBe("session_ended");
		});
	});
});
