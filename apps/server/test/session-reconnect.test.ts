// 控制面和助手服务之间的断线重连和补发（#545 的 R 块）：控制面带着最后收到的（纪元、序号）重连，助手服务补发缓冲里的持久事件，
// 重复收到的不存两次；`hello` 说纪元变了（助手服务重启了）就让断开那一刻在做的会话以 `interrupted` 结束、排队的接着开始，
// 纪元相同但有缺口（断得太久）就给在做的会话各写一条 `events_lost`；连不上期间会话保持原状态、兜底不把它们判成中断。
// 真实控制面 + 真实数据库 + 进程内的假助手服务（support/fake-assistant.ts：按协议续传、可以重启）。
// 真的助手服务（真的 pi、假的模型）上的两个集成测试在 session-reconnect-real-assistant.test.ts。
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type {
	AssistantEvent,
	PersistedSessionEvent,
	SessionDetailResponse,
	SessionView,
} from "@sfly/schema";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectId } from "../src/projects/project-id.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { FakeAssistant } from "./support/fake-assistant.js";
import type { ManualClock } from "./support/manual-clock.js";
import { SseClient } from "./support/sse-client.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";
import { asUsers } from "./support/user-api.js";

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const WORKBENCH = "workbench-reconnect";
const USAGE = { input: 10, output: 5, cache_read: 0, cache_write: 0 };
const message = (text: string): AssistantEvent => ({
	type: "assistant_message",
	text,
	usage: USAGE,
});
const turnEnd = (turn: number): AssistantEvent => ({
	type: "turn_end",
	turn,
	outcome: "completed",
	reason: "测试",
	steps: 1,
	model_calls: 1,
	duration_ms: 1000,
	usage: USAGE,
});

interface EventRow {
	session_id: string;
	seq: number;
	type: string;
	payload: Record<string, unknown>;
	assistant_epoch: string | null;
	assistant_seq: string | null;
}

async function query<T extends object>(
	cp: TestControlPlane,
	text: string,
	params: unknown[] = [],
): Promise<T[]> {
	const client = new pg.Client({ connectionString: cp.database.url });
	await client.connect();
	try {
		return (await client.query(text, params)).rows as T[];
	} finally {
		await client.end();
	}
}

/** 一个会话在库里的全部事件（按会话内序号），带着在助手服务里的位置。 */
const rowsOf = (cp: TestControlPlane, id: string) =>
	query<EventRow>(
		cp,
		"select session_id, seq, type, payload, assistant_epoch, assistant_seq from session_events where session_id = $1 order by seq",
		[id],
	);
const statusOf = async (cp: TestControlPlane, id: string) =>
	(await query<{ status: string }>(cp, "select status from sessions where id = $1", [id]))[0]
		?.status;

