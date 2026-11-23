import { randomBytes } from "node:crypto";
import pg from "pg";
import { openDatabase } from "../../src/db/database.js";

/** PostgreSQL 服务器的管理连接；测试库都建在这台服务器上。 */
export const ADMIN_DATABASE_URL =
	process.env.DATABASE_URL ?? "postgres://sfly:sfly@127.0.0.1:5432/sfly";

export interface TestDatabase {
	readonly name: string;
	readonly url: string;
	drop(): Promise<void>;
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

/** 模板库里标记「从模板复制来的」的 schema：不在 public 里，不会混进控制面自己的表。 */
const MARKER_SCHEMA = "sfly_test_support";

/**
 * 创建一个随机命名的数据库；每个测试文件/控制面实例独占一个，互不干扰。`prefix` 便于区分来源（性能测试用 sfly_perf）。
 * 默认是空库；给了 `template`（{@link createMigratedTemplate} 返回的库名）时从它复制：库里已经有迁移好的表，
 * 控制面启动时的迁移什么都不用做（几十个迁移文件一个个跑完，机器忙的时候要一两秒到几秒，是 e2e 里每个用例建立夹具的大头，#613）。
 */
export async function createTestDatabase(
	prefix = "sfly_test",
	options: { template?: string } = {},
): Promise<TestDatabase> {
	const name = `${prefix}_${randomBytes(6).toString("hex")}`;
	// 库名是这里拼的（小写字母、数字、下划线）；模板名来自调用方（e2e 经环境变量传来），拼进 SQL 之前先核对。
	const { template } = options;
	if (template !== undefined && !/^[a-z0-9_]+$/.test(template)) {
		throw new Error(`模板库名只能含小写字母、数字和下划线，实际是 ${JSON.stringify(template)}`);
	}
	const from = template === undefined ? "" : ` TEMPLATE "${template}"`;
	await withAdmin((c) => c.query(`CREATE DATABASE "${name}"${from}`));
	const url = new URL(ADMIN_DATABASE_URL);
	url.pathname = `/${name}`;
	return {
		name,
		url: url.toString(),
		drop: () =>
			withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => {}),
	};
}

/**
 * 建一个已经迁移到最新的库，给 {@link createTestDatabase} 的 `template` 选项复制；调用方在所有复制都做完之后 `drop()` 它。
 * 迁移用的是控制面自己的迁移（`openDatabase().migrate()`，源码里的迁移目录）。返回前等它上面的连接都断开：
 * `CREATE DATABASE … TEMPLATE` 要求模板上没有连接，而连接池关闭之后服务器上的进程还要一会儿才退出。
 * PostgreSQL 在 `CREATE DATABASE … TEMPLATE` 里自己也会等模板上别的会话，最多 5 秒（每 100 毫秒看一次），超过才报 55006
 * 「source database … is being accessed by other users」；平时关掉连接池之后连接立刻就没有了，下面这个循环是给机器忙的时候
 * 留的余量（把能容忍的时长从 5 秒拉到 10 秒再加 5 秒），没有测试能稳定地抓住它。
 */
export async function createMigratedTemplate(prefix = "sfly_template"): Promise<TestDatabase> {
	const database = await createTestDatabase(prefix);
	try {
		// 空闲连接的 error 事件只在迁移之后、关闭之前可能出现，此时没有谁在等它，忽略。
		const opened = openDatabase(database.url, () => {});
		try {
			await opened.migrate();
			// 标记「这个库是从模板复制来的」：用例和测试能据此确认没有绕过模板（见 createdFromTemplate）。
			await opened.pool.query(
				`CREATE SCHEMA ${MARKER_SCHEMA}; CREATE TABLE ${MARKER_SCHEMA}.from_template ()`,
			);
		} finally {
			await opened.close();
		}
		await withAdmin(async (c) => {
			for (let attempt = 0; attempt < 200; attempt++) {
				const { rows } = await c.query<{ n: number }>(
					"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
					[database.name],
				);
				if (rows[0]?.n === 0) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(`模板库 ${database.name} 上的连接 10 秒内没有断开`);
		});
	} catch (error) {
		await database.drop();
		throw error;
	}
	return database;
}

/** 这个库是不是从 {@link createMigratedTemplate} 建的模板复制来的（模板里有标记，空库和直接迁移出来的库没有）。 */
export async function createdFromTemplate(database: TestDatabase): Promise<boolean> {
	const client = new pg.Client({ connectionString: database.url });
	await client.connect();
	try {
		const { rowCount } = await client.query(
			"SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'from_template'",
			[MARKER_SCHEMA],
		);
		return rowCount === 1;
	} finally {
		await client.end();
	}
}
