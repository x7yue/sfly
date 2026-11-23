/** 反复执行断言直到通过或超时（用于等待异步传播的状态，例如连接关闭）。 */
export async function eventually(
	check: () => Promise<void> | void,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await check();
			return;
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((r) => setTimeout(r, 20));
		}
	}
}