describe("控制面和助手服务的断线重连、补发、纪元变化", () => {
	let cp: TestControlPlane;
	let api: ApiClient;
	let assistant: FakeAssistant;
	let workbench: FakeAgent;
	let logs: string[];
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		assistant = await FakeAssistant.start();
		cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: WORKBENCH,
			assistantReconnectMs: { min: 20, max: 100 },
			// 控制面的错误日志（`printError`）只在开着日志时才写：开着，下面的用例才收得到「丢弃」「落库失败」这类日志；
			// Fastify 自己的请求日志丢掉。
			logger: { stream: new Writable({ write: (_chunk, _encoding, done) => done() }) },
		});
		api = new ApiClient(asUsers(cp));
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
		await cp.current.sessionService.idle();
		await query(cp, "delete from sessions");
		assistant.prompts.length = 0;
		assistant.steers.length = 0;
		assistant.aborts.length = 0;
		assistant.abortRequests.length = 0;
		assistant.replayEverything = false;
		assistant.replayOnly = undefined;
		assistant.eventsStatus = undefined;
		assistant.replayLimit = 10_000;
		assistant.promptReply = () => undefined;
		assistant.abortReply = () => undefined;
		assistant.steerReply = () => undefined;
		assistant.stopSettleMs = 0;
		assistant.strictTurns = true;
		assistant.health = () => assistant.healthy();
		// 上一个用例让它断开的话，等它重新连上。
		if (!assistant.listening) await assistant.resume();
		await eventually(() => expect(cp.current.assistantConnected()).toBe(true), 10_000);
		logs = [];
		errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	const tick = () => (cp.clock as ManualClock).advance(1_000);
	const create = async (text: string, nickname = "alice") => {
		const res = await api.post("/projects/default/sessions", { text }, nickname);
		tick();
		return res;
	};
	const createOk = async (text: string, nickname = "alice") =>
		json<SessionView>(await create(text, nickname));
	const say = async (id: string, text: string, nickname = "alice") => {
		const res = await api.post(`/sessions/${id}/messages`, { text }, nickname);
		tick();
		return res;
	};
	const detail = async (id: string) =>
		json<SessionDetailResponse>(await api.get(`/sessions/${id}`));
	const types = async (id: string) => (await detail(id)).events.map((e) => e.type);
	const noticeKinds = (events: PersistedSessionEvent[]) =>
		events.flatMap((e) => (e.type === "notice" ? [e.kind] : []));

	/** 等控制面把助手服务到这一刻为止发的持久事件都处理完：再发一条探针，它落库了，前面的就都处理过了（连接里一条一条依次处理）。 */
	async function drained(id: string, turn: number) {
		const probe = `探针 ${randomUUID()}`;
		assistant.emit(id, turn, message(probe));
		await eventually(async () => {
			const events = (await detail(id)).events;
			expect(events.some((e) => e.type === "assistant_message" && e.text === probe)).toBe(true);
		}, 10_000);
	}

	describe("持久事件带着助手服务里的位置落库，重复收到的不存两次", () => {
		it("助手事件的行有纪元和序号；控制面自己写的没有；同一个位置不会有两行", async () => {
			const a = await createOk("甲");
			assistant.emit(a.id, 1, message("第一条"));
			assistant.emit(a.id, 1, { type: "tool_call", call_id: "c1", tool: "command", title: "ls" });
			await drained(a.id, 1);
			const rows = await rowsOf(cp, a.id);
			const fromAssistant = rows.filter((r) => r.assistant_epoch !== null);
			expect(fromAssistant.map((r) => r.type)).toEqual([
				"assistant_message",
				"tool_call",
				"assistant_message",
			]);
			expect(fromAssistant.every((r) => r.assistant_epoch === assistant.epoch)).toBe(true);
			const seqs = fromAssistant.map((r) => Number(r.assistant_seq));
			expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
			expect(new Set(seqs).size).toBe(seqs.length);
			// 用户的话、一轮的开始是控制面自己写的：没有位置。
			expect(rows.filter((r) => r.assistant_epoch === null).map((r) => r.type)).toEqual([
				"user_message",
				"turn_started",
			]);
		});

		it("助手服务重连后把已经收过的事件整批重放：库里不存第二遍，浏览器的事件流里也不重复，日志里没有丢弃或落库失败", async () => {
			const a = await createOk("甲");
			assistant.emit(a.id, 1, message("第一条"));
			assistant.emit(a.id, 1, { type: "tool_call", call_id: "c1", tool: "command", title: "ls" });
			assistant.emit(a.id, 1, {
				type: "tool_result",
				call_id: "c1",
				is_error: false,
				text: "ok",
				truncated: false,
				duration_ms: 3,
			});
			await drained(a.id, 1);
			const before = await rowsOf(cp, a.id);
			const sse = await SseClient.open(cp, `/sessions/${a.id}/events`, {
				"last-event-id": String(before.length),
			});
			try {
				await sse.next("snapshot");
				// 断开重连，这次助手服务不管 `after`、把缓冲里的持久事件全部补发一遍（模拟控制面的位置落在了后面）。
				assistant.replayEverything = true;
				assistant.replayOnly = [a.id];
				const opens = assistant.eventRequests;
				assistant.dropStreams();
				await eventually(() => expect(assistant.eventRequests).toBeGreaterThan(opens));
				assistant.replayEverything = false;
				await drained(a.id, 1);
				const after = await rowsOf(cp, a.id);
				// 只多了探针（`drained` 发的最后一条）：重放的没有一条存第二遍。
				expect(after.length).toBe(before.length + 1);
				const sources = after.flatMap((r) =>
					r.assistant_epoch === null ? [] : [`${r.assistant_epoch}:${r.assistant_seq}`],
				);
				expect(new Set(sources).size).toBe(sources.length);
				expect(after.map((r) => r.seq)).toEqual(after.map((_, i) => i + 1));
				// 浏览器：重放的没有推第二遍（持久事件的序号不重复）。
				const seen = sse.received
					.filter((e) => e.id !== undefined)
					.map((e) => Number(e.id))
					.filter((n) => n > before.length);
				expect(seen).toEqual([after.length]);
				expect(logs.filter((line) => /丢弃|落库失败/.test(line))).toEqual([]);
			} finally {
				sse.close();
			}
		});

		it("同一个位置在库里只能有一行（唯一约束）：存储层第二次收到同一个位置的事件返回 duplicate、不写；绕过存储层直接插第二行，数据库拒绝", async () => {
			const a = await createOk("甲");
			const source = { epoch: "unit-epoch", seq: 424242 };
			const at = new Date("2026-01-01T00:00:00.000Z");
			const body = message("只存一次");
			const first = await cp.current.sessions.appendFromAssistant(a.id, 1, body, at, source);
			expect(first).toMatchObject({ stored: { type: "assistant_message" } });
			expect(await cp.current.sessions.appendFromAssistant(a.id, 1, body, at, source)).toEqual({
				duplicate: true,
			});
			const stored = (await rowsOf(cp, a.id)).filter((r) => r.assistant_seq === "424242");
			expect(stored).toHaveLength(1);
			// 唯一约束本身：别的会话也不能占同一个位置；两列要么都有、要么都没有。
			const other = await createOk("乙");
			await expect(
				query(
					cp,
					"insert into session_events (session_id, seq, type, payload, created_at, assistant_epoch, assistant_seq) values ($1, 99, 'notice', '{}', now(), 'unit-epoch', 424242)",
					[other.id],
				),
			).rejects.toThrow(/session_events_assistant_source_idx/);
			await expect(
				query(
					cp,
					"insert into session_events (session_id, seq, type, payload, created_at, assistant_epoch) values ($1, 99, 'notice', '{}', now(), 'only-epoch')",
					[other.id],
				),
			).rejects.toThrow(/session_events_assistant_source/);
		});

		it("重放的事件所在的这一轮已经结束了：也是静静地忽略（重复的先于「会话不在做」的核对），不记迟到的日志", async () => {
			const a = await createOk("甲");
			assistant.emit(a.id, 1, message("第一条"));
			assistant.emit(a.id, 1, turnEnd(1));
			await eventually(async () => expect(await statusOf(cp, a.id)).toBe("idle"));
			const before = await rowsOf(cp, a.id);
			assistant.replayEverything = true;
			assistant.replayOnly = [a.id];
			const opens = assistant.eventRequests;
			assistant.dropStreams();
			await eventually(() => expect(assistant.eventRequests).toBeGreaterThan(opens));
			assistant.replayEverything = false;
			// 第二个会话收一条事件：重放的（甲的）在它前面处理完了。
			const b = await createOk("乙");
			await drained(b.id, 1);
			expect((await rowsOf(cp, a.id)).length).toBe(before.length);
			expect(logs.filter((line) => /丢弃|落库失败/.test(line))).toEqual([]);
		});
	});

	describe("控制面重启：带着库里最后一条助手事件的位置重连，补回停机期间的事件", () => {
		it("停机期间助手服务产生的持久事件，起来之后补上：按序、不重不漏，没有缺口提示，这一轮照常做下去", async () => {
			const a = await createOk("甲");
			assistant.emit(a.id, 1, message("停机之前的第一条"));
			assistant.emit(a.id, 1, message("停机之前的第二条"));
			await drained(a.id, 1);
			const lastSeq = assistant.lastSeq;
			const stored = (await rowsOf(cp, a.id)).length;
			await cp.restart(() => {
				assistant.emit(a.id, 1, message("停机期间的第一条"));
				assistant.emit(a.id, 1, {
					type: "tool_call",
					call_id: "c1",
					tool: "command",
					title: "sleep 1",
				});
				assistant.emit(a.id, 1, message("停机期间的第二条"));
			});
			// 工作台的 Agent 要重新连上（控制面重启断了它的连接），后面的用例才建得了会话。
			await workbench.disconnect();
			workbench = await FakeAgent.connect(
				cp.grpcUrl,
				{ name: WORKBENCH, peer: { port: 7001, publicAddress: "10.0.0.5" } },
				{ clock: cp.clock },
			);
			await eventually(
				async () => expect((await rowsOf(cp, a.id)).length).toBe(stored + 3),
				10_000,
			);
			// 起来之后连的是库里最后一条助手事件的位置。
			expect(assistant.eventAfters.at(-1)).toBe(`${assistant.epoch}:${lastSeq}`);
			const events = (await detail(a.id)).events;
			expect(events.slice(-3).map((e) => e.type)).toEqual([
				"assistant_message",
				"tool_call",
				"assistant_message",
			]);
			expect(noticeKinds(events)).toEqual([]);
			expect(await statusOf(cp, a.id)).toBe("running");
			assistant.emit(a.id, 1, turnEnd(1));
			await eventually(async () => expect(await statusOf(cp, a.id)).toBe("idle"));
		}, 30_000);

		it("第一次连接（库里还没有助手事件）不带 after；之后断线重连带内存里最后收到的位置", async () => {
			const a = await createOk("甲");
			assistant.emit(a.id, 1, message("一条"));
			await drained(a.id, 1);
			const last = assistant.lastSeq;
			const opens = assistant.eventRequests;
			assistant.dropStreams();
			await eventually(() => expect(assistant.eventRequests).toBeGreaterThan(opens));
			expect(assistant.eventAfters.at(-1)).toBe(`${assistant.epoch}:${last}`);
		});
	});

	describe("纪元相同、有缺口（断得太久，事件被挤出缓冲）：在做的会话各补一条 events_lost", () => {
		it("在做的会话写一条 events_lost，照常接着收；空闲的会话没有；再断线重连、位置没动时不重复写", async () => {
			const running = await createOk("在做的");
			const idle = await createOk("另一个");
			// 另一个会话排队了（同一个项目只跑一轮）：不在做，也不该有提示。
			assistant.emit(running.id, 1, message("断线之前"));
			await drained(running.id, 1);
			assistant.replayLimit = 2;
			await assistant.stop();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			// 断线期间产生的持久事件比缓冲留的多：最前面的被挤出去了。
			for (let n = 1; n <= 5; n++) assistant.emit(running.id, 1, message(`断线期间 ${n}`));
			await assistant.resume();
			await eventually(async () => {
				expect(noticeKinds((await detail(running.id)).events)).toEqual(["events_lost"]);
			}, 10_000);
			const events = (await detail(running.id)).events;
			const lost = events.find((e) => e.type === "notice");
			expect(lost).toMatchObject({ message: "控制面和助手服务断开太久，这一段过程没有记下" });
			// 补不回来的没有补，会话仍在做。
			expect(
				events
					.filter((e) => e.type === "assistant_message")
					.map((e) => (e as { text: string }).text),
			).not.toContain("断线期间 1");
			expect(await statusOf(cp, running.id)).toBe("running");
			expect(noticeKinds((await detail(idle.id)).events)).toEqual([]);
			// 再断线重连：这段时间没有收到新的持久事件，位置没动，助手服务仍然说有缺口，不重复写。
			const opens = assistant.eventRequests;
			assistant.dropStreams();
			await eventually(() => expect(assistant.eventRequests).toBeGreaterThan(opens));
			await eventually(() => expect(cp.current.assistantConnected()).toBe(true));
			await drained(running.id, 1);
			expect(noticeKinds((await detail(running.id)).events)).toEqual(["events_lost"]);
			// 之后的事件照常收。
			assistant.emit(running.id, 1, turnEnd(1));
			await eventually(async () => expect(await statusOf(cp, running.id)).toBe("idle"));
		}, 30_000);
	});

	describe("助手服务重启（纪元变了）：断开那一刻在做的会话以 interrupted 结束，排队的接着开始", () => {
		it("在做的会话补一条 interrupted 的 turn_end（原因写明），回到空闲；没有确认送到的插话先各补一条 steer_dropped；排队的开始；接着说一句话从新的助手服务开始新的一轮", async () => {
			const a = await createOk("甲的事", "alice");
			const b = await createOk("乙的事", "bob");
			expect(await statusOf(cp, b.id)).toBe("queued");
			assistant.emit(a.id, 1, message("做了一点"));
			await drained(a.id, 1);
			// 一句还没送到模型的插话。
			expect((await say(a.id, "先别改测试")).status).toBe(200);
			await assistant.stop();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			assistant.restartService();
			await assistant.resume();
			await eventually(async () => expect(await statusOf(cp, a.id)).not.toBe("running"), 10_000);
			const events = (await detail(a.id)).events;
			const end = events.at(-1);
			expect(end).toMatchObject({
				type: "turn_end",
				turn: 1,
				outcome: "interrupted",
				reason: "助手服务重启了；工作区和已经触发的运行不受影响，说一句话可以接着做",
			});
			const dropIndex = events.findIndex((e) => e.type === "notice" && e.kind === "steer_dropped");
			expect(dropIndex).toBeGreaterThan(-1);
			expect(dropIndex).toBeLessThan(events.length - 1);
			expect(await statusOf(cp, a.id)).toBe("idle");
			expect((await detail(a.id)).last_turn_outcome).toBe("interrupted");
			// 按 #544 的规则开始排队中的下一个：乙开始了，prompt 交给了新的助手服务。
			await eventually(() => expect(assistant.prompts.map((p) => p.sessionId)).toContain(b.id));
			expect(await statusOf(cp, b.id)).toBe("running");
			// 新纪元的位置从 0 起：之后的事件照常收。
			assistant.emit(b.id, 1, message("乙开始了"));
			await drained(b.id, 1);
			expect(
				(await rowsOf(cp, b.id)).filter((r) => r.assistant_epoch === assistant.epoch).length,
			).toBeGreaterThan(0);
			assistant.emit(b.id, 1, turnEnd(1));
			await eventually(async () => expect(await statusOf(cp, b.id)).toBe("idle"));
			// 甲接着说一句话：新的一轮（第 2 轮）。
			expect((await say(a.id, "接着做")).status).toBe(200);
			await eventually(() =>
				expect(assistant.prompts.map((p) => [p.sessionId, p.body.turn])).toContainEqual([a.id, 2]),
			);
			expect(logs.filter((line) => /丢弃/.test(line))).toEqual([]);
		}, 30_000);

		it("空闲的会话和已结束的会话不受影响；没有在做的会话时纪元变了也只是记下新的纪元", async () => {
			const a = await createOk("甲");
			assistant.emit(a.id, 1, message("一条"));
			assistant.emit(a.id, 1, turnEnd(1));
			await eventually(async () => expect(await statusOf(cp, a.id)).toBe("idle"));
			const before = await types(a.id);
			await assistant.stop();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			assistant.restartService();
			await assistant.resume();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(true));
			expect(await types(a.id)).toEqual(before);
			// 新纪元的事件照常收。
			const b = await createOk("乙");
			await drained(b.id, 1);
			expect(await statusOf(cp, b.id)).toBe("running");
		}, 30_000);
	});

	describe("连不上期间什么都不判", () => {
		it("助手服务连不上：在做的会话保持原状态（超过 30 分钟也不被兜底判成中断），就绪状态写明连不上；连上之后（没有缺口）这一轮照常结束", async () => {
			const a = await createOk("甲");
			assistant.emit(a.id, 1, message("做着"));
			await drained(a.id, 1);
			await assistant.stop();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			// 自检：日志收集器真的收得到控制面的日志（不然上面各处「日志里没有丢弃」什么也证明不了）。
			await eventually(() => expect(logs.join("\n")).toContain("助手服务的事件流"));
			(cp.clock as ManualClock).advance(31 * 60_000);
			expect(await cp.current.sessionService.expireStale()).toBe(0);
			expect(await statusOf(cp, a.id)).toBe("running");
			expect((await detail(a.id)).events.map((e) => e.type)).not.toContain("turn_end");
			// 就绪状态：助手服务连不上。
			const list = await json<{
				readiness: { ready: boolean; problems: Array<{ kind: string; message: string }> };
			}>(await api.get("/projects/default/sessions"));
			expect(list.readiness.ready).toBe(false);
			expect(list.readiness.problems.map((p) => p.kind)).toContain("assistant_unreachable");
			expect(
				list.readiness.problems.find((p) => p.kind === "assistant_unreachable")?.message,
			).toContain("连不上");
			// 连上了（助手服务没有重启，没有缺口）：会话照旧在做，结局照常带回来。
			await assistant.resume();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(true));
			expect(await statusOf(cp, a.id)).toBe("running");
			expect(noticeKinds((await detail(a.id)).events)).toEqual([]);
			assistant.emit(a.id, 1, turnEnd(1));
			await eventually(async () => expect(await statusOf(cp, a.id)).toBe("idle"));
		}, 30_000);

		it("助手服务连不上期间，对空闲的会话说话：新的一轮 503 assistant_unavailable，会话仍是空闲（不因为连不上就判中断，也不留下在做的一轮）", async () => {
			const a = await createOk("甲");
			assistant.emit(a.id, 1, turnEnd(1));
			await eventually(async () => expect(await statusOf(cp, a.id)).toBe("idle"));
			await assistant.stop();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			const res = await say(a.id, "接着做");
			expect(res.status).toBe(503);
			expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
				"assistant_unavailable",
			);
			expect(await statusOf(cp, a.id)).toBe("idle");
			await assistant.resume();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(true));
		}, 30_000);

		it("事件流没连上（助手服务本身是好的，控制面刚启动或正在退避重连时就是这样）：就绪状态写助手服务连不上，建会话和说话 503 assistant_unavailable、不写任何东西；连上之后才放行", async () => {
			const a = await createOk("甲");
			assistant.emit(a.id, 1, turnEnd(1));
			await eventually(async () => expect(await statusOf(cp, a.id)).toBe("idle"));
			const sessionsBefore = await query<{ n: string }>(cp, "select count(*) as n from sessions");
			const eventsBefore = (await rowsOf(cp, a.id)).length;
			const promptsBefore = assistant.prompts.length;
			// 助手服务的 `/health` 结果缓存 5 秒（控制面的时钟是手动的）：前面的用例留下的「连不上」不能算在这个用例头上。
			(cp.clock as ManualClock).advance(10_000);
			// 助手服务的 /health 和命令都通，只有事件流连不上。
			assistant.eventsStatus = 503;
			assistant.dropStreams();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			const list = await json<{
				readiness: { ready: boolean; problems: Array<{ kind: string; message: string }> };
			}>(await api.get("/projects/default/sessions"));
			expect(list.readiness.ready).toBe(false);
			expect(list.readiness.problems).toEqual([
				expect.objectContaining({
					kind: "assistant_unreachable",
					message: expect.stringContaining("事件流还没有连上"),
				}),
			]);
			// 建会话：503，没有建出会话、没有交给助手服务。
			const created = await create("乙");
			expect(created.status).toBe(503);
			const body = await json<{ error: { code: string; message: string } }>(created);
			expect(body.error.code).toBe("assistant_unavailable");
			expect(body.error.message).toContain("事件流还没有连上");
			expect((await query<{ n: string }>(cp, "select count(*) as n from sessions"))[0]).toEqual(
				sessionsBefore[0],
			);
			// 对空闲的会话说话：503，没有写 user_message、没有开始新的一轮。
			const said = await say(a.id, "接着做");
			expect(said.status).toBe(503);
			expect((await json<{ error: { code: string } }>(said)).error.code).toBe(
				"assistant_unavailable",
			);
			expect((await rowsOf(cp, a.id)).length).toBe(eventsBefore);
			expect(await statusOf(cp, a.id)).toBe("idle");
			expect(assistant.prompts.length).toBe(promptsBefore);
			// 连上之后才放行。
			assistant.eventsStatus = undefined;
			await eventually(() => expect(cp.current.assistantConnected()).toBe(true), 10_000);
			expect((await say(a.id, "接着做")).status).toBe(200);
			await eventually(() => expect(assistant.prompts.length).toBe(promptsBefore + 1));
			expect((await create("丙")).status).toBe(201);
		}, 30_000);

		it("事件流没连上期间项目的位置空出来：排队的会话不开始（开始了的话它的事件会丢），连上之后兜底的扫描才开始它", async () => {
			const first = await createOk("在做的");
			const second = await createOk("排队的");
			expect(await statusOf(cp, second.id)).toBe("queued");
			assistant.eventsStatus = 503;
			assistant.dropStreams();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			// 停止在做的那个：助手服务的结局带不回来（事件流断着），等宽限（测试里 300 毫秒）之后控制面自己补，项目的位置空出来。
			expect((await api.postEmpty(`/sessions/${first.id}/stop`, "alice")).status).toBe(200);
			await cp.current.sessionService.idle();
			expect(await statusOf(cp, first.id)).toBe("idle");
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(await statusOf(cp, second.id)).toBe("queued");
			expect(assistant.prompts.map((p) => p.sessionId)).toEqual([first.id]);
			// 连上之后：兜底的扫描（生产里每分钟，测试里手动调）开始排队的。
			assistant.eventsStatus = undefined;
			await eventually(() => expect(cp.current.assistantConnected()).toBe(true), 10_000);
			await cp.current.sessionService.startWaiting();
			await cp.current.sessionService.idle();
			await eventually(() =>
				expect(assistant.prompts.map((p) => p.sessionId)).toEqual([first.id, second.id]),
			);
		}, 30_000);

		it("连着的时候兜底照旧：超过 30 分钟没有动静的在做的会话按中断处理", async () => {
			const a = await createOk("甲");
			(cp.clock as ManualClock).advance(31 * 60_000);
			expect(await cp.current.sessionService.expireStale()).toBe(1);
			expect((await detail(a.id)).events.at(-1)).toMatchObject({
				type: "turn_end",
				outcome: "interrupted",
			});
		});
	});
});

