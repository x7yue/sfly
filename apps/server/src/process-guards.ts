import { SHUTDOWN_TIMEOUT_MS } from "./shutdown.js";
import { printError } from "./util/output.js";

/**
 * 进程要不要退出、怎么退出（#563，docs/ARCHITECTURE.md §6.10）：进程级的未捕获异常（`uncaughtException`）、未处理的拒绝
 * （`unhandledRejection`），和借出去的数据库连接出错（`main.ts` 经 {@link ProcessGuards.fatal} 交进来）。
 *
 * 策略：**记一条带上下文的错误日志，有序关闭，以退出码 1 退出，由部署的重启策略（`restart: unless-stopped`）拉起来。**
 * 不继续运行：走到这里的都是进程里的状态已经不可信的情况（没人预料到的缺陷；借出去的数据库连接断了，事务进行到一半，
 * 任务结果没写进去、提交之后的派发没人补），带着它继续跑，比重启危险；重启很便宜——运行的状态都在数据库里，控制面启动时由
 * 引擎的恢复逻辑接手，Agent 自己重连、重发手上的结果。也不吞掉：一个什么都不做的处理会把真正的缺陷盖住，而这类缺陷要看到才能修。
 *
 * 空闲的数据库连接出错不走这里：连接池丢掉它、下一次拿到新连接，不影响任何操作（`db/database.ts`）。
 *
 * 有序关闭 = `shutdown`（停止接收新的请求、等进行中的写入、关连接）；最多等 `timeoutMs`，到时间不管它结没结束都退出，
 * 免得关闭本身卡住、进程既不工作也不退出。关闭过程中又来的错误只记日志，不再开始第二次关闭。
 *
 * **和停止信号的关系**（`src/shutdown.ts`，SIGINT、SIGTERM）：因错误而有序退出和停止信号的关闭是两条都会调用 `close()`、都会退出的路径
 * （`close()` 可以重复调用，拿到同一个结果）。**只要有一条走过「因为错误在退出」，退出码就是 1**，不管哪条先完成、谁先到：
 * - 致命错误先到、之后来了停止信号：停止信号那条的 `close()` 会先于这里的收尾完成，要是它以 0 退出，按失败才重启的部署
 *   （`restart: on-failure`）就不会把这个状态不可信的进程拉起来；所以它退出时看 {@link ProcessGuards.exiting}，是真就用 1。
 * - 停止信号先到、关闭途中又出致命错误：也是 1。这次退出本来是有意的停止，但关闭途中借出去的事务断了，没写完的东西没有人补，
 *   退出码 1 如实说明这次退出不干净；明确停止的部署（`docker stop`、`systemctl stop`）不看退出码，不会因此被拉起来。
 *
 * **处理函数自己不能挡住退出**：计时器先于一切起来；记日志、调关闭都包了一层，它们抛的异常（例如拒绝的原因是一个读
 * `message` 就抛的 `Error`）只记一行，退出照旧。Node 里 `uncaughtException` 的处理函数自己抛异常，进程以退出码 7 退出、
 * 不经过有序关闭；`unhandledRejection` 的处理函数自己抛，会变成又一个未捕获的异常，处理函数看到「正在退出」只记一行就返回，
 * 进程一直活着。
 */
export interface ProcessGuardsOptions {
	/** 有序关闭控制面。 */
	shutdown: () => Promise<void>;
	/** 关闭最多等多久（毫秒），默认 10 秒。 */
	timeoutMs?: number;
	/** 进程对象和退出函数：测试里换成假的。 */
	proc?: Pick<NodeJS.Process, "on" | "off">;
	exit?: (code: number) => void;
}

