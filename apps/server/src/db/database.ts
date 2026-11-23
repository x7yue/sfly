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

/** 连接池关闭最多等多久：借出去没还的连接（连接断了又没人还回来的）会让 `pool.end()` 永远不结束，有序关闭不能卡在这里。 */
export const POOL_END_TIMEOUT_MS = 3_000;

export interface OpenDatabaseOptions {
	/**
	 * **借出去的连接**（事务里，连接池在借出时没有给它挂任何处理）出错时调用：给了它，这个连接上的错误就当作进程要有序退出的
	 * 理由（#563，docs/ARCHITECTURE.md §6.9）。不给：只记日志（测试里的控制面是这样，进程不由控制面管）。
	 * 调用之前连接池已经结束（`pool.end()`）：之后任何拿连接、执行语句的请求立刻以错误结束，不再碰数据库。
	 */
	onInUseError?: (error: Error) => void;
}

export function openDatabase(
	url: string,
	onError: (error: Error) => void,
	migrationsFolder: string = defaultMigrationsDir,
	options: OpenDatabaseOptions = {},
): Database {
	const pool = new pg.Pool({ connectionString: url, max: 10 });
	let ended: Promise<void> | undefined;
	/** 结束连接池（只结束一次：第二次调用 `pool.end()` 会拒绝）；结束之后拿连接、执行语句都立刻失败。 */
	const endPool = (): Promise<void> => {
		ended ??= pool.end().catch((error: Error) => onError(error));
		return ended;
	};
	// 连接断了（数据库重启、被 `pg_terminate_backend` 结束、网络中断），pg 在这个连接上触发 `error` 事件。没人接的 `error` 事件是
	// 未捕获的异常，进程会以退出码 1 退出，在这个事件发出的那一刻、同一个调用栈里：这次操作自己的 promise 的拒绝要之后才处理。
	// 谁接着这个事件，决定它是什么错误：
	// - 空闲的连接：连接池自己挂了处理（把连接丢掉）；`pool.query` 借出的连接：它自己挂了处理（这条语句以错误结束）。
	//   这两种都有别人接，预料之中，只记日志，请求以错误结束、连接丢掉，进程不退出。
	// - 只有我们这一个处理在听：借出去的连接（事务里）。以前它就是没人接的 `error` 事件，进程在这一刻退出。这样的连接可能
	//   是事务进行到一半，也可能是 `begin` 就断了（drizzle 在 `begin` 之后才进入会还连接的那一段，`begin` 失败时借出去的连接
	//   永远不还），之后的状态不可信（任务结果没写进去、提交之后的派发没人补）：靠重启恢复，所以有序退出（`onInUseError`），
	//   并且**同一个调用栈里就先结束连接池**，之后那次操作的失败处理（引擎把结果记成节点出错、写运行状态……）拿不到连接，
	//   什么都写不进去：和以前进程在这一刻退出一样，不会把 Agent 报来的成功记成失败。
	//   顺序：连接是被掐断的（网络中断、数据库进程被杀）时，pg 先让这次操作的 promise 以错误结束、再同步触发 `error`；
	//   promise 的后续处理要等当前调用栈走完，所以连接池一定先结束。数据库先发来一条 FATAL 错误消息再关连接
	//   （`pg_terminate_backend`、数据库正常关闭）时，这次操作先以错误结束，`error` 在连接真的关闭时才来：那一小段里失败处理
	//   能从池里拿到别的空闲连接、把结果记成节点出错。以前进程也是在 `error` 的那一刻才退出，这一小段竞争同样存在。
	// 同一个断开可能触发不止一次 `error`（数据库先发来的错误消息、之后连接关闭）：只交给 `onInUseError` 一次，之后的只记日志。
	let reportedInUse = false;
	pool.on("connect", (client) => {
		client.on("error", (error) => {
			if (
				options.onInUseError !== undefined &&
				client.listenerCount("error") === 1 &&
				!reportedInUse
			) {
				reportedInUse = true;
				void endPool();
				options.onInUseError(error);
				return;
			}
			onError(error);
		});
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
		async close() {
			let timer: NodeJS.Timeout | undefined;
			const outcome = await Promise.race([
				endPool().then(() => "ended" as const),
				new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), POOL_END_TIMEOUT_MS);
				}),
			]);
			if (timer) clearTimeout(timer);
			if (outcome === "timeout") {
				onError(
					new Error(
						`连接池 ${POOL_END_TIMEOUT_MS} 毫秒内没有关完：还有 ${pool.totalCount - pool.idleCount} 个借出去没有还的连接，不再等它们`,
					),
				);
			}
		},
	};
}
