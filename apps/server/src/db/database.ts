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
	// 空闲连接被服务器断开时 pool 会触发 error；不处理会让进程崩溃。
	pool.on("error", onError);
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
