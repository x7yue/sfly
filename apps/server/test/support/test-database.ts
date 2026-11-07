import { randomBytes } from "node:crypto";
import pg from "pg";

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

/** 创建一个随机命名的空数据库；每个测试文件/控制面实例独占一个，互不干扰。`prefix` 便于区分来源（性能测试用 sfly_perf）。 */
export async function createTestDatabase(prefix = "sfly_test"): Promise<TestDatabase> {
	const name = `${prefix}_${randomBytes(6).toString("hex")}`;
	await withAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
	const url = new URL(ADMIN_DATABASE_URL);
	url.pathname = `/${name}`;
	return {
		name,
		url: url.toString(),
		drop: () =>
			withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => {}),
	};
}
