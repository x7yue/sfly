import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
/** 一个事务（`db.transaction` 回调收到的对象）：和 {@link Db} 一样可以查询，也可以开保存点。 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Database {
	readonly db: Db;
	readonly pool: pg.Pool;
	/** 执行 drizzle/ 下尚未应用的迁移。 */
	migrate(): Promise<void>;
	/** 数据库能否响应查询。 */
	ping(): Promise<boolean>;
	close(): Promise<void>;
}

/** 源码中的迁移目录；打包后的控制面由调用方指定（SFLY_MIGRATIONS_DIR）。 */
export const defaultMigrationsDir = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function openDatabase(
	url: string,
	onError: (error: Error) => void,
	migrationsFolder: string = defaultMigrationsDir,
): Database {
	const pool = new pg.Pool({ connectionString: url, max: 10 });
	// 连接断了（数据库重启、被 `pg_terminate_backend` 结束、网络中断），pg 在这个连接上触发 `error` 事件；没人接的 `error` 事件
	// 是未捕获的异常，进程会退出（#563）。连接池只在**空闲**的连接上挂了处理：借出去的连接（事务里、一条语句执行中）上没有，
	// 所以在每个连接建好的时候就自己挂一个，空闲和借出的都有人接。出错的那次操作自己的 promise 会以错误结束，走已有的错误处理
	// （请求返回 5xx、引擎按「数据库出错」处理）；断了的连接 pg-pool 在归还时丢弃，之后取到的是新连接。
	pool.on("connect", (client) => {
		client.on("error", onError);
	});
	// 空闲连接出错时连接池还会在它自己身上再触发一次 `error`：上面的处理已经记过了，这里只是不让它成为没人接的事件。
	pool.on("error", () => {});
	const db = drizzle(pool, { schema });
	return {
		db,
		pool,
		migrate: () => migrate(db, { migrationsFolder }),
		async ping() {
			try {
				await pool.query("select 1");
				return true;
			} catch {
				return false;
			}
		},
		close: () => pool.end(),
	};
}
