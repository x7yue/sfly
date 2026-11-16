import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "../../src/db/database.js";
import * as schema from "../../src/db/schema.js";

/**
 * 只有一个连接的数据库：事务占着这个连接时，事务之外再取连接等 1 秒就报错。`mostPending` 是这个连接上同时在等结果的查询
 * 数的最大值，事务里的查询一条接一条地执行时不会超过 1（同一个连接上并发查询 pg 会排队并打弃用警告，pg@9 不再支持）。
 */
export interface SingleConnection {
	db: Db;
	mostPending(): number;
	end(): Promise<void>;
}

export function singleConnection(url: string): SingleConnection {
	const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
	let pending = 0;
	let most = 0;
	pool.on("connect", (client) => {
		const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown> | undefined;
		client.query = ((...args: unknown[]) => {
			pending += 1;
			most = Math.max(most, pending);
			const done = () => {
				pending -= 1;
			};
			// 连接池的 `pool.query` 用回调的写法调用，不返回 Promise。
			const callback = args.at(-1);
			if (typeof callback === "function") {
				args[args.length - 1] = (...result: unknown[]) => {
					done();
					return callback(...result);
				};
				return query(...args);
			}
			return query(...args)?.finally(done);
		}) as typeof client.query;
	});
	return {
		db: drizzle(pool, { schema }),
		mostPending: () => most,
		end: () => pool.end(),
	};
}
