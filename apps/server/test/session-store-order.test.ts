// 会话事件的落库和发布顺序（src/sessions/session-store.ts，规格 #541 第二个 PR）：同一个会话的「落库加发布」在进程内依次执行，
// 发布的顺序就是提交的顺序；补发读库排在同一条链上，读不到「已经提交、但还没发布」的事件；同一轮的 turn_end 只记一条。
// 真实数据库；`SessionStoreDeps.afterCommit` 是测试用的缝，让一条事件停在「已提交、未发布」之间。
import { randomUUID } from "node:crypto";
import type { PersistedSessionEvent, SessionEvent } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { DEFAULT_PROJECT, type ProjectId } from "../src/projects/project-id.js";
import { ProjectBusyError, SessionStore } from "../src/sessions/session-store.js";
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
	/** 每个用例换一个：afterDetailRow 在构造时给。 */
	let holdDetail: ((sessionId: string) => Promise<void>) | undefined;
	let store: SessionStore;

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		store = new SessionStore({
			db: database.db,
			clock: new ManualClock(new Date("2026-01-01T00:00:00.000Z")),
			afterCommit: (sessionId, event) => hold?.(sessionId, event) ?? Promise.resolve(),
			afterDetailRow: (sessionId) => holdDetail?.(sessionId) ?? Promise.resolve(),
		});
	});
	afterAll(async () => {
		await database.close();
		await testDb.drop();
	});

	const newSession = async (
		status: "idle" | "running" = "idle",
		project: ProjectId = DEFAULT_PROJECT,
	) =>
		store.create({
			project,
			title: "顺序",
			status,
			createdBy: "alice",
			createdByUserId: null,
		});

	/** 一个新项目：每个用例用自己的，「每个项目至多一个在做」的约束互不影响。 */
	const newProject = async (): Promise<ProjectId> => {
		const id = `p-${randomUUID().slice(0, 8)}`;
		await database.pool.query(
			"insert into projects (id, display_name, created_at) values ($1, $1, now())",
			[id],
		);
		return id as ProjectId;
	};

	/** 一轮开头的事件：用户的话和这一轮的开始。 */
	const opening = (turn: number) => [userBody(turn), { type: "turn_started" as const, turn }];

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

	describe("平台记录：事务里不占链，推送的顺序仍然等于序号的顺序", () => {
		/** 在事务里写一条平台记录（和引擎、场景存储一样），返回提交之后的事件；推送由调用方什么时候交给 `announce` 决定。 */
		const record = (sessionId: string, n: number) =>
			database.db.transaction((tx) =>
				store.recordPlatform(tx, sessionId, {
					kind: "run",
					run_id: randomUUID(),
					scenario_name: `场景${n}`,
				}),
			);

		it("序号小的先提交、推送却晚到：序号大的先推送时，从库里把序号小的补上，按序号推，不重（订阅的一方看到 1、2）", async () => {
			const { id } = await newSession();
			const { out, stop } = collect(id);
			await settle();
			const first = await record(id, 1);
			const second = await record(id, 2);
			expect([first.seq, second.seq]).toEqual([1, 2]);
			store.announce(id, second);
			await eventually(() => expect(shape(out)).toEqual([1, 2]));
			// 序号小的那一条的推送这时才到：已经推过了，不再推。
			store.announce(id, first);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(shape(out)).toEqual([1, 2]);
			stop();
		});

		it("助手事件抢在已经提交的平台记录的推送之前：先推平台记录（从库里补），再推助手事件，每条一次", async () => {
			const { id } = await newSession("running", await newProject());
			const { out, stop } = collect(id);
			await settle();
			const platform = await record(id, 1);
			// 平台记录提交了、还没推送；助手事件（序号 2）落库、推送。
			const appended = await store.append(id, userBody(1));
			expect([platform.seq, appended.seq]).toEqual([1, 2]);
			await eventually(() => expect(shape(out)).toEqual([1, 2]));
			store.announce(id, platform);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(shape(out)).toEqual([1, 2]);
			stop();
		});

		it("提交了、推送之前进程停了：事件在库里，新的进程里订阅的一方从库里补发读到它", async () => {
			const { id } = await newSession();
			const lost = await record(id, 1);
			// 「重启」：新的会话存储（没有推送的状态），订阅从头补发。
			const restarted = new SessionStore({
				db: database.db,
				clock: new ManualClock(new Date("2026-01-01T00:00:00.000Z")),
			});
			const out: SessionEvent[] = [];
			const stop = restarted.follow(
				id,
				0,
				{ emit: (event) => out.push(event), drained: () => Promise.resolve() },
				(error) => {
					throw error;
				},
			);
			await eventually(() => expect(shape(out)).toEqual([lost.seq]));
			// 之后的事件接着推，序号连续。
			await restarted.append(id, userBody(2));
			await eventually(() => expect(shape(out)).toEqual([1, 2]));
			stop();
		});

		it("推送中途失败：指针不前进，下一条事件推送时从库里补上没推出去的（订阅的一方看到的序号连续，按序号）", async () => {
			const { id } = await newSession("running", await newProject());
			const { out, stop } = collect(id);
			await settle();
			let failures = 0;
			hold = async (_id, event) => {
				if (event.type === "platform" && failures++ === 0) throw new Error("推送坏了");
			};
			try {
				const lost = await record(id, 1);
				store.announce(id, lost);
				await settle(50);
				expect(shape(out)).toEqual([]);
				await store.append(id, userBody(1));
				await eventually(() => expect(shape(out)).toEqual([1, 2]));
			} finally {
				hold = undefined;
			}
			stop();
		});

		it("事务回滚：登记的序号不留下痕迹，同一个序号的下一条事件照常直接推送", async () => {
			const { id } = await newSession("running", await newProject());
			const { out, stop } = collect(id);
			await settle();
			await expect(
				database.db.transaction(async (tx) => {
					await store.recordPlatform(tx, id, {
						kind: "run",
						run_id: randomUUID(),
						scenario_name: "回滚的",
					});
					throw new Error("提交之前出错");
				}),
			).rejects.toThrow("提交之前出错");
			expect(await store.after(id, 0, 10)).toEqual([]);
			await store.append(id, userBody(1));
			await eventually(() => expect(shape(out)).toEqual([1]));
			stop();
		});

		it("平台记录和助手事件并发写同一个会话，推送乱序到达：序号连续（行锁分配），订阅的一方按序号一条不少、一条不重", async () => {
			const { id } = await newSession("running", await newProject());
			const { out, stop } = collect(id);
			await settle();
			const platforms = await Promise.all(Array.from({ length: 10 }, (_, i) => record(id, i)));
			const appended = await Promise.all(
				Array.from({ length: 10 }, (_, i) => store.append(id, userBody(i))),
			);
			const seqs = [...platforms, ...appended].map((e) => e.seq).sort((a, b) => a - b);
			expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
			// 平台记录的推送倒着到。
			for (const event of [...platforms].reverse()) store.announce(id, event);
			await eventually(() =>
				expect(shape(out)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)),
			);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(shape(out)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
			stop();
		});

		it("推送指针的清理只清闲置的、不清还在用的：指针多到上限时，有已提交、还没推送的事件的会话，它的指针还在，后到的推送仍然从库里补齐", async () => {
			const sweeping = new SessionStore({
				db: database.db,
				clock: new ManualClock(new Date("2026-01-01T00:00:00.000Z")),
				cursorSweepSize: 2,
			});
			const { id } = await newSession("running", await newProject());
			const out: SessionEvent[] = [];
			const stop = sweeping.follow(
				id,
				0,
				{ emit: (event) => out.push(event), drained: () => Promise.resolve() },
				(error) => {
					throw error;
				},
			);
			await settle();
			const recordIn = (sessionId: string, n: number) =>
				database.db.transaction((tx) =>
					sweeping.recordPlatform(tx, sessionId, {
						kind: "run",
						run_id: randomUUID(),
						scenario_name: `场景${n}`,
					}),
				);
			const first = await recordIn(id, 1);
			const second = await recordIn(id, 2);
			// 别的会话的写把指针数推过上限（2）：清理这时跑，只清闲置的，这个会话的指针刚用过，不能清。
			for (let i = 0; i < 3; i++) {
				const other = await newSession("running", await newProject());
				await sweeping.append(other.id, userBody(i));
			}
			sweeping.announce(id, second);
			await eventually(() => expect(shape(out)).toEqual([1, 2]));
			sweeping.announce(id, first);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(shape(out)).toEqual([1, 2]);
			stop();
		});

		it("会话那一行的锁强度是 FOR NO KEY UPDATE：和外键检查加的共享锁（FOR KEY SHARE）不冲突，写事件的事务和插入带会话引用的行的事务互不等待", async () => {
			const { id } = await newSession("running", await newProject());
			const locker = await database.pool.connect();
			const sharer = await database.pool.connect();
			try {
				// 写事件的事务：锁会话那一行（和 recordPlatform、append 一样）。
				await locker.query("begin");
				await locker.query("select id from sessions where id = $1 for no key update", [id]);
				// 插入带会话引用的行（runs.session_id、orchestration_versions.session_id、api_tokens 的组合外键）时，外键检查给这一行加共享锁。
				await sharer.query("begin");
				await sharer.query("set local lock_timeout = '300ms'");
				await sharer.query("select id from sessions where id = $1 for key share", [id]);
				await sharer.query("rollback");
				// 反过来：先有共享锁，写事件的事务也不用等它。
				await locker.query("rollback");
				await sharer.query("begin");
				await sharer.query("select id from sessions where id = $1 for key share", [id]);
				await locker.query("begin");
				await locker.query("set local lock_timeout = '300ms'");
				await locker.query("select id from sessions where id = $1 for no key update", [id]);
				await locker.query("rollback");
				await sharer.query("rollback");
			} finally {
				locker.release();
				sharer.release();
			}
		});
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

	it("读一个会话（detail）：状态、事件的一页、上一轮的结局取自同一个快照；读的当中这一轮结束了，三样都还是读之前的样子，不会是「状态在做、事件里已经有 turn_end」", async () => {
		const project = await newProject();
		const { id } = await newSession("idle", project);
		await store.beginTurn(id, project, opening);
		// 读到会话那一行之后、读事件之前，这一轮的 turn_end 在另一个连接上提交了。
		holdDetail = async (sessionId) => {
			await store.append(sessionId, turnEnd(1));
		};
		try {
			const during = await store.detail(id);
			expect(during?.row.status).toBe("running");
			expect(during?.events.map((e) => e.type)).toEqual(["user_message", "turn_started"]);
			expect(during?.lastOutcome).toBeNull();
		} finally {
			holdDetail = undefined;
		}
		// 之后再读：三样都是结束之后的样子。
		const after = await store.detail(id);
		expect(after?.row.status).toBe("idle");
		expect(after?.events.map((e) => e.type)).toEqual(["user_message", "turn_started", "turn_end"]);
		expect(after?.lastOutcome).toBe("completed");
		// 不存在的会话：undefined。
		expect(await store.detail(randomUUID())).toBeUndefined();
	});

	it("同一轮的 turn_end 只记一条：后到的不记、不发布，返回已有的；不会把下一轮改回空闲", async () => {
		const project = await newProject();
		const { id } = await newSession("idle", project);
		const { out, stop } = collect(id);
		await settle();
		const status = async () => (await store.find(id))?.status;
		await store.beginTurn(id, project, opening);
		const first = await store.append(id, turnEnd(1, "stopped"));
		expect(await status()).toBe("idle");
		// 同一轮的第二条（晚到的助手服务的结局）：不记。
		const late = await store.append(id, turnEnd(1, "completed"));
		expect(late.seq).toBe(first.seq);
		expect(late).toMatchObject({ type: "turn_end", turn: 1, outcome: "stopped" });
		expect((await store.after(id, 0, 10)).filter((e) => e.type === "turn_end")).toHaveLength(1);
		await eventually(() => expect(shape(out)).toEqual([1, 2, 3]));
		// 第 2 轮开始（会话在做）后，晚到的第 1 轮结局不会把它改回空闲。
		await store.beginTurn(id, project, opening);
		expect(await status()).toBe("running");
		await store.append(id, turnEnd(1, "completed"));
		expect(await status()).toBe("running");
		// 第 2 轮自己的结局照常记、照常改回空闲。
		const second = await store.append(id, turnEnd(2));
		expect(second.seq).toBe(6);
		expect(await status()).toBe("idle");
		stop();
	});

	describe("一轮的开始和结束：轮次、状态、事件在一个事务里", () => {
		const count = async (project: ProjectId) =>
			(
				await database.pool.query("select count(*)::int as n from sessions where project_id = $1", [
					project,
				])
			).rows[0].n as number;
		const eventsOf = async (id: string) => (await store.after(id, 0, 100)).map((e) => e.type);

		it("beginTurn：改成在做、轮次加一、用户的话和一轮开始一起落库；已经在做、已结束的不动，返回当时的状态", async () => {
			const project = await newProject();
			const { id } = await newSession("idle", project);
			const first = await store.beginTurn(id, project, opening);
			expect(first).toMatchObject({ started: true, turn: 1 });
			expect(first.started && first.events.map((e) => e.type)).toEqual([
				"user_message",
				"turn_started",
			]);
			expect(await store.find(id)).toMatchObject({ status: "running", currentTurn: 1 });
			expect(await store.beginTurn(id, project, opening)).toEqual({
				started: false,
				status: "running",
			});
			await database.pool.query("update sessions set status = 'ended' where id = $1", [id]);
			expect(await store.beginTurn(id, project, opening)).toEqual({
				started: false,
				status: "ended",
			});
			expect(await eventsOf(id)).toEqual(["user_message", "turn_started"]);
		});

		it("beginTurn 中途出错（事件过不了 schema）：整个事务回滚，会话还是空闲、轮次没动、一条事件也没有，项目没被占着", async () => {
			const project = await newProject();
			const { id } = await newSession("idle", project);
			await expect(
				store.beginTurn(id, project, (turn) => [
					userBody(1),
					{ type: "turn_started", turn: -turn } as never,
				]),
			).rejects.toThrow();
			expect(await store.find(id)).toMatchObject({ status: "idle", currentTurn: 0 });
			expect(await eventsOf(id)).toEqual([]);
			expect(await store.running(project)).toBeUndefined();
			// 之后照常能开始。
			expect(await store.beginTurn(id, project, opening)).toMatchObject({ started: true, turn: 1 });
		});

		it("项目里已经有在做的会话：别的会话 beginTurn 抛 ProjectBusyError，整个事务回滚，没有事件也没有改状态", async () => {
			const project = await newProject();
			const a = await newSession("idle", project);
			const b = await newSession("idle", project);
			await store.beginTurn(a.id, project, opening);
			await expect(store.beginTurn(b.id, project, opening)).rejects.toBeInstanceOf(
				ProjectBusyError,
			);
			expect(await store.find(b.id)).toMatchObject({ status: "idle", currentTurn: 0 });
			expect(await eventsOf(b.id)).toEqual([]);
		});

		it("createWithTurn：会话、用户的话、一轮开始在一个事务里；撞上在做的会话、或者事件写不进去，都不留下行", async () => {
			const project = await newProject();
			const input = { project, title: "新", createdBy: "alice", createdByUserId: null };
			const created = await store.createWithTurn(input, opening);
			expect(created.session).toMatchObject({ status: "running", currentTurn: 1 });
			expect(created.events.map((e) => e.type)).toEqual(["user_message", "turn_started"]);
			expect(await count(project)).toBe(1);
			// 项目里已经有在做的：409，不留下行。
			await expect(store.createWithTurn(input, opening)).rejects.toBeInstanceOf(ProjectBusyError);
			expect(await count(project)).toBe(1);
			// 另一个项目：事件过不了 schema，整个事务回滚，不留下会话。
			const other = await newProject();
			await expect(
				store.createWithTurn({ ...input, project: other }, () => [{ type: "nope" } as never]),
			).rejects.toThrow();
			expect(await count(other)).toBe(0);
		});

		it("控制面结束一轮带上轮次：结束的是此刻在做的那一轮；这一轮已经有结局但会话还在做（不一致）时，也改回空闲", async () => {
			const project = await newProject();
			const { id } = await newSession("idle", project);
			await store.beginTurn(id, project, opening);
			// 不一致的状态：这一轮已经有 turn_end，会话却还是在做（旧版本的 bug 留下的）。
			await database.pool.query(
				`insert into session_events (session_id, seq, type, payload, created_at)
				values ($1, 3, 'turn_end', '{"turn":1,"outcome":"failed","reason":"x","duration_ms":1}', now())`,
				[id],
			);
			expect((await store.find(id))?.status).toBe("running");
			const again = await store.append(id, turnEnd(1, "stopped"));
			// 返回已有的那条，不再多记一条；状态回到空闲。
			expect(again).toMatchObject({ seq: 3, outcome: "failed" });
			expect(await eventsOf(id)).toEqual(["user_message", "turn_started", "turn_end"]);
			expect((await store.find(id))?.status).toBe("idle");
			// 第 2 轮开始之后，再来结束第 1 轮（迟到的、重复的）动不了它。
			await store.beginTurn(id, project, opening);
			await store.append(id, turnEnd(1, "stopped"));
			expect(await store.find(id)).toMatchObject({ status: "running", currentTurn: 2 });
		});

		it("在做、但一条 turn_started 都没有的旧数据（回填成 0）：控制面结束它之后 current_turn 抬到这一轮，下一轮是第 2 轮，那一轮真正的 turn_end 照常记", async () => {
			const project = await newProject();
			const { id } = await newSession("running", project);
			expect(await store.find(id)).toMatchObject({ status: "running", currentTurn: 0 });
			await store.append(id, turnEnd(1, "stopped"));
			expect(await store.find(id)).toMatchObject({ status: "idle", currentTurn: 1 });
			// 重复的第 1 轮结局：不再记，也不动 current_turn。
			await store.append(id, turnEnd(1, "completed"));
			expect(await store.find(id)).toMatchObject({ status: "idle", currentTurn: 1 });
			const begun = await store.beginTurn(id, project, opening);
			expect(begun).toMatchObject({ started: true, turn: 2 });
			const at = new Date("2026-01-01T00:00:00.000Z");
			// 第 2 轮真正的结局不会被当成重复吞掉。
			expect(await store.appendFromAssistant(id, 2, turnEnd(2), at)).toMatchObject({
				stored: { type: "turn_end", turn: 2 },
			});
			expect(await store.find(id)).toMatchObject({ status: "idle", currentTurn: 2 });
		});

		it("同样的旧数据，这一轮已经有 turn_end（旧版本留下的不一致）：回到空闲的同时 current_turn 也抬到这一轮", async () => {
			const project = await newProject();
			const { id } = await newSession("running", project);
			await database.pool.query(
				`insert into session_events (session_id, seq, type, payload, created_at)
				values ($1, 1, 'turn_end', '{"turn":1,"outcome":"failed","reason":"x","duration_ms":1}', now())`,
				[id],
			);
			const again = await store.append(id, turnEnd(1, "stopped"));
			expect(again).toMatchObject({ seq: 1, outcome: "failed" });
			expect(await store.find(id)).toMatchObject({ status: "idle", currentTurn: 1 });
			expect(await store.beginTurn(id, project, opening)).toMatchObject({ started: true, turn: 2 });
		});

		it("助手服务发来的事件：会话不存在、不在做、不是此刻在做的那一轮都丢掉，不落库、不发布、不改状态；对的那一轮才收", async () => {
			const project = await newProject();
			const { id } = await newSession("idle", project);
			const { out, stop } = collect(id);
			await settle();
			const message = {
				type: "assistant_message" as const,
				text: "好",
				usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
			};
			const delta = { type: "assistant_delta" as const, text: "好" };
			const at = new Date("2026-01-01T00:00:00.000Z");
			// 会话不存在。
			expect(await store.appendFromAssistant(randomUUID(), 1, message, at)).toEqual({
				dropped: "unknown_session",
			});
			expect(await store.publishFromAssistant(randomUUID(), 1, delta)).toEqual({
				dropped: "unknown_session",
			});
			// 空闲：不在做。
			expect(await store.appendFromAssistant(id, 1, message, at)).toEqual({
				dropped: "not_running",
			});
			expect(await store.appendFromAssistant(id, 1, turnEnd(1), at)).toEqual({
				dropped: "not_running",
			});
			expect(await store.publishFromAssistant(id, 1, delta)).toEqual({ dropped: "not_running" });
			// 第 1 轮在做：第 1 轮的收，别的轮次丢。
			await store.beginTurn(id, project, opening);
			expect(await store.appendFromAssistant(id, 2, message, at)).toEqual({
				dropped: "other_turn",
			});
			expect(await store.publishFromAssistant(id, 0, delta)).toEqual({ dropped: "other_turn" });
			expect(await store.appendFromAssistant(id, 7, turnEnd(7), at)).toEqual({
				dropped: "other_turn",
			});
			expect((await store.find(id))?.status).toBe("running");
			expect(await store.appendFromAssistant(id, 1, message, at)).toMatchObject({
				stored: { type: "assistant_message", seq: 3 },
			});
			expect(await store.publishFromAssistant(id, 1, delta)).toEqual({ published: true });
			// 第 1 轮的结局：会话回到空闲；之后这一轮迟到的事件丢掉。
			expect(await store.appendFromAssistant(id, 1, turnEnd(1), at)).toMatchObject({
				stored: { turn: 1 },
			});
			expect((await store.find(id))?.status).toBe("idle");
			expect(await store.appendFromAssistant(id, 1, message, at)).toEqual({
				dropped: "not_running",
			});
			// 第 2 轮在做：第 1 轮迟到的事件丢掉（不是此刻在做的那一轮）。
			await store.beginTurn(id, project, opening);
			expect(await store.appendFromAssistant(id, 1, message, at)).toEqual({
				dropped: "other_turn",
			});
			expect(await store.publishFromAssistant(id, 1, delta)).toEqual({ dropped: "other_turn" });
			// 已结束的会话也不收。
			await store.append(id, turnEnd(2));
			await database.pool.query("update sessions set status = 'ended' where id = $1", [id]);
			expect(await store.appendFromAssistant(id, 2, message, at)).toEqual({
				dropped: "not_running",
			});
			// 落库和发布的，只有对的那一轮的：用户的话 1、一轮开始 2、助手的消息 3、增量、第 1 轮结局 4，第 2 轮的开头 5、6、结局 7。
			await eventually(() => expect(shape(out)).toEqual([1, 2, 3, "assistant_delta", 4, 5, 6, 7]));
			stop();
		});
	});
});
