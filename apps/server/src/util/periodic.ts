/**
 * 周期扫描：每隔 intervalMs 调一次 task；上一次还没结束时跳过本次（不会叠加执行）。
 * 定时器不阻止进程退出；`stop()` 停止定时器并等正在进行的那一次结束。
 */
export function periodic(
	intervalMs: number,
	task: () => unknown,
	onError: (error: unknown) => void,
): { stop(): Promise<void> } {
	let running: Promise<void> | undefined;
	const timer = setInterval(() => {
		if (running) return;
		running = (async () => {
			try {
				await task();
			} catch (error) {
				onError(error);
			} finally {
				running = undefined;
			}
		})();
	}, intervalMs);
	timer.unref();
	return {
		async stop() {
			clearInterval(timer);
			await running;
		},
	};
}
