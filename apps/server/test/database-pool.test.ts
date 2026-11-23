// 数据库连接池里连接出错怎么处理（#563，docs/ARCHITECTURE.md §6.9），用真实的 PostgreSQL，不起控制面进程。
//
// 连接断了（数据库重启、`pg_terminate_backend`），pg 在这个连接上触发 `error` 事件。谁接着它，决定它是什么错误：
// - 空闲的连接：连接池自己接着（丢掉这个连接）；
// - `pool.query` 借出的连接（一条语句）：它自己接着（这条语句以错误结束）；
// - 借出去在事务里的连接（连接池和 drizzle 都没有挂处理）：没人接。以前这是未捕获的异常，进程在这一刻退出；
//   现在是 `onInUseError`，并且连接池在同一个调用栈里就结束了，之后那次操作的失败处理拿不到连接。
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, POOL_END_TIMEOUT_MS } from "../src/db/database.js";
import { orchestrations } from "../src/db/schema.js";
import { terminateActive, terminateIdle } from "./support/db-sabotage.js";
import { PgProxy } from "./support/pg-proxy.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		// 连接池已经结束：之后任何取连接、执行语句的请求立刻以错误结束，不再碰数据库。
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
