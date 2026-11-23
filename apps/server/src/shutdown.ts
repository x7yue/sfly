/**
 * 收到停止信号时关闭控制面：**关闭只做一次**，重复的信号（Ctrl-C 按了两下、SIGINT 之后又来 SIGTERM）只记一句、不再去关；
 * 关闭完成退出码是 0，关闭出错记下来、退出码是 1，不留没人接的拒绝（#647）。监听用 `on` 不用 `once`：`once` 让第二个信号走默认的处理
 * （直接结束进程），关到一半就被打断。
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
	/** 关闭出错时记下；错误原文过 `safeError`（`test/error-log.test.ts` 守着这条），由调用方处理。 */
	logError: (message: string, error: unknown) => void;
}): void {
	let shuttingDown = false;
	for (const signal of options.signals) {
		options.emitter.on(signal, () => {
			if (shuttingDown) {
				options.log(`sfly: 已经在关闭，忽略 ${signal}`);
				return;
			}
			shuttingDown = true;
			options.log(`sfly: 收到 ${signal}，正在关闭`);
			options.close().then(
				() => options.exit(0),
				(error: unknown) => {
					options.logError("sfly: 关闭时出错", error);
					options.exit(1);
				},
			);
		});
	}
}
