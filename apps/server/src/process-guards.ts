import { safeError } from "./util/safe-error.js";

/**
 * 进程级的未捕获异常（`uncaughtException`）和未处理的拒绝（`unhandledRejection`）怎么处理（#563，docs/ARCHITECTURE.md §6.9）。
 *
 * 策略：**记一条带上下文的错误日志，有序关闭，以退出码 1 退出，由部署的重启策略（`restart: unless-stopped`）拉起来。**
 * 不继续运行：走到这里的都是没人预料到的缺陷，进程里的状态（一半做完的内存里的东西、没释放的锁）已经不可信，带着它继续跑，
 * 比重启危险；重启很便宜——运行的状态都在数据库里，控制面启动时由引擎的恢复逻辑接手，Agent 自己重连、继续手上的任务。
 * 也不吞掉：一个什么都不做的处理会把真正的缺陷盖住，而这类缺陷要看到才能修。
 *
 * 数据库连接断了不走这里：那是预料之中的运行故障（数据库重启、网络中断），在出错的地方处理（连接上的 `error` 事件在
 * `db/database.ts` 里有人接，这次操作以错误结束、走已有的错误处理），进程不退出。
 *
 * 有序关闭 = `shutdown`（停止接收新的请求、等进行中的写入、关连接）；最多等 `timeoutMs`，到时间不管它结没结束都退出，
 * 免得关闭本身卡住、进程既不工作也不退出。关闭过程中又来的错误只记日志，不再开始第二次关闭。
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

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** 装上处理；返回卸掉它的函数（测试用）。 */
export function installProcessGuards(options: ProcessGuardsOptions): () => void {
	const proc = options.proc ?? process;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	let exiting = false;

	/** 错误日志都过 safeError（test/error-log.test.ts 守着）：数据库错误带着语句的参数，原样打印会把保密的值带进日志。 */
	const logFatal = (what: string, error?: unknown): void => {
		console.error(what, ...(error === undefined ? [] : [safeError(error)]));
	};

	const handle = (what: string, error: unknown): void => {
		if (exiting) {
			logFatal(`sfly: 正在退出时又出了一个错误（${what}）：`, error);
			return;
		}
		exiting = true;
		logFatal(`sfly: ${what}，有序关闭后以退出码 1 退出，由部署的重启策略拉起来：`, error);
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		void Promise.race([
			options.shutdown().then(
				() => "closed" as const,
				(shutdownError: unknown) => {
					logFatal("sfly: 有序关闭时出错：", shutdownError);
					return "failed" as const;
				},
			),
			timedOut,
		]).then((outcome) => {
			if (timer) clearTimeout(timer);
			if (outcome === "timeout") {
				logFatal(`sfly: 有序关闭 ${timeoutMs} 毫秒还没有结束，直接退出`);
			}
			exit(1);
		});
	};

	const onException = (error: unknown) => handle("未捕获的异常", error);
	const onRejection = (reason: unknown) => handle("未处理的 Promise 拒绝", reason);
	proc.on("uncaughtException", onException);
	proc.on("unhandledRejection", onRejection);
	return () => {
		proc.off("uncaughtException", onException);
		proc.off("unhandledRejection", onRejection);
	};
}
