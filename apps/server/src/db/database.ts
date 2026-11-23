import type { EventEmitter } from "node:events";
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
	 * 理由（#563，docs/ARCHITECTURE.md §6.10）。不给：只记日志（测试里的控制面是这样，进程不由控制面管）。
	 * 调用之前连接池已经结束（`pool.end()`）：之后**新的**拿连接、执行语句的请求立刻以错误结束，不再碰数据库
	 * （已经在排队等连接的请求、已经借出连接正在执行的请求不受影响：见 `docs/ARCHITECTURE.md` §6.10）。
	 */
	onInUseError?: (error: Error) => void;
	/**
	 * 连接池在 {@link POOL_END_TIMEOUT_MS} 内没有关完（有借出去没还的连接）时调用：不是又断了一条连接，不要和连接出错记成一样
	 * （日志的前缀不同）。不给：和连接出错一样交给 `onError`。
	 */
	onCloseTimeout?: (error: Error) => void;
}

/** pg 的连接对象收到数据库的错误消息时触发的 `errorMessage` 事件带的对象（`pg-protocol` 的 `DatabaseError`）：这里用到的字段。 */
interface PgErrorMessage {
	severity?: string;
	code?: string;
	message?: string;
}

/**
 * 数据库发来的这条错误消息之后它会关掉这条连接：`FATAL`、`PANIC`；`severity` 是数据库按它的语言设置发来的（`lc_messages`，可能被
 * 翻译），所以再看 SQLSTATE：`57P01`（管理员命令结束连接、数据库正在关闭）、`57P02`（崩溃关闭）、`57P03`（现在不能连接）、
 * `57P04`（库被删了）、`57P05`（空闲会话超时）。
 */
const CONNECTION_ENDING_CODES: ReadonlySet<string> = new Set([
	"57P01",
	"57P02",
	"57P03",
	"57P04",
	"57P05",
]);
const endsConnection = (message: PgErrorMessage): boolean =>
	message.severity === "FATAL" ||
	message.severity === "PANIC" ||
	(message.code !== undefined && CONNECTION_ENDING_CODES.has(message.code));

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
	// 「这条借出去的连接完了」有两个信号，都按上面的办法处理（只交给 `onInUseError` 一次，之后的只记日志）：
	// 1. 连接的 `error` 事件：连接被掐断（网络中断、数据库进程被杀）时，pg 先让这次操作的 promise 以错误结束、再同步触发 `error`；
	//    promise 的后续处理要等当前调用栈走完，所以连接池一定先结束。
	// 2. 数据库发来的**致命错误消息**（`FATAL`、`PANIC`：`pg_terminate_backend`、数据库正常关闭、连接数用完……）：数据库先发这条消息、
	//    再关连接。这时 pg 的行为是：连接上有正在执行的语句，只让这条语句以错误结束、**不发 `error`**，`error` 要等连接真的关闭才来；
	//    没有正在执行的语句才立刻发 `error`。ORM 把 `begin` 放在 `try` 外面，`begin` 收到这条消息时事务立刻拒绝，引擎的失败处理
	//    于是先跑、从池里借到另一条好的连接开始写（把 Agent 报来的成功记成节点出错，配了重试的还会再执行一遍）；连接池要等连接
	//    关闭的 `error` 才结束，那时已经晚了：它只挡新的借出，有序关闭又正好等这个已经借出的事务提交完。所以这条消息一到就当作
	//    连接完了（`onFatalMessage`），不等连接关闭。
	//    **这依赖 pg 的内部**（`pg` 8.23.1 / `pg-protocol` 1.16.1，`test/database-pool.test.ts` 守着）：连接对象 `client.connection` 在
	//    收到错误消息时触发 `errorMessage`、带着 `severity`（`pg-protocol` 取的是数据库发来的、可能被本地化的那个字段）和 `code`
	//    （SQLSTATE）；pg 自己的 `errorMessage` 处理先注册、先运行（它让语句以错误结束），我们的在它之后、同一个 emit 里。升级之后
	//    钩子不再触发，这几条测试会红；`client.connection` 没有了就在启动时报错（不悄悄少一道防线）。
	let reportedInUse = false;
	/** 这条借出去的连接完了：只交给 `onInUseError` 一次，先结束连接池。 */
	const reportInUse = (client: pg.PoolClient, error: Error): boolean => {
		if (
			options.onInUseError === undefined ||
			client.listenerCount("error") !== 1 ||
			reportedInUse
		) {
			return false;
		}
		reportedInUse = true;
		void endPool();
		options.onInUseError(error);
		return true;
	};
	pool.on("connect", (client) => {
		client.on("error", (error) => {
			if (!reportInUse(client, error)) onError(error);
		});
		// 不用 `onInUseError`（测试里的控制面）时不需要这个钩子。
		if (options.onInUseError === undefined) return;
		const connection = (client as unknown as { connection?: EventEmitter }).connection;
		if (typeof connection?.on !== "function") {
			throw new Error(
				"pg 的连接对象没有 connection 事件源：借出去的连接收到数据库的致命错误消息时没法比连接关闭更早地认出来（升级 pg 之后需要重新核对 db/database.ts 的 errorMessage 钩子）",
			);
		}
		connection.on("errorMessage", (message: PgErrorMessage) => {
			if (endsConnection(message)) reportInUse(client, message as unknown as Error);
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
				(options.onCloseTimeout ?? onError)(
					new Error(
						`连接池 ${POOL_END_TIMEOUT_MS} 毫秒内没有关完：还有 ${pool.totalCount - pool.idleCount} 个借出去没有还的连接，不再等它们`,
					),
				);
			}
		},
	};
}
