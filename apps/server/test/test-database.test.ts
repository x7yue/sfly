// 测试库从已迁移的模板库复制（#613）：e2e 里每个用例都要一个测试库，迁移只在整个运行开始前跑一次。
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestControlPlane } from "./support/test-control-plane.js";
import {
	ADMIN_DATABASE_URL,
	createdFromTemplate,
	createMigratedTemplate,
	createTestDatabase,
	type TestDatabase,
} from "./support/test-database.js";

const journal = JSON.parse(
	readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: unknown[] };

async function query<T extends pg.QueryResultRow>(
	database: TestDatabase,
	sql: string,
): Promise<T[]> {
	const client = new pg.Client({ connectionString: database.url });
	await client.connect();
	try {
		return (await client.query<T>(sql)).rows;
	} finally {
		await client.end();
	}
}

const appliedMigrations = async (database: TestDatabase) =>
	(
		await query<{ n: number }>(
			database,
			"SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
		)
	)[0]?.n;

async function databaseExists(name: string): Promise<boolean> {
	const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
	await client.connect();
	try {
		const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
		return rowCount === 1;
	} finally {
		await client.end();
	}
}

describe("测试库的模板", () => {
	let template: TestDatabase;
	const created: TestDatabase[] = [];
	const copy = async () => {
		const database = await createTestDatabase("sfly_test", { template: template.name });
		created.push(database);
		return database;
	};

	beforeAll(async () => {
		template = await createMigratedTemplate("sfly_test_template");
	});
	afterAll(async () => {
		await Promise.all(created.map((d) => d.drop()));
		await template.drop();
	});

	it("模板里每个迁移都已经应用；刚建好就能复制（模板上不留连接）", async () => {
		expect(journal.entries.length).toBeGreaterThan(0);
		expect(await appliedMigrations(template)).toBe(journal.entries.length);
	});

	it("复制出来的库已经迁移好：有表，迁移记录和模板一样多", async () => {
		const database = await copy();

		expect(await appliedMigrations(database)).toBe(journal.entries.length);
		const tables = await query<{ table_name: string }>(
			database,
			"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'runs'",
		);
		expect(tables).toHaveLength(1);
	});

	it("复制出来的库带「从模板复制来的」标记，直接建的空库没有", async () => {
		const database = await copy();
		const empty = await createTestDatabase("sfly_test");
		created.push(empty);

		expect(await createdFromTemplate(database)).toBe(true);
		expect(await createdFromTemplate(empty)).toBe(false);
	});

	it("复制出来的库互相独立，也不影响模板：一个库里写的东西别的库里看不到", async () => {
		const [first, second] = [await copy(), await copy()];

		await query(first, "CREATE TABLE only_in_first (x int)");

		const tableCount = async (database: TestDatabase) =>
			(
				await query<{ n: number }>(
					database,
					"SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'only_in_first'",
				)
			)[0]?.n;
		expect(await tableCount(first)).toBe(1);
		expect(await tableCount(second)).toBe(0);
		expect(await tableCount(template)).toBe(0);
	});

	it("同时从同一个模板复制很多个（Playwright 的几个 worker 同时开始用例）都成功", async () => {
		const databases = await Promise.all(Array.from({ length: 8 }, copy));

		expect(new Set(databases.map((d) => d.name)).size).toBe(8);
		for (const database of databases) {
			expect(await appliedMigrations(database)).toBe(journal.entries.length);
		}
	});

	it("删掉一个复制出来的库，模板和别的库不受影响", async () => {
		const [doomed, kept] = [await copy(), await copy()];

		await doomed.drop();

		expect(await databaseExists(doomed.name)).toBe(false);
		expect(await databaseExists(template.name)).toBe(true);
		expect(await appliedMigrations(kept)).toBe(journal.entries.length);
		// 还能接着从模板复制。
		expect(await appliedMigrations(await copy())).toBe(journal.entries.length);
	});

	it("模板名不是小写字母、数字、下划线时拒绝，不拼进 SQL", async () => {
		await expect(
			createTestDatabase("sfly_test", { template: 'x"; DROP DATABASE sfly; --' }),
		).rejects.toThrow(/模板库名/);
		await expect(createTestDatabase("sfly_test", { template: "" })).rejects.toThrow(/模板库名/);
	});

	it("模板库不存在时报 PostgreSQL 的错，不悄悄建一个空库", async () => {
		await expect(
			createTestDatabase("sfly_test", { template: "sfly_no_such_template" }),
		).rejects.toThrow(/sfly_no_such_template/);
	});

	it("控制面在复制出来的库上启动、能服务请求，迁移记录没有变，库确实是从模板复制的", async () => {
		const cp = await startTestControlPlane({ template: template.name });
		try {
			expect((await cp.fetch("/health")).status).toBe(200);
			expect(await appliedMigrations(cp.database)).toBe(journal.entries.length);
			// 真的是从模板复制的，不是自己迁移出来的。
			expect(await createdFromTemplate(cp.database)).toBe(true);
		} finally {
			await cp.close();
		}
	});

	it("template 和 migrationsDir 不能一起给：模板已经按源码里的迁移目录迁移好了", async () => {
		await expect(
			startTestControlPlane({ template: template.name, migrationsDir: "/nonexistent" }),
		).rejects.toThrow(/template 和 migrationsDir/);
	});
});

describe("删库（#679）", () => {
	const connectClient = async (database: TestDatabase) => {
		const client = new pg.Client({ connectionString: database.url });
		const errors: Error[] = [];
		client.on("error", (error) => errors.push(error));
		await client.connect();
		return { client, errors };
	};

	// 连接池的 end() 不等连接真的断开，随后的 FORCE 删库会杀掉还没退出的后台进程，它们给还在关的连接发 57P01，连接池把它当 error
	// 事件抛出，池上没有监听时就是一个没人接的异常（CI 里偶发，#679）。这里用一个晚一点才断开的连接把这个窗口拉大。
	it("删库前先等库上的连接自己退出：晚一点才断开的连接没有被服务器终止，没有收到 57P01，库删掉了", async () => {
		const database = await createTestDatabase();
		const { client, errors } = await connectClient(database);
		const ended = new Promise<number>((resolve) => {
			setTimeout(() => {
				void client.end().then(() => resolve(Date.now()));
			}, 400);
		});
		const startedAt = Date.now();
		await database.drop();
		const droppedAt = Date.now();
		const endedAt = await ended;

		expect(errors.map((e) => e.message)).toEqual([]);
		// 是等它退出之后才删的，不是一开始就删。
		expect(droppedAt - startedAt).toBeGreaterThanOrEqual(300);
		expect(droppedAt).toBeGreaterThanOrEqual(endedAt);
		expect(await databaseExists(database.name)).toBe(false);
	});

	it("连接一直不退出（忘了关）：等到上限之后 FORCE 保底，库照样删掉", async () => {
		const database = await createTestDatabase("sfly_test", { dropWaitMs: 300 });
		const { client, errors } = await connectClient(database);

		const startedAt = Date.now();
		await database.drop();

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
		expect(await databaseExists(database.name)).toBe(false);
		// 被强行终止的连接收到 57P01（这里有监听，没有变成没人接的异常）。
		await vi.waitFor(() => expect(errors).toHaveLength(1));
		expect((errors[0] as Error & { code?: string }).code).toBe("57P01");
		await client.end().catch(() => {});
	});

	it("库上没有连接时不多等", async () => {
		const database = await createTestDatabase();
		const startedAt = Date.now();
		await database.drop();
		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(await databaseExists(database.name)).toBe(false);
	});
});
