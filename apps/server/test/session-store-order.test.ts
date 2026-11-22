// 会话事件的落库和发布顺序（src/sessions/session-store.ts，规格 #541 第二个 PR）：同一个会话的「落库加发布」在进程内依次执行，
// 发布的顺序就是提交的顺序；补发读库排在同一条链上，读不到「已经提交、但还没发布」的事件；同一轮的 turn_end 只记一条。
// 真实数据库；`SessionStoreDeps.afterCommit` 是测试用的缝，让一条事件停在「已提交、未发布」之间。
import type { PersistedSessionEvent, SessionEvent } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT } from "../src/projects/project-id.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { eventually } from "./support/eventually.js";
import { ManualClock } from "./support/manual-clock.js";
import { messageId } from "./support/sessions.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const userBody = (n: number) => ({
	type: "user_message" as const,
	message_id: messageId(n % 9),
	text: `第 ${n} 句`,
	steer: false,
	author: "alice",
	author_user_id: null,
});
const turnEnd = (turn: number, outcome: "completed" | "stopped" = "completed") =>
	({ type: "turn_end" as const, turn, outcome, reason: "x", duration_ms: 1 }) as const;

/** 一个可以停住的点。 */
function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

const settle = async (turns = 10) => {
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe("会话事件的落库和发布顺序", () => {
	let testDb: TestDatabase;
	let database: ReturnType<typeof openDatabase>;
	/** 每个用例换一个：afterCommit 在构造时给。 */
	let hold: ((sessionId: string, event: PersistedSessionEvent) => Promise<void>) | undefined;
	let store: SessionStore;

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		store = new SessionStore({
			db: database.db,
			clock: new ManualClock(new Date("2026-01-01T00:00:00.000Z")),
			afterCommit: (sessionId, event) => hold?.(sessionId, event) ?? Promise.resolve(),
		});
	});
	afterAll(async () => {
		await database.close();
		await testDb.drop();
	});

	const newSession = async (status: "idle" | "running" = "idle") =>
		store.create({
			project: DEFAULT_PROJECT,
			title: "顺序",
			status,
			createdBy: "alice",
			createdByUserId: null,
		});

	/** 订阅一个会话的实时事件（和事件流的补发一起用 `store.follow`）。 */
	const collect = (sessionId: string, after = 0) => {
		const out: SessionEvent[] = [];
		const stop = store.follow(
			sessionId,
			after,
			{ emit: (event) => out.push(event), drained: () => Promise.resolve() },
			(error) => {
				throw error;
			},
		);
		return { out, stop };
	};
	const shape = (out: SessionEvent[]) => out.map((e) => ("seq" in e ? e.seq : e.type));

	it("并发写同一个会话：发布的顺序等于序号的顺序；前一条还没发布完，后一条不开始落库", async () => {
		const { id } = await newSession();
		const first = gate();
		let held = 0;
		hold = async (_id, event) => {
			if (event.seq === 1 && held++ === 0) await first.opened;
		};
		try {
			const { out, stop } = collect(id);
			await settle();
			// A 先提交（seq 1）、停在发布之前；B 同时开始。
			const a = store.append(id, userBody(1));
			await settle();
			const b = store.append(id, userBody(2));
			await new Promise((resolve) => setTimeout(resolve, 100));
			// B 在链上排着：A 没发布完，B 没有落库（不会抢在 A 前面发布）。
			expect((await store.after(id, 0, 10)).map((e) => e.seq)).toEqual([1]);
			expect(shape(out)).toEqual([]);
			first.open();
			expect([(await a).seq, (await b).seq]).toEqual([1, 2]);
			await eventually(() => expect(shape(out)).toEqual([1, 2]));
			stop();
		} finally {
			hold = undefined;
		}
	});

	it("很多个并发写：实时阶段收到的序号严格递增（不会序号大的先到、序号小的被去重丢掉）", async () => {
		const { id } = await newSession();
		const { out, stop } = collect(id);
		await settle();
		await Promise.all(Array.from({ length: 40 }, (_, i) => store.append(id, userBody(i))));
		await eventually(() => expect(shape(out)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1)));
		stop();
	});

	it("补发读库排在链上：读不到「已经提交、还没发布」的事件；它前面的增量不会跑到它后面，补发读到它之后实时来的也不重复", async () => {
		const { id } = await newSession();
		for (let n = 1; n <= 3; n++) await store.append(id, userBody(n));
		const publishing = gate();
		const committed = gate();
		hold = async (_id, event) => {
			if (event.seq === 4) {
				committed.open();
				await publishing.opened;
			}
		};
		try {
			// 第 4 条已经提交、停在发布之前。
			const fourth = store.append(id, userBody(4));
			await committed.opened;
			// 这时一个新的事件流打开：订阅，再补发读库。读库排在链上，等第 4 条发布完再读。
			const { out, stop } = collect(id, 3);
			// 一条增量在第 4 条之前发布（它属于第 4 条那条完整的消息：第 4 条的内容里已经有它）。
			store.publish(id, { type: "assistant_delta", text: "第 4 条之前的增量" });
			// 补发的读库排在第 4 条后面：这段时间里什么都没有读到、没有发出（读库是真的查询，等够久再断言）。
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(shape(out)).toEqual([]);
			publishing.open();
			await fourth;
			await eventually(() => expect(shape(out)).toEqual([4]));
			// 第 4 条只出现一次；它前面的增量已经过时，没有出现在它后面（补发读库是真的查询，等它回来再多等一会儿看有没有多的）。
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(shape(out)).toEqual([4]);
			// 补发完之后是实时的：后面的增量和第 5 条照常。
			store.publish(id, { type: "assistant_delta", text: "第 5 条之前的增量" });
			await store.append(id, userBody(5));
			await eventually(() => expect(shape(out)).toEqual([4, "assistant_delta", 5]));
			stop();
		} finally {
			hold = undefined;
		}
	});

	it("补发的两批之间落库的事件：补发的下一批读到它，实时来的又到一遍，只出现一次，也不会让后面的补发跳过（持久事件不重不漏）", async () => {
		const { id } = await newSession();
		// 450 条，补发每批 200 条：三批。直接写库造历史，比 450 次 append 快。
		await database.pool.query(
			`insert into session_events (session_id, seq, type, payload, created_at)
			select $1::uuid, i, 'user_message',
				jsonb_build_object('message_id', $2::text, 'text', 'x', 'steer', false, 'author', 'a', 'author_user_id', null),
				now()
			from generate_series(1, 450) i`,
			[id, messageId(1)],
		);
		const betweenBatches = gate();
		const sawFirstBatch = gate();
		let drains = 0;
		const out: SessionEvent[] = [];
		const stop = store.follow(
			id,
			0,
			{
				emit: (event) => out.push(event),
				drained: async () => {
					// 第一批发完、读第二批之前停住。
					if (++drains === 1) {
						sawFirstBatch.open();
						await betweenBatches.opened;
					}
				},
			},
			(error) => {
				throw error;
			},
		);
		try {
			await sawFirstBatch.opened;
			expect(shape(out)).toHaveLength(200);
			// 停住期间落库、发布第 451 条：补发还没读到它，它在缓冲里。
			await store.append(id, userBody(5));
			betweenBatches.open();
			await eventually(() => expect(out.length).toBeGreaterThanOrEqual(451));
			await new Promise((resolve) => setTimeout(resolve, 100));
			// 1 到 451 各一次、按序：第三批也读到了 451，缓冲里的那条被按 seq 去掉；它没有把「已经发到哪」推到 451，
			// 所以第二批（201–400）没有被跳过。
			expect(shape(out)).toEqual(Array.from({ length: 451 }, (_, i) => i + 1));
		} finally {
			stop();
		}
	});

	it("链上有一个失败的不会堵住后面的：会话不存在时抛错，同一个会话 ID 上的下一个写入照常", async () => {
		const missing = "00000000-0000-4000-8000-00000000dead";
		await expect(store.append(missing, userBody(1))).rejects.toThrow();
		const { id } = await newSession();
		const results = await Promise.allSettled([
			store.append(missing, userBody(1)),
			store.append(id, userBody(1)),
			store.append(missing, userBody(2)),
			store.append(id, userBody(2)),
		]);
		expect(results.map((r) => r.status)).toEqual([
			"rejected",
			"fulfilled",
			"rejected",
			"fulfilled",
		]);
		expect((await store.after(id, 0, 10)).map((e) => e.seq)).toEqual([1, 2]);
	});

	it("同一轮的 turn_end 只记一条：后到的不记、不发布，返回已有的；不会把下一轮改回空闲", async () => {
		const { id } = await newSession("running");
		const { out, stop } = collect(id);
		await settle();
		const first = await store.append(id, turnEnd(1, "stopped"));
		const status = async () => (await store.find(id))?.status;
		expect(await status()).toBe("idle");
		// 同一轮的第二条（晚到的助手服务的结局）：不记。
		const late = await store.append(id, turnEnd(1, "completed"));
		expect(late.seq).toBe(first.seq);
		expect(late).toMatchObject({ type: "turn_end", turn: 1, outcome: "stopped" });
		expect((await store.after(id, 0, 10)).filter((e) => e.type === "turn_end")).toHaveLength(1);
		await eventually(() => expect(shape(out)).toEqual([1]));
		// 第 2 轮开始（会话在做）后，晚到的第 1 轮结局不会把它改回空闲。
		await store.beginTurn(id, DEFAULT_PROJECT);
		expect(await status()).toBe("running");
		await store.append(id, turnEnd(1, "completed"));
		expect(await status()).toBe("running");
		// 第 2 轮自己的结局照常记、照常改回空闲。
		const second = await store.append(id, turnEnd(2));
		expect(second.seq).toBe(2);
		expect(await status()).toBe("idle");
		stop();
	});
});