describe("助手服务回来、事件连接还没重连上的这段时间", () => {
	it("事件流没连上时不开始新的一轮（503）；万一有一轮在这段时间开始了（绕过检查直接写），重连后 hello 的纪元变了，它不被当成「助手服务重启时在做的」", async () => {
		const assistant = await FakeAssistant.start();
		// 重连等得久：给「助手服务已经回来、事件连接还没重连」留出窗口。
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: "workbench-window",
			assistantReconnectMs: { min: 1500, max: 1500 },
		});
		const agent = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: "workbench-window", peer: { port: 7002, publicAddress: "10.0.0.6" } },
			{ clock: cp.clock },
		);
		try {
			await assistant.connected();
			const api = new ApiClient(asUsers(cp));
			const advance = () => (cp.clock as ManualClock).advance(1_000);
			const created = await json<SessionView>(
				await api.post("/projects/default/sessions", { text: "甲" }, "alice"),
			);
			advance();
			assistant.emit(created.id, 1, message("做着"));
			await eventually(async () =>
				expect(
					(await json<SessionDetailResponse>(await api.get(`/sessions/${created.id}`))).events.some(
						(e) => e.type === "assistant_message",
					),
				).toBe(true),
			);
			// 助手服务停了：事件连接断开（这一刻甲在做第 1 轮）；助手服务重启、回来；事件连接要 1.5 秒后才重连。
			await assistant.stop();
			await eventually(() => expect(cp.current.assistantConnected()).toBe(false));
			// 甲在新的助手服务回来之前被用户停止：助手服务不通，控制面等宽限（测试里 300 毫秒）之后自己补 stopped。
			expect((await api.postEmpty(`/sessions/${created.id}/stop`, "alice")).status).toBe(200);
			expect(await statusOf(cp, created.id)).toBe("idle");
			assistant.restartService();
			await assistant.resume();
			// 事件连接还没重连：用户马上接着说（助手服务回来了，`/health` 通），503，不开始新的一轮（开始了的话助手服务发出的事件到不了控制面）。
			expect(cp.current.assistantConnected()).toBe(false);
			advance();
			(cp.clock as ManualClock).advance(10_000); // `/health` 的缓存过期，看到的是助手服务回来了
			const refused = await api.post(
				`/sessions/${created.id}/messages`,
				{ text: "接着做" },
				"alice",
			);
			expect(refused.status).toBe(503);
			expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
				"assistant_unavailable",
			);
			expect(await statusOf(cp, created.id)).toBe("idle");
			expect(assistant.prompts.map((p) => p.body.turn)).toEqual([1]);
			// 检查和开始之间事件流恰好断了的那一瞬（绕过检查直接写）：这一轮是在新的助手服务上开始的。
			const begun = await cp.current.sessions.beginTurn(created.id, "default" as ProjectId, {
				type: "user_message",
				message_id: randomUUID(),
				text: "接着做",
				steer: false,
				author: "alice",
				author_user_id: null,
			});
			expect(begun.outcome).toBe("started");
			expect(await statusOf(cp, created.id)).toBe("running");
			// 事件连接重连上，hello 的纪元变了：连接断开那一刻在做的是甲的第 1 轮，这一轮（第 2 轮）没有被打断。
			await eventually(() => expect(cp.current.assistantConnected()).toBe(true), 15_000);
			expect(await statusOf(cp, created.id)).toBe("running");
			const events = (await json<SessionDetailResponse>(await api.get(`/sessions/${created.id}`)))
				.events;
			expect(
				events.filter((e) => e.type === "turn_end").map((e) => (e as { outcome: string }).outcome),
			).toEqual(["stopped"]);
		} finally {
			await agent.disconnect();
			await cp.close();
			await assistant.close();
		}
	}, 60_000);
});

