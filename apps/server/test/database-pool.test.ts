// 数据库连接池里连接出错怎么处理（#563，docs/ARCHITECTURE.md §6.10），用真实的 PostgreSQL，不起控制面进程。
//
// 连接断了（数据库重启、`pg_terminate_backend`），pg 在这个连接上触发 `error` 事件。谁接着它，决定它是什么错误：
// - 空闲的连接：连接池自己接着（丢掉这个连接）；
// - `pool.query` 借出的连接（一条语句）：它自己接着（这条语句以错误结束）；
// - 借出去在事务里的连接（连接池和 drizzle 都没有挂处理）：没人接。以前这是未捕获的异常，进程在这一刻退出；
//   现在是 `onInUseError`，并且连接池在同一个调用栈里就结束了，之后那次操作的失败处理拿不到连接。
// - 数据库先发一条致命错误消息、再关连接（`pg_terminate_backend`、数据库正常关闭）：连接上有正在执行的语句时 pg 只让这条语句以错误结束、
//   不发 `error`（连接真的关闭时才发）；借出去的连接一收到这条消息就当作完了（`errorMessage` 钩子，依赖 pg 的内部，这里守着）。
import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, POOL_END_TIMEOUT_MS } from "../src/db/database.js";
import { orchestrations } from "../src/db/schema.js";
import { terminateActive, terminateIdle } from "./support/db-sabotage.js";
import { PgProxy } from "./support/pg-proxy.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 等 `read()` 变成 `expected`（最多 10 秒）。 */
async function eventuallyEqual(read: () => number, expected: number): Promise<void> {
	const until = Date.now() + 10_000;
	while (read() !== expected && Date.now() < until) await sleep(25);
}

