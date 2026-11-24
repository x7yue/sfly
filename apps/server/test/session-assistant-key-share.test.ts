// 会话那一行上的外键检查的共享锁（`FOR KEY SHARE`，记着会话引用的行插入时由外键检查加上、持有到事务结束）和
// 助手事件的落库（规格 #547，审查 #616 第三轮）。助手服务发来的持久事件的几条路径（`append`、`appendFromAssistant`）给会话那一行
// 加的是 `FOR NO KEY UPDATE`，不和它冲突：同一个会话上有一个带会话令牌的写事务正拿着共享锁、还没提交时，助手事件照常落库，不等它；
// 反过来这个事务随后自己拿会话那一行的锁（分配序号），也不会和助手事件互相等（以前一个在库里等、一个在进程里等，数据库判不出死锁）。
// 真实数据库，直接用会话存储。
import type { SessionEventBody } from "@sfly/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import type { ProjectId } from "../src/projects/project-id.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { ManualClock } from "./support/manual-clock.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const notice = (message: string): SessionEventBody => ({
	type: "notice",
	kind: "compaction",
	message,
});

/** 等一个 Promise 最多 `ms` 毫秒：卡住时不挂住整个测试。 */
const within = <T>(
	promise: Promise<T>,
	ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> =>
	Promise.race([
		promise.then((value) => ({ ok: true as const, value })),
		sleep(ms).then(() => ({ ok: false as const })),
	]);

describe("助手事件的落库和外键检查的共享锁", () => {
	let testDb: TestDatabase;
	let database: ReturnType<typeof openDatabase>;
	let store: SessionStore;

	beforeAll(async () => {
		testDb = await createTestDatabase();
		database = openDatabase(testDb.url, () => {});
		await database.migrate();
		store = new SessionStore({
			db: database.db,
			clock: new ManualClock(new Date("2026-01-01T00:00:00.000Z")),
		});
	});
	afterAll(async () => {
		await database.close();
		await testDb.drop();
	});

	const newRunningSession = async () => {
		const project = `p-${Math.random().toString(36).slice(2, 10)}`;
		await database.pool.query(
			"insert into projects (id, display_name, created_at) values ($1, $1, now())",
			[project],
		);
		return store.create({
			project: project as ProjectId,
			title: "共享锁",
			status: "running",
			createdBy: "alice",
			createdByUserId: null,
		});
	};

	/** 模拟「插入带会话引用的行」的事务：外键检查给会话那一行加共享锁，事务还没结束。 */
	const holdKeyShare = async (sessionId: string) => {
		const client = await database.pool.connect();
		await client.query("begin");
		await client.query("select id from sessions where id = $1 for key share", [sessionId]);
		return client;
	};

	it("`appendFromAssistant`：共享锁还在时照常落库（2 秒内），不等那个事务", async () => {
		const { id } = await newRunningSession();
		const sharer = await holdKeyShare(id);
		try {
			const done = await within(
				store.appendFromAssistant(id, 1, notice("共享锁下"), new Date()),
				2000,
			);
			expect(done.ok, "助手事件在外键检查的共享锁下没有落库（锁的强度和它冲突）").toBe(true);
			expect(done.ok && "stored" in done.value).toBe(true);
		} finally {
			await sharer.query("rollback");
			sharer.release();
		}
	});

	it("`append`：共享锁还在时照常落库（2 秒内），不等那个事务", async () => {
		const { id } = await newRunningSession();
		const sharer = await holdKeyShare(id);
		try {
			const done = await within(store.append(id, notice("共享锁下")), 2000);
			expect(done.ok, "append 在外键检查的共享锁下没有落库（锁的强度和它冲突）").toBe(true);
		} finally {
			await sharer.query("rollback");
			sharer.release();
		}
	});

	it("共享锁的事务随后自己拿会话那一行的锁（分配序号）：和已经落库的助手事件不互相等，两边都完成，序号连续", async () => {
		const { id } = await newRunningSession();
		const sharer = await holdKeyShare(id);
		try {
			const appended = await within(
				store.appendFromAssistant(id, 1, notice("先落库的"), new Date()),
				2000,
			);
			expect(appended.ok).toBe(true);
			// 这个事务最后拿会话那一行的锁：助手事件已经提交，不用等；分配序号、写记录，然后提交。
			await sharer.query("set local lock_timeout = '2s'");
			const row = await sharer.query<{ last: number | null }>(
				"select coalesce(max(seq), 0) as last from session_events where session_id = $1",
				[id],
			);
			await sharer.query("select id from sessions where id = $1 for no key update", [id]);
			expect(row.rows[0]?.last).toBe(1);
			await sharer.query("commit");
		} finally {
			sharer.release();
		}
		const seqs = (await store.after(id, 0, 10)).map((e) => e.seq);
		expect(seqs).toEqual([1]);
	});
});