describe("控制面刚启动、事件流还没连上（#760 审查查到的现象）", () => {
	it("刚启动时助手服务已经好了、事件流还没连上：就绪状态写连不上、建会话 503，一条事件也不会因此丢；事件流连上之后才放行，这一轮的工具调用在时间线上", async () => {
		const assistant = await FakeAssistant.start();
		// 事件流先连不上（命令和 /health 都通）：控制面按 1 到 30 秒的间隔退避重连，这里压到 150 毫秒。
		assistant.eventsStatus = 503;
		const cp = await startTestControlPlane({
			assistantUrl: assistant.url,
			assistantSecret: assistant.secret,
			workbenchAgent: "workbench-boot",
			assistantReconnectMs: { min: 150, max: 150 },
			waitForAssistant: false,
		});
		const agent = await FakeAgent.connect(
			cp.grpcUrl,
			{ name: "workbench-boot", peer: { port: 7003, publicAddress: "10.0.0.7" } },
			{ clock: cp.clock },
		);
		try {
			const api = new ApiClient(asUsers(cp));
			expect(cp.current.assistantConnected()).toBe(false);
			const list = await json<{
				readiness: { ready: boolean; problems: Array<{ kind: string; message: string }> };
			}>(await api.get("/projects/default/sessions"));
			expect(list.readiness.ready).toBe(false);
			expect(list.readiness.problems.map((p) => p.kind)).toEqual(["assistant_unreachable"]);
			const refused = await api.post("/projects/default/sessions", { text: "甲" }, "alice");
			expect(refused.status).toBe(503);
			expect((await json<{ error: { code: string } }>(refused)).error.code).toBe(
				"assistant_unavailable",
			);
			// 没有建出会话，也没有交给助手服务。
			expect(await query(cp, "select id from sessions")).toEqual([]);
			expect(assistant.prompts).toHaveLength(0);
			// 事件流连上之后才放行：这一轮的工具调用到得了控制面。
			assistant.eventsStatus = undefined;
			await eventually(() => expect(cp.current.assistantConnected()).toBe(true), 10_000);
			const created = await api.post("/projects/default/sessions", { text: "甲" }, "alice");
			expect(created.status).toBe(201);
			const view = await json<SessionView>(created);
			assistant.emit(view.id, 1, {
				type: "tool_call",
				call_id: "c1",
				tool: "command",
				title: "ls",
			});
			await eventually(async () =>
				expect(
					(await json<SessionDetailResponse>(await api.get(`/sessions/${view.id}`))).events.map(
						(e) => e.type,
					),
				).toContain("tool_call"),
			);
		} finally {
			await agent.disconnect();
			await cp.close();
			await assistant.close();
		}
	}, 60_000);
});
