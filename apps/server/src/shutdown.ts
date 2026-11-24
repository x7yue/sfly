/** 关闭开始之后最多等多久（毫秒）：到时还没关完，记一句、以退出码 1 退出（和有序退出的上限同一个数）。 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * 收到停止信号时关闭控制面：**关闭只做一次**，重复的信号（Ctrl-C 按了两下、SIGINT 之后又来 SIGTERM）只记一句、不再去关；
 * 关闭完成退出码是 0，关闭出错记下来、退出码是 1，不留没人接的拒绝（#647）。监听用 `on` 不用 `once`：`once` 让第二个信号走默认的处理
 * （直接结束进程），关到一半就被打断。
 *
 * **关闭有上限**（{@link SHUTDOWN_TIMEOUT_MS}，10 秒）：关闭卡住时（比如有一个开着但不读的大下载，`api.close()` 一直等它），没有这个上限的话
 * 重复的信号只记一句，终端里只剩 `kill -9`。从关闭开始算，到时记一句、以退出码 1 退出（不是正常关闭，按失败才重启的部署要把它拉起来）；
 * 期间重复的信号照旧只记一句，不打断正在做的正常关闭。
 *
 * 和进程解耦（`emitter`、`exit`、日志都是参数），测试里用假的；`main.ts` 传 `process`。
 */
export function installShutdown(options: {
	emitter: { on(signal: NodeJS.Signals, listener: () => void): unknown };
	signals: readonly NodeJS.Signals[];
	/** 关闭控制面：可以被调用多次的话也只会被调用一次。 */
	close: () => Promise<void>;
	exit: (code: number) => void;
	log: (message: string) => void;
	/** 关闭出错、关闭超时时记下（`error` 在超时时没有）；`main.ts` 传的 `printError` 自己过 `safeError`（`test/error-log.test.ts` 守着这条）。 */
	logError: (message: string, error?: unknown) => void;
	/** 关闭最多等多久（毫秒），默认 {@link SHUTDOWN_TIMEOUT_MS}。 */
	timeoutMs?: number;
}): void {
	const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
	let shuttingDown = false;
	for (const signal of options.signals) {
		options.emitter.on(signal, () => {
			if (shuttingDown) {
				options.log(`sfly: 已经在关闭，忽略 ${signal}`);
				return;
			}
			shuttingDown = true;
			options.log(`sfly: 收到 ${signal}，正在关闭`);
			// 退出只调用一次：到时退出之后关闭才完成（或者出错）的，不再调用。
			let exited = false;
			const exit = (code: number) => {
				if (exited) return;
				exited = true;
				clearTimeout(timer);
				options.exit(code);
			};
			const timer = setTimeout(() => {
				options.logError(
					`sfly: 关闭 ${Math.round(timeoutMs / 1000)} 秒还没有完成，不再等，以退出码 1 退出`,
				);
				exit(1);
			}, timeoutMs);
			options.close().then(
				() => exit(0),
				(error: unknown) => {
					if (exited) return;
					options.logError("sfly: 关闭时出错", error);
					exit(1);
				},
			);
		});
	}
}