describe("openDatabase：连接出错", () => {
	let database: TestDatabase;
	let errors: Error[];
	let fatal: Error[];

	beforeEach(async () => {
		database = await createTestDatabase("sfly_pool");
		errors = [];
		fatal = [];
		const migrator = openDatabase(database.url, () => {});
		await migrator.migrate();
		await migrator.close();
	}, 60_000);
	afterEach(async () => {
		await database.drop();
	});

	const open = (withFatal: boolean) =>
		openDatabase(
			database.url,
			(error) => errors.push(error),
			undefined,
			withFatal ? { onInUseError: (error) => fatal.push(error) } : {},
		);

	/** 借出一个连接（像 drizzle 的事务那样自己 `pool.connect()`、不挂任何处理），在里面开一个事务，等一下，返回它。 */
	async function borrowInTransaction(db: ReturnType<typeof open>) {
		const client = await db.pool.connect();
		await client.query("begin");
		return client;
	}

	it("借出去在事务里的连接被结束：调 onInUseError 一次，连接池同时结束，之后拿连接立刻失败", async () => {
		const db = open(true);
		await db.ping();
		const client = await borrowInTransaction(db);
		const backend = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]
			?.pid;

		await new pg.Client({ connectionString: database.url }).connect().then(async (admin) => {
			await admin.query("select pg_terminate_backend($1)", [backend]);
			await admin.end();
		});
		await sleep(300);

		expect(fatal).toHaveLength(1);
		// 连接池已经结束：之后新的取连接、执行语句的请求立刻以错误结束，不再碰数据库（已经借出去的连接不受影响，有序关闭等它们做完）。
		// drizzle 把语句的错误包了一层（Failed query），原因在 cause 里。
		const reason = (error: Error & { cause?: Error }) => error.cause?.message ?? error.message;
		expect(await db.db.select().from(orchestrations).catch(reason)).toMatch(/after calling end/);
		expect(await db.db.transaction(async () => {}).catch(reason)).toMatch(/after calling end/);
	}, 30_000);

	it("同一个调用栈里：连接池先结束，之后那次操作的失败处理（再拿连接、再写一笔）拿到的是「连接池已结束」", async () => {
		// 引擎写任务结果失败时的处理（#207）是再拿一个连接把这次尝试记成节点出错：这里它拿不到连接，什么都写不进去，
		// 和以前进程在 `error` 事件的那一刻退出一样，不会把 Agent 报来的成功记成失败。连接是被掐断的（网络中断）：
		// 用 TCP 转发在客户端发出这条语句的那一刻断开，次序和真的网络中断一样（见 database.ts 里写的顺序）。
		const proxy = await PgProxy.start(database.url);
		const db = openDatabase(proxy.urlFor(database.url), (error) => errors.push(error), undefined, {
			onInUseError: (error) => fatal.push(error),
		});
		try {
			await db.ping(); // 池里有一个空闲的连接：失败处理要是能拿到它，就写得进去
			const client = await borrowInTransaction(db);
			proxy.arm(/pg_sleep/, "drop");
			let afterFailure: string | undefined;

			await client.query("select pg_sleep(5)").catch(async () => {
				afterFailure = await db.db
					.transaction(async () => "wrote")
					.catch((error: Error) => error.message);
			});

			expect(fatal).toHaveLength(1);
			expect(afterFailure).toMatch(/after calling end/);
		} finally {
			await db.close();
			await proxy.close();
		}
	}, 30_000);

	describe("数据库先发致命错误消息、再关连接（pg_terminate_backend）", () => {
		// 引擎写任务结果失败时的处理（#207）是再拿一个连接把这次尝试记成节点出错：用「失败那一刻再开一个事务」代表它。
		// 次序守不住的话（连接池要等连接真的关闭的 `error` 才结束），这个事务借得到连接、写得进去。
		const afterFailure = (db: ReturnType<typeof open>) =>
			db.db.transaction(async () => "wrote").catch((error: Error) => error.message);

		it("事务中间的语句上收到：onInUseError 在这条语句的失败处理之前被调用，连接池那时已经结束", async () => {
			const db = open(true);
			await db.ping(); // 池里有一个空闲的连接：失败处理要是能拿到它，就写得进去
			const client = await borrowInTransaction(db);
			let after: string | undefined;
			let firedBeforeRejection: number | undefined;
			const outcome = client.query("select pg_sleep(30)").then(
				() => "ok",
				async () => {
					firedBeforeRejection = fatal.length;
					after = await afterFailure(db);
					return "failed";
				},
			);

			expect(await terminateActive(database.url, "pg_sleep")).toBe(1);

			expect(await outcome).toBe("failed");
			// 数据库发的是 FATAL 57P01，不是被掐断的连接（那种是 `error` 事件）：钩子在语句被拒绝之前就认出来了。
			expect(firedBeforeRejection).toBe(1);
			expect(fatal).toHaveLength(1);
			expect((fatal[0] as Error & { code?: string }).code).toBe("57P01");
			expect(after).toMatch(/after calling end/);
			// 连接真的关闭时 `error` 又来一次：只记日志，不再交给 onInUseError。
			await sleep(300);
			expect(fatal).toHaveLength(1);
			await db.close();
		}, 30_000);

		it("借出去的事务里空闲超过 idle_in_transaction_session_timeout：数据库发 FATAL 25P03、关连接，onInUseError 一次（真的数据库实测的 SQLSTATE）", async () => {
			const db = open(true);
			await db.ping();
			const client = await borrowInTransaction(db);
			await client.query("set local idle_in_transaction_session_timeout = 300");

			await eventuallyEqual(() => fatal.length, 1);

			expect((fatal[0] as Error & { code?: string }).code).toBe("25P03");
			await sleep(300);
			expect(fatal).toHaveLength(1);
			await db.close();
		}, 30_000);

		it("借出去的事务超过 transaction_timeout（PostgreSQL 17 起）：数据库发 FATAL 25P04、关连接，onInUseError 一次", async (context) => {
			const db = open(true);
			const version = Number(
				(await db.pool.query("show server_version_num")).rows[0]?.server_version_num,
			);
			if (version < 170_000) {
				await db.close();
				context.skip();
			}
			const client = await borrowInTransaction(db);
			await client.query("set local transaction_timeout = 300");
			const outcome = client.query("select pg_sleep(5)").then(
				() => "ok",
				() => "failed",
			);

			expect(await outcome).toBe("failed");
			await eventuallyEqual(() => fatal.length, 1);

			expect((fatal[0] as Error & { code?: string }).code).toBe("25P04");
			await db.close();
		}, 30_000);

		it("BEGIN 上收到（转发扣住 begin、按后端进程号结束这条连接）：同样先于失败处理，连接池已经结束", async () => {
			const proxy = await PgProxy.start(database.url);
			const db = openDatabase(
				proxy.urlFor(database.url),
				(error) => errors.push(error),
				undefined,
				{
					onInUseError: (error) => fatal.push(error),
				},
			);
			try {
				await db.ping();
				proxy.arm(/^begin/i, "terminate-backend");
				const client = await db.pool.connect();
				let after: string | undefined;
				let firedBeforeRejection: number | undefined;

				const outcome = await client.query("begin").then(
					() => "ok",
					async () => {
						firedBeforeRejection = fatal.length;
						after = await afterFailure(db);
						return "failed";
					},
				);

				expect(outcome).toBe("failed");
				expect(proxy.fired.map((f) => f.action)).toEqual(["terminate-backend"]);
				expect(firedBeforeRejection).toBe(1);
				expect((fatal[0] as Error & { code?: string }).code).toBe("57P01");
				expect(after).toMatch(/after calling end/);
			} finally {
				await db.close();
				await proxy.close();
			}
		}, 30_000);

		it("pool.query 借出的连接（单条语句）收到：这条语句以错误结束，不是 onInUseError，连接池照常可用", async () => {
			const db = open(true);
			const slow = db.pool.query("select pg_sleep(30)");
			const outcome = slow.then(
				() => "ok",
				() => "failed",
			);
			expect(await terminateActive(database.url, "pg_sleep")).toBe(1);

			expect(await outcome).toBe("failed");
			await sleep(300);

			expect(fatal).toEqual([]);
			expect(await db.ping()).toBe(true);
			await db.close();
		}, 30_000);

		it("空闲的连接收到：不是 onInUseError（连接池丢掉它）", async () => {
			const db = open(true);
			await db.ping();
			await sleep(200);

			expect(await terminateIdle(database.url)).toBeGreaterThanOrEqual(1);
			await sleep(300);

			expect(fatal).toEqual([]);
			expect(await db.ping()).toBe(true);
			await db.close();
		}, 30_000);
	});

	describe("哪些错误消息算「这条连接完了」", () => {
		/** 一个假的借出去的连接：只有我们挂的 `error` 处理（`listenerCount("error")` 为 1），`connection` 是 pg 收到错误消息时触发事件的对象。 */
		const fakeClient = () => {
			const connection = new EventEmitter();
			const client = new EventEmitter() as EventEmitter & { connection: EventEmitter };
			client.connection = connection;
			return client;
		};

		it.each([
			["FATAL", { severity: "FATAL", code: "57P01" }, true],
			["PANIC", { severity: "PANIC", code: "XX000" }, true],
			[
				"数据库用中文报的致命错误（severity 被翻译了），靠 SQLSTATE 57P01",
				{ severity: "致命错误", code: "57P01" },
				true,
			],
			["57P02（崩溃关闭）", { severity: "ERROR", code: "57P02" }, true],
			["57P03（现在不能连接）", { severity: "ERROR", code: "57P03" }, true],
			["57P04（库被删了）", { severity: "ERROR", code: "57P04" }, true],
			["57P05（空闲会话超时）", { severity: "ERROR", code: "57P05" }, true],
			// 数据库用中文报的：severity 是「致命错误」（实测，PostgreSQL 18、lc_messages=zh_CN.UTF-8），不认得，只能靠 SQLSTATE。
			// 事务里空闲超时、事务超时数据库发的也是 FATAL，然后关掉这条连接。
			["事务里空闲超时 25P03（中文的 severity）", { severity: "致命错误", code: "25P03" }, true],
			["事务超时 25P04（中文的 severity）", { severity: "致命错误", code: "25P04" }, true],
			["事务里空闲超时 25P03（英文的 severity）", { severity: "FATAL", code: "25P03" }, true],
			// 不是连接完了的：语句超时只取消这一条语句，连接还在。
			["语句超时（中文的 severity，57014）", { severity: "错误", code: "57014" }, false],
			[
				"事务里的另一种错误 25P02（事务已中止，中文的 severity）",
				{ severity: "错误", code: "25P02" },
				false,
			],
			["普通的错误（唯一约束）", { severity: "ERROR", code: "23505" }, false],
			["语句被取消（57014 不是连接完了）", { severity: "ERROR", code: "57014" }, false],
			["没有 severity 和 code", {}, false],
		] as const)("%s：%s", (_, message, ends) => {
			const db = open(true);
			const client = fakeClient();

			db.pool.emit("connect", client as unknown as pg.PoolClient);
			client.connection.emit("errorMessage", message);

			expect(fatal).toHaveLength(ends ? 1 : 0);
			void db.close();
		});

		it("有两个 error 处理（空闲的连接、pool.query 借出的连接）时不算：那两种预料之中", () => {
			const db = open(true);
			const client = fakeClient();
			client.on("error", () => {}); // 连接池或 pool.query 自己挂的那一个

			db.pool.emit("connect", client as unknown as pg.PoolClient);
			client.connection.emit("errorMessage", { severity: "FATAL", code: "57P01" });

			expect(fatal).toEqual([]);
			void db.close();
		});

		it("同一条连接上多次收到、之后又来 error 事件：只交给 onInUseError 一次，其余记日志", () => {
			const db = open(true);
			const client = fakeClient();
			db.pool.emit("connect", client as unknown as pg.PoolClient);

			client.connection.emit("errorMessage", { severity: "FATAL", code: "57P01" });
			client.connection.emit("errorMessage", { severity: "FATAL", code: "57P01" });
			client.emit("error", new Error("Connection terminated unexpectedly"));

			expect(fatal).toHaveLength(1);
			expect(errors.map((e) => e.message)).toEqual(["Connection terminated unexpectedly"]);
			void db.close();
		});

		it("pg 的连接对象没有 connection 事件源（升级 pg 之后内部变了）：报错，不悄悄少一道防线", () => {
			const db = open(true);
			const client = new EventEmitter();

			expect(() => db.pool.emit("connect", client as unknown as pg.PoolClient)).toThrow(
				"connection 事件源",
			);
			void db.close();
		});

		it("真实的 pg 连接：有 connection 事件源，收到错误消息时触发 errorMessage，带 severity 和 code", async () => {
			const client = new pg.Client({ connectionString: database.url });
			await client.connect();
			const seen: Array<{ severity?: string; code?: string }> = [];
			(client as unknown as { connection: EventEmitter }).connection.on("errorMessage", (message) =>
				seen.push(message),
			);

			await client.query("select no_such_column from no_such_table").catch(() => undefined);
			await client.end();

			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({ severity: "ERROR", code: "42P01" });
		});
	});

	it("pool.query 借出的连接（单条语句）被结束：这条语句以错误结束，不是 onInUseError，连接池照常可用", async () => {
		const db = open(true);
		const slow = db.pool.query("select pg_sleep(5)");
		const outcome = slow.then(
			() => "ok",
			() => "failed",
		);
		expect(await terminateActive(database.url, "pg_sleep")).toBe(1);

		expect(await outcome).toBe("failed");

		expect(fatal).toEqual([]);
		expect(await db.ping()).toBe(true);
		await db.close();
	}, 30_000);

	it("空闲的连接被结束：不是 onInUseError，记一条错误，连接池丢掉它、之后拿到新连接", async () => {
		const db = open(true);
		await db.ping();
		await sleep(200);

		expect(await terminateIdle(database.url)).toBeGreaterThanOrEqual(1);
		await sleep(300);

		expect(fatal).toEqual([]);
		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(await db.ping()).toBe(true);
		await db.close();
	}, 30_000);

	it("没有给 onInUseError（测试里的控制面）：借出去的连接被结束只记日志，连接池照常可用", async () => {
		const db = open(false);
		const client = await borrowInTransaction(db);
		const backend = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]
			?.pid;
		const admin = new pg.Client({ connectionString: database.url });
		await admin.connect();
		await admin.query("select pg_terminate_backend($1)", [backend]);
		await admin.end();
		await sleep(300);

		expect(errors.length).toBeGreaterThanOrEqual(1);
		expect(fatal).toEqual([]);
		client.release(new Error("连接已经断了"));
		expect(await db.ping()).toBe(true);
		await db.close();
	}, 30_000);

	it("关闭时连接池里有借出去没还的连接：close() 在时限内返回，并记一条错误说明没关完", async () => {
		const db = open(true);
		await db.ping();
		await db.pool.connect(); // 借出去，永远不还（drizzle 在 begin 失败时就是这样）

		const started = Date.now();
		await db.close();
		const took = Date.now() - started;

		expect(took).toBeGreaterThanOrEqual(POOL_END_TIMEOUT_MS - 200);
		expect(took).toBeLessThan(POOL_END_TIMEOUT_MS + 2_000);
		expect(errors.map((e) => e.message).join("\n")).toContain("没有关完");
		// 给了 onCloseTimeout 时这条说明走它（日志里是自己的前缀，不是连接出错的前缀）：控制面给的就是它，见 db-connection-errors.test.ts。
		// 再关一次不抛（收到两次停止信号、或者有序退出和停止信号撞上）。
		await expect(db.close()).resolves.toBeUndefined();
	}, 30_000);

	it("正常关闭（没有借出未还的）：很快返回，不记错误", async () => {
		const db = open(true);
		await db.ping();

		const started = Date.now();
		await db.close();

		expect(Date.now() - started).toBeLessThan(1_000);
		expect(errors).toEqual([]);
	}, 30_000);
});
