import { secretLimits } from "../../src/logs/secrets.js";

/**
 * 在 `run` 期间把读取预算、自动机大小的上限调成 `limits`（只给测试用，`secretLimits` 是可以改的对象），结束后（不论成败）还原。
 * 控制面和测试在同一个进程里，所以真实的读取出口也看得到：用几十 KB 的文字就能让一次读取用完预算。
 */
export async function withSecretLimits<T>(
	limits: Partial<typeof secretLimits>,
	run: () => Promise<T> | T,
): Promise<T> {
	const saved = { ...secretLimits };
	Object.assign(secretLimits, limits);
	try {
		return await run();
	} finally {
		Object.assign(secretLimits, saved);
	}
}