export interface ProcessGuards {
	/**
	 * 要退出了：`what` 是原因（写进日志的第一句），`error` 是引起它的错误。
	 * 第一次调用开始有序关闭；已经在退出了，只记一行日志。
	 */
	fatal(what: string, error?: unknown): void;
	/**
	 * 是不是已经因为错误在退出了（{@link ProcessGuards.fatal} 被调用过、或者来了一个未捕获的异常 / 未处理的拒绝）。
	 * 停止信号的关闭（`src/shutdown.ts`）和这里的有序退出是两条都会调用 `close()`、都会退出的路径：已经因为错误在退出时，
	 * 停止信号那一条的退出码也要是 1（`main.ts` 的 `exit` 看它），不能让它先完成、以 0 退出。
	 */
	readonly exiting: boolean;
	/** 卸掉进程级的处理（测试用）。 */
	uninstall(): void;
}

/** 有序关闭最多等多久：和停止信号触发的关闭的上限（`src/shutdown.ts`）是同一个数。 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = SHUTDOWN_TIMEOUT_MS;

/** 不是 `Error` 的值（拒绝的原因、被 throw 的东西）只记类型：它可能是任何东西（带着令牌、参数的对象），不原样进日志。 */
const typeOf = (value: unknown): string =>
	value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const describeThrown = (value: unknown): unknown =>
	value instanceof Error ? value : `（不是 Error，类型 ${typeOf(value)}，内容没有记录）`;

/** 装上处理；返回 {@link ProcessGuards}。 */
export function installProcessGuards(options: ProcessGuardsOptions): ProcessGuards {
	const proc = options.proc ?? process;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	let exiting = false;
	let exited = false;

	let timer: NodeJS.Timeout | undefined;
	/** 退出码 1，只退出一次。 */
	const exitOnce = (): void => {
		if (timer) clearTimeout(timer);
		if (exited) return;
		exited = true;
		exit(1);
	};

	/** 往终端写东西只走 `util/output.ts` 的 `printError`（它先去掉数据库的参数：错误带着语句的参数，原样打印会把密码的哈希、令牌的哈希、飞书 Webhook 的地址、secret 参数的默认值带进日志）。 */
	const print = (what: string, error: unknown): void => {
		printError(what, error === undefined ? undefined : describeThrown(error));
	};
	/**
	 * 记日志本身出错（`safeError` 读错误的属性时抛了）时退一步只记一行（不带这个错误），再出错就什么都不做：
	 * 不让记日志的异常传出去、挡住退出。
	 */
	const logFatal = (what: string, error?: unknown): void => {
		try {
			print(what, error);
		} catch {
			try {
				print(`${what}（这个错误的内容记不出来：读它时又抛了异常）`, undefined);
			} catch {
				// 连这一行都写不出来（标准错误关了）：继续退出。
			}
		}
	};

	const handle = (what: string, error?: unknown): void => {
		if (exiting) {
			logFatal(`sfly: 正在退出时又出了一个错误（${what}）：`, error);
			return;
		}
		exiting = true;
		// 计时器先起来：之后不管哪一步卡住，到时间都退出。下面每一步都不会把异常传出来：`logFatal` 自己兜住，
		// `Promise.resolve().then` 把 `shutdown` 同步抛的异常也变成拒绝，交给 `catch`。
		timer = setTimeout(() => {
			logFatal(`sfly: 有序关闭 ${timeoutMs} 毫秒还没有结束，直接退出`);
			exitOnce();
		}, timeoutMs);
		logFatal(`sfly: ${what}，有序关闭后以退出码 1 退出，由部署的重启策略拉起来：`, error);
		void Promise.resolve()
			.then(() => options.shutdown())
			.catch((shutdownError: unknown) => logFatal("sfly: 有序关闭时出错：", shutdownError))
			.finally(exitOnce);
	};

	const onException = (error: unknown) => handle("未捕获的异常", error);
	const onRejection = (reason: unknown) => handle("未处理的 Promise 拒绝", reason);
	proc.on("uncaughtException", onException);
	proc.on("unhandledRejection", onRejection);
	return {
		fatal: handle,
		get exiting() {
			return exiting;
		},
		uninstall: () => {
			proc.off("uncaughtException", onException);
			proc.off("unhandledRejection", onRejection);
		},
	};
}
